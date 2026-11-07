// Credentials shipped to the browser: patterns, entropy and context checks, masking.
import type { Level } from "../headers";
import { decodeJwt } from "../utils/jwt";

export type SourceKind = "inline-script" | "json" | "script" | "comment" | "meta" | "attribute" | "global" | "storage" | "cookie";

/** A piece of text the page ships or keeps, with a label saying where it came from. */
export interface SecretSource {
  kind: SourceKind;
  label: string;
  url?: string;
  text: string;
}

export interface SecretLocation {
  source: string;
  kind: SourceKind;
  url?: string;
  line: number;
  column: number;
  /** The text around the match, with the value masked. */
  context: string;
}

export interface SecretFinding {
  key: string;
  rule: string;
  title: string;
  severity: Exclude<Level, "good">;
  why: string;
  heuristic: boolean;
  value: string;
  masked: string;
  detail?: string;
  locations: SecretLocation[];
}

interface Hit {
  title?: string;
  severity?: SecretFinding["severity"];
  why?: string;
  detail?: string;
  rule?: string;
  /** Replaces the matched value (a private key block, say). */
  value?: string;
}

interface MatchContext {
  text: string;
  /** Where the value starts in `text`. */
  index: number;
  match: RegExpMatchArray;
  source: SecretSource;
}

interface Rule {
  id: string;
  title: string;
  severity: SecretFinding["severity"];
  why: string;
  re: RegExp;
  /** Capture group holding the value (default 1). */
  group?: number;
  minEntropy?: number;
  heuristic?: boolean;
  mask?: (value: string) => string;
  /** Looks at the context: returns overrides, or null to drop the match. */
  refine?: (value: string, ctx: MatchContext) => Hit | null;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** First and last 4 characters, the rest hidden. */
export function mask(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}${"•".repeat(Math.max(1, value.length - 2))}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

const PLACEHOLDER =
  /(x{5,}|\*{4,}|0{10,}|EXAMPLE|your[_-]?(api|secret|key|token|password)|placeholder|redacted|changeme|<[^>]*>|\$\{|\{\{|%s)/i;

const near = (text: string, index: number, radius: number) => text.slice(Math.max(0, index - radius), index + radius);

const STORAGE_KINDS: SourceKind[] = ["storage", "cookie"];

const RULES: Rule[] = [
  {
    id: "private-key",
    title: "Private key",
    severity: "bad",
    why: "A private key block: whoever reads it can impersonate the server or sign as its owner.",
    re: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----/g,
    group: 0,
    mask: (v) => `${/-----BEGIN [A-Z ]+-----/.exec(v)?.[0] ?? "PRIVATE KEY"} (${v.length} chars)`,
    refine: (_v, { text, index }) => {
      // Libraries carry the bare header as a constant; a real key has a base64 body after it.
      const after = text.slice(index, index + 6000);
      if (!/^-----BEGIN [A-Z ]+-----(?:\s|\\[rn]|[A-Za-z-]+: [^\n]*)+[A-Za-z0-9+/]{40,}/.test(after)) return null;
      const end = /-----END [A-Z ]+-----/.exec(after);
      return { value: end ? after.slice(0, end.index + end[0].length) : after.slice(0, 200) };
    },
  },
  {
    id: "aws-secret-key",
    title: "AWS secret access key",
    severity: "bad",
    why: "With its access key ID, it signs any AWS API call the IAM user is allowed to make.",
    re: /(?:aws|secret)[\w.-]{0,24}["']?\s*[:=]\s*["'`]([A-Za-z0-9/+]{40})["'`]/gi,
    minEntropy: 4,
  },
  {
    id: "aws-access-key",
    title: "AWS access key ID",
    severity: "warn",
    why: "Harmless alone, but its secret key usually sits next to it.",
    re: /(?<![A-Za-z0-9])((?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Za-z0-9])/g,
    refine: (_v, { text, index }) => {
      const around = near(text, index, 400);
      const secret = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/.exec(around);
      return secret && entropy(secret[0]) > 4
        ? { severity: "bad", detail: "A 40-character secret-looking value sits next to it: likely the secret key." }
        : {};
    },
  },
  {
    id: "stripe-secret",
    title: "Stripe live secret key",
    severity: "bad",
    why: "Full API access to the Stripe account (charges, refunds, customers). It must stay on the server.",
    re: /(?<![\w])((?:sk|rk)_live_[0-9a-zA-Z]{20,247})(?![\w])/g,
    minEntropy: 3.5,
    refine: (v) =>
      v.startsWith("rk_") ? { title: "Stripe live restricted key", why: "A restricted key still grants the API scopes it was given." } : {},
  },
  {
    id: "stripe-test",
    title: "Stripe test secret key",
    severity: "warn",
    why: "Test mode only, but anyone can read and change the account's test data with it.",
    re: /(?<![\w])((?:sk|rk)_test_[0-9a-zA-Z]{20,247})(?![\w])/g,
    minEntropy: 3.5,
  },
  {
    id: "stripe-publishable",
    title: "Stripe publishable key",
    severity: "info",
    why: "Publishable by design: it can only create tokens, not read the account.",
    re: /(?<![\w])(pk_live_[0-9a-zA-Z]{20,247})(?![\w])/g,
  },
  {
    id: "github-token",
    title: "GitHub token",
    severity: "bad",
    why: "Acts as the user or app it belongs to: repositories, packages, settings.",
    re: /(?<![\w])((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})(?![\w])/g,
    minEntropy: 3.5,
  },
  {
    id: "slack-webhook",
    title: "Slack webhook",
    severity: "bad",
    why: "Anyone with the URL can post messages to the channel.",
    re: /(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/]{20,})/g,
    mask: (v) => `https://hooks.slack.com/…${v.slice(-4)}`,
  },
  {
    id: "slack-token",
    title: "Slack token",
    severity: "bad",
    why: "Reads and posts in the workspace as the bot or user it belongs to.",
    re: /(?<![\w-])(xox[abposr]-[A-Za-z0-9-]{10,250})(?![\w-])/g,
    minEntropy: 3,
  },
  {
    id: "anthropic-key",
    title: "Anthropic API key",
    severity: "bad",
    why: "Bills model usage to the account that owns it.",
    re: /(?<![\w-])(sk-ant-[A-Za-z0-9_-]{32,})(?![\w-])/g,
    minEntropy: 3.5,
  },
  {
    id: "openai-key",
    title: "OpenAI API key",
    severity: "bad",
    why: "Bills model usage to the organization and can read its files and fine-tunes.",
    re: /(?<![\w-])(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})(?![\w-])/g,
    minEntropy: 3.5,
  },
  {
    id: "openrouter-key",
    title: "OpenRouter API key",
    severity: "bad",
    why: "Bills model usage to the account that owns it.",
    re: /(?<![\w-])(sk-or-v1-[a-f0-9]{64})(?![\w-])/g,
  },
  {
    id: "sk-key",
    title: "Secret key (sk-…)",
    severity: "warn",
    why: "Looks like an OpenAI-style secret key; several AI providers use this prefix. Heuristic: check which service it belongs to.",
    re: /(?<![\w-])(sk-(?!ant-|proj-|svcacct-|admin-|or-)[A-Za-z0-9]{32,64})(?![\w-])/g,
    minEntropy: 4,
    heuristic: true,
  },
  {
    id: "sendgrid-key",
    title: "SendGrid API key",
    severity: "bad",
    why: "Sends email as your domain, which makes phishing look legitimate.",
    re: /(?<![\w.-])(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})(?![\w-])/g,
  },
  {
    id: "twilio-auth-token",
    title: "Twilio auth token",
    severity: "bad",
    why: "With the account SID, full access to the Twilio account (calls, SMS, billing).",
    re: /(?:twilio|auth)_?token["']?\s*[:=]\s*["'`]([0-9a-f]{32})["'`]/gi,
  },
  {
    id: "twilio-api-key",
    title: "Twilio API key SID",
    severity: "warn",
    why: "Half of a Twilio credential: its secret may be stored next to it.",
    re: /(?<![A-Za-z0-9])(SK[0-9a-f]{32})(?![A-Za-z0-9])/g,
  },
  {
    id: "twilio-account",
    title: "Twilio account SID",
    severity: "info",
    why: "An identifier, not a secret; listed because an auth token often travels with it.",
    re: /(?<![A-Za-z0-9])(AC[0-9a-f]{32})(?![A-Za-z0-9])/g,
  },
  {
    id: "mailgun-key",
    title: "Mailgun API key",
    severity: "bad",
    why: "Sends email from your Mailgun domains.",
    re: /(?<![\w-])(key-[0-9a-z]{32})(?![\w-])/g,
    minEntropy: 3.5,
    // Not a hex digest such as "key-" + md5.
    refine: (v) => (/[g-z]/.test(v.slice(4)) ? {} : null),
  },
  {
    id: "google-api-key",
    title: "Google API key",
    severity: "warn",
    why: "Browser keys are often public by design: make sure it is restricted by HTTP referrer and to the APIs it needs.",
    re: /(?<![\w-])(AIza[0-9A-Za-z_-]{35})(?![\w-])/g,
    refine: (_v, { text, index }) =>
      /firebaseapp\.com|authDomain|messagingSenderId|storageBucket/.test(near(text, index, 600))
        ? {
            rule: "firebase-config",
            title: "Firebase web config",
            severity: "info",
            why: "Public by design: Firebase data is protected by Security Rules and App Check, not by this key.",
          }
        : {},
  },
  {
    id: "jwt",
    title: "JSON Web Token",
    severity: "warn",
    why: "A signed token shipped in the page: check whom it belongs to and what it grants.",
    re: /(?<![\w-])(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})(?![\w-])/g,
    refine: (v, { source }) => {
      let payload: Record<string, unknown>;
      let expired: boolean | null;
      try {
        ({ payload, expired } = decodeJwt(v));
      } catch {
        return null;
      }
      const facts = [
        typeof payload.iss === "string" ? `iss ${payload.iss}` : "",
        typeof payload.role === "string" ? `role ${payload.role}` : "",
        expired === null ? "no expiry" : expired ? "expired" : "not expired",
      ].filter(Boolean);
      const detail = facts.join(" · ");
      if (payload.role === "service_role")
        return {
          title: "Supabase service_role key",
          severity: "bad",
          why: "Bypasses Row Level Security: full read and write access to the database.",
          detail,
        };
      if (payload.role === "anon")
        return {
          title: "Supabase anon key",
          severity: "info",
          why: "Public by design: Row Level Security policies protect the data, so make sure they are on.",
          detail,
        };
      if (STORAGE_KINDS.includes(source.kind))
        return {
          title: "JWT in browser storage",
          severity: "info",
          why: "Probably your own session: normal for single-page apps, but any script on the page can read it.",
          detail,
        };
      return { detail };
    },
  },
  {
    id: "url-credentials",
    title: "Credentials in a URL",
    severity: "warn",
    why: "A user name and password embedded in a URL.",
    re: /(?<![\w+.-])((?:[a-z][a-z0-9+.-]{1,15}):\/\/[^\s:@/"'`<>]{1,64}:[^\s@/"'`<>]{3,128}@[\w.-]+\.\w+)/gi,
    mask: (v) => v.replace(/(\/\/[^:]+:)[^@]+@/, "$1••••@"),
    refine: (v) => {
      const password = /\/\/[^:]+:([^@]+)@/.exec(v)?.[1] ?? "";
      if (PLACEHOLDER.test(password) || /^(pass(word)?|secret|pwd)$/i.test(password)) return null;
      return /^(postgres(ql)?|mysql|mongodb(\+srv)?|redis|rediss|amqps?|mssql):/i.test(v)
        ? {
            severity: "bad",
            title: "Database connection string",
            why: "Database credentials in the browser: anyone can connect with them.",
          }
        : {};
    },
  },
  {
    id: "generic-assignment",
    title: "Secret-looking value",
    severity: "warn",
    why: "A high-entropy value assigned to a secret-sounding name. Heuristic: check whether it is a real credential.",
    heuristic: true,
    group: 2,
    re: /(?<![\w])["']?([\w-]*?(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key))["']?\s*[:=]\s*["'`]([^"'`\s\\]{12,200})["'`]/gi,
    refine: (v, { match }) => genericCheck(v, match[1] ?? ""),
  },
  {
    id: "generic-assignment",
    title: "Secret-looking value",
    severity: "warn",
    why: "A high-entropy value assigned to a secret-sounding name. Heuristic: check whether it is a real credential.",
    heuristic: true,
    group: 2,
    re: /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|API_KEY|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)=["']?([^\s"'`]{12,200})/gm,
    refine: (v, { match }) => genericCheck(v, match[1] ?? ""),
  },
];

/** Keeps a generic `secret = "…"` match only when the value looks random rather than a name, path or placeholder. */
function genericCheck(value: string, name: string): Hit | null {
  if (PLACEHOLDER.test(value)) return null;
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return null;
  if (/^(https?:|\/|\.\/|#|data:|function|return|true|false|null|undefined)/i.test(value)) return null;
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(value) || (/^[\w-]+(\.[\w-]+)+$/.test(value) && !/\d{3}/.test(value))) return null;
  if (entropy(value) < 3.5) return null;
  if (/public|publishable|site_?key|recaptcha/i.test(name)) return null;
  return { detail: `Assigned to ${name.slice(0, 60)}` };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function position(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo]! + 1 };
}

function contextAround(text: string, index: number, value: string, masked: string): string {
  const before = text.slice(Math.max(0, index - 40), index);
  const after = text.slice(index + value.length, index + value.length + 40);
  return `${before}${masked}${after}`.replace(/\s+/g, " ").trim();
}

const ORDER: Record<SecretFinding["severity"], number> = { bad: 0, warn: 1, info: 2 };
const MAX_LOCATIONS = 20;

/** Finds credentials in `sources`, deduplicated by value: one finding per secret, with every place it appears. */
export function scanSecrets(sources: SecretSource[]): SecretFinding[] {
  const found = new Map<string, SecretFinding>();
  for (const source of sources) {
    const text = source.text;
    if (!text) continue;
    let starts: number[] | null = null;
    const claimed: [number, number][] = [];
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of text.matchAll(rule.re)) {
        const raw = m[rule.group ?? 1];
        if (!raw) continue;
        const index = (m.index ?? 0) + m[0].indexOf(raw);
        if (claimed.some(([a, b]) => index < b && index + raw.length > a)) continue;
        if (rule.id !== "private-key" && rule.id !== "url-credentials" && PLACEHOLDER.test(raw)) continue;
        if (rule.minEntropy && entropy(raw) < rule.minEntropy) continue;
        const hit = rule.refine ? rule.refine(raw, { text, index, match: m, source }) : {};
        if (!hit) continue;
        claimed.push([index, index + raw.length]);
        const value = hit.value ?? raw;
        const ruleId = hit.rule ?? rule.id;
        const key = `${ruleId}:${value}`;
        const masked = (rule.mask ?? mask)(value);
        starts ??= lineStarts(text);
        const loc: SecretLocation = {
          source: source.label,
          kind: source.kind,
          url: source.url,
          ...position(starts, index),
          context: contextAround(text, index, raw, masked),
        };
        const existing = found.get(key);
        if (existing) {
          if (existing.locations.length < MAX_LOCATIONS) existing.locations.push(loc);
          // The same token in a script is worse than in storage: keep the stronger verdict.
          if (ORDER[hit.severity ?? rule.severity] < ORDER[existing.severity]) {
            existing.severity = hit.severity ?? rule.severity;
            existing.title = hit.title ?? rule.title;
            existing.why = hit.why ?? rule.why;
          }
          continue;
        }
        found.set(key, {
          key,
          rule: ruleId,
          title: hit.title ?? rule.title,
          severity: hit.severity ?? rule.severity,
          why: hit.why ?? rule.why,
          heuristic: Boolean(rule.heuristic),
          value,
          masked,
          detail: hit.detail,
          locations: [loc],
        });
      }
    }
  }
  return [...found.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.title.localeCompare(b.title));
}

/** What the scanner looks for, for the panel's "what is checked" list. */
export const SECRET_RULES = [...new Map(RULES.map((r) => [r.title, { title: r.title, severity: r.severity }])).values()];

/** Merges two scans (say, the page's own text and a script fetched later), deduplicated the same way. */
export function mergeFindings(a: SecretFinding[], b: SecretFinding[]): SecretFinding[] {
  const out = new Map(a.map((f) => [f.key, { ...f, locations: [...f.locations] }]));
  for (const f of b) {
    const existing = out.get(f.key);
    if (!existing) {
      out.set(f.key, { ...f, locations: [...f.locations] });
      continue;
    }
    existing.locations.push(...f.locations.slice(0, Math.max(0, MAX_LOCATIONS - existing.locations.length)));
    if (ORDER[f.severity] < ORDER[existing.severity]) Object.assign(existing, { severity: f.severity, title: f.title, why: f.why });
  }
  return [...out.values()].sort((x, y) => ORDER[x.severity] - ORDER[y.severity] || x.title.localeCompare(y.title));
}
