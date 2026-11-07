// Bug report for a coding agent: data shapes, the recorded steps, request triage, redaction and the
// Markdown / JSON renderers. Pure: the page collectors live in src/lib/page/report.ts and
// src/lib/page/recorder.ts, the gathering in src/lib/bug-report-gather.ts.

import { sourcePath } from "./element";
import { scanSecrets } from "./security/secrets";
import { describeStep, playwrightTest, type Step } from "./steps";

export * from "./steps";
import { formatBytes } from "./storage-usage";
import { formatVital, rateVital, RATING_TEXT, VITALS, type VitalName } from "./viz";

/* Parts */

export type ReportPart = "steps" | "environment" | "tech" | "errors" | "requests" | "vitals" | "element" | "storage" | "text" | "dom";

export const REPORT_PARTS: { id: ReportPart; label: string }[] = [
  { id: "steps", label: "Steps to reproduce" },
  { id: "environment", label: "Environment" },
  { id: "errors", label: "Console errors" },
  { id: "requests", label: "Failed and slow requests" },
  { id: "vitals", label: "Web Vitals" },
  { id: "tech", label: "Tech stack" },
  { id: "element", label: "Picked element" },
  { id: "storage", label: "Storage summary" },
  { id: "text", label: "Page text excerpt" },
  { id: "dom", label: "DOM snapshot" },
];

/** On unless the user turns them off; the page text and the DOM are opt-in (long, and closer to content than to the bug). */
export const DEFAULT_REPORT_PARTS: ReportPart[] = ["steps", "environment", "errors", "requests", "vitals", "tech", "element", "storage"];

export const SLOW_THRESHOLDS = [500, 1000, 2000, 3000];
export const DEFAULT_SLOW_MS = 1000;

/* Environment */

export interface EnvSnapshot {
  url: string;
  title: string;
  time: number;
  timezone: string;
  viewport: { width: number; height: number };
  dpr: number;
  screen: { width: number; height: number };
  userAgent: string;
  /** From navigator.userAgentData: full versions when Chrome gives them. */
  brands?: { brand: string; version: string }[];
  platform?: string;
  platformVersion?: string;
  mobile?: boolean;
  colorScheme: "light" | "dark";
  reducedMotion: boolean;
  language: string;
  languages: string[];
  online: boolean;
  connection?: string;
  /** HTTP status of the document itself, when Chrome exposes it. */
  documentStatus?: number;
}

/** "Chrome 142.0.7444.59", from the full version list, else the user agent string. */
export function browserName(env: Pick<EnvSnapshot, "brands" | "userAgent">): string {
  const brands = env.brands ?? [];
  const named = ["Google Chrome", "Microsoft Edge", "Brave", "Opera", "Vivaldi"]
    .map((n) => brands.find((b) => b.brand === n))
    .find(Boolean);
  const chromium = brands.find((b) => b.brand === "Chromium");
  const pick = named ?? chromium;
  if (pick) return `${pick.brand === "Google Chrome" ? "Chrome" : pick.brand} ${pick.version}`;
  for (const [re, name] of [
    [/Edg\/([\d.]+)/, "Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ] as const) {
    const m = re.exec(env.userAgent);
    if (m) return `${name} ${m[1]}`;
  }
  return "Unknown browser";
}

/** "macOS 15.1.0", "Windows 11", "Android 15"… from the client hints, else the user agent. */
export function osName(env: Pick<EnvSnapshot, "platform" | "platformVersion" | "userAgent">): string {
  const p = env.platform ?? "";
  const v = env.platformVersion ?? "";
  if (p === "Windows" && v) return Number(v.split(".")[0]) >= 13 ? "Windows 11" : "Windows 10";
  if (p) return `${p}${v && v !== "0.0.0" ? ` ${v}` : ""}`;
  const ua = env.userAgent;
  if (/Android ([\d.]+)/.test(ua)) return `Android ${/Android ([\d.]+)/.exec(ua)![1]}`;
  if (/Mac OS X/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown OS";
}

export function environmentLines(env: EnvSnapshot): string[] {
  const local = new Date(env.time);
  return [
    `- URL: ${env.url}${env.documentStatus && env.documentStatus >= 400 ? ` (HTTP ${env.documentStatus})` : ""}`,
    `- Title: ${env.title || "(none)"}`,
    `- Time: ${local.toISOString()} (${env.timezone})`,
    `- Browser: ${browserName(env)} on ${osName(env)}${env.mobile ? " (mobile)" : ""}`,
    `- Viewport: ${env.viewport.width}×${env.viewport.height} at DPR ${env.dpr} · screen ${env.screen.width}×${env.screen.height}`,
    `- Preferences: ${env.colorScheme} color scheme${env.reducedMotion ? ", reduced motion" : ""} · language ${env.language}${
      env.languages.length > 1 ? ` (${env.languages.slice(0, 4).join(", ")})` : ""
    }`,
    `- Network: ${env.online ? "online" : "offline"}${env.connection ? ` (${env.connection})` : ""}`,
    `- User agent: \`${env.userAgent}\``,
  ];
}

/* Requests */

export interface RequestEntry {
  name: string;
  type: string;
  /** 0 when Chrome does not expose it (cross-origin without CORS, blocked, aborted). */
  status: number;
  duration: number;
  transfer: number;
  startTime: number;
}

export interface RequestsSnapshot {
  origin: string;
  entries: RequestEntry[];
  /** `PerformanceResourceTiming.responseStatus` exists (Chrome 109+). */
  statusSupported: boolean;
  /** The Resource Timing buffer is full: later requests are missing. */
  bufferFull: boolean;
}

export interface RequestTriage {
  failed: RequestEntry[];
  slow: RequestEntry[];
  /** Requests whose status the page cannot read. */
  noStatus: number;
  total: number;
}

export function triageRequests(snap: RequestsSnapshot, slowMs: number, max = 15): RequestTriage {
  const failed = snap.entries.filter((e) => e.status >= 400).sort((a, b) => a.startTime - b.startTime);
  const slow = snap.entries
    .filter((e) => e.status < 400 && e.duration >= slowMs)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, max);
  return {
    failed: failed.slice(0, max),
    slow,
    noStatus: snap.entries.filter((e) => !e.status).length,
    total: snap.entries.length,
  };
}

/** A request URL as short as it stays clear: the path for this origin, the full URL for others, capped. */
export function requestLabel(url: string, origin: string): string {
  let out = url;
  try {
    const u = new URL(url);
    out = u.origin === origin ? `${u.pathname}${u.search}` : url;
  } catch {
    /* keep it */
  }
  return out.length > 180 ? `${out.slice(0, 180)}…` : out;
}

const durationText = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

function requestLine(e: RequestEntry, origin: string): string {
  const status = e.status ? String(e.status) : "no status";
  const size = e.transfer > 0 ? ` · ${formatBytes(e.transfer)}` : "";
  return `- ${status} ${e.type || "other"} \`${requestLabel(e.name, origin)}\` · ${durationText(e.duration)}${size}`;
}

/* Redaction */

const SENSITIVE_PARAM =
  /^(?:.*[_-])?(?:token|access_?token|id_?token|refresh_?token|api_?key|apikey|key|secret|client_?secret|password|passwd|pwd|pass|auth|authorization|sig|signature|session|sessionid|sid|code|jwt|credentials?|otp)$/i;
const URL_PARAM = /([?&;#])([\w.[\]-]{1,60})=([^&#\s"'<>`)\]]+)/g;

export interface Redactor {
  redact: (text: string) => string;
  /** Distinct values found in the corpus. */
  count: number;
  /** Distinct values `text` holds (before redaction). */
  countIn: (text: string) => number;
}

/**
 * Finds what must not leave the device in `corpus` (keys and tokens the Security tab's secret scanner
 * recognizes, values of query parameters named like credentials), and returns a function that
 * masks them in any text.
 */
export function createRedactor(corpus: string): Redactor {
  const values = new Map<string, string>();
  for (const f of scanSecrets([{ kind: "inline-script", label: "report", text: corpus }])) values.set(f.value, f.masked);
  const params = new Set<string>();
  for (const m of corpus.matchAll(URL_PARAM)) if (SENSITIVE_PARAM.test(m[2]!) && m[3]!.length >= 4) params.add(m[3]!);
  const all = new Set([...values.keys(), ...params]);
  const sorted = [...values.entries()].sort((a, b) => b[0].length - a[0].length);
  return {
    count: all.size,
    countIn: (text) => [...all].filter((v) => text.includes(v)).length,
    redact: (text) => {
      let out = text;
      for (const [value, masked] of sorted) if (value && out.includes(value)) out = out.split(value).join(masked);
      return out.replace(URL_PARAM, (whole, sep: string, name: string, value: string) =>
        SENSITIVE_PARAM.test(name) && value.length >= 4 ? `${sep}${name}=[redacted]` : whole,
      );
    },
  };
}

/* The report */

export interface ReportError {
  kind: string;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  count: number;
  time: number;
}

export interface VitalsData {
  lcp: number | null;
  cls: number;
  inp: number | null;
  fcp: number | null;
  ttfb: number | null;
  longTasks: { count: number; total: number };
}

export interface ReportData {
  description: string;
  url: string;
  title: string;
  env?: EnvSnapshot;
  steps?: { steps: Step[]; recording: boolean; recordValues: boolean };
  tech?: { name: string; category: string }[];
  /** `installed` false: devkit's error capture is not running on the page. */
  errors?: { installed: boolean; errors: ReportError[] };
  requests?: RequestsSnapshot;
  vitals?: VitalsData;
  element?: { markdown: string; image: boolean };
  storage?: string;
  text?: { text: string; total: number };
  dom?: { html: string; root: string; trimmed: boolean };
  /** A viewport screenshot is pasted next to the text. */
  screenshot?: boolean;
  slowMs: number;
}

export interface ReportSection {
  part: ReportPart | "description";
  markdown: string;
}

const fence = (lang: string, body: string) => {
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const TEXT_EXCERPT = 3000;

/** Each part as its own Markdown section, before redaction. Missing data gives an empty section, not an error. */
export function reportSections(d: ReportData): ReportSection[] {
  const out: ReportSection[] = [];
  const origin = (() => {
    try {
      return new URL(d.url).origin;
    } catch {
      return "";
    }
  })();
  const description = d.description.trim();
  out.push({
    part: "description",
    markdown: description ? `## What happened\n${description}` : "",
  });

  if (d.steps) {
    const { steps } = d.steps;
    out.push({
      part: "steps",
      markdown: steps.length
        ? [
            "## Steps to reproduce (recorded)",
            ...steps.map((s, i) => `${i + 1}. ${describeStep(s, origin)}`),
            ...(d.steps.recordValues ? [] : ["", "_Typed values are masked._"]),
            "",
            "Playwright test from these steps:",
            fence("ts", playwrightTest(steps, { url: d.url, title: d.title })),
          ].join("\n")
        : "",
    });
  }

  if (d.env) out.push({ part: "environment", markdown: ["## Environment", ...environmentLines(d.env)].join("\n") });

  if (d.errors) {
    const list = [...d.errors.errors].sort((a, b) => a.time - b.time);
    const total = list.reduce((s, e) => s + e.count, 0);
    const lines = [`## Console errors (${total})`];
    if (!d.errors.installed) lines.push("_devkit's error capture is not running on this page: errors thrown so far are not known._");
    else if (!list.length) lines.push("No error captured.");
    for (const e of list.slice(0, 20)) {
      const where = e.source ? ` (${sourcePath(e.source)}:${e.line ?? "?"}${e.column ? `:${e.column}` : ""})` : "";
      lines.push(`- [${e.kind}${e.count > 1 ? ` ×${e.count}` : ""}] ${e.message.split("\n")[0]!.slice(0, 400)}${where}`);
      const frames = e.stack
        ?.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at ") && !/chrome-extension:/.test(l))
        .slice(0, 3);
      if (frames?.length) lines.push(...frames.map((f) => `  ${f}`));
    }
    if (list.length > 20) lines.push(`… and ${list.length - 20} more`);
    out.push({ part: "errors", markdown: lines.join("\n") });
  }

  if (d.requests) {
    const t = triageRequests(d.requests, d.slowMs);
    const lines = ["## Failed and slow requests"];
    if (!d.requests.statusSupported) lines.push("_This browser does not expose response statuses to the page (Chrome 109+ does)._");
    lines.push(t.failed.length ? `Failed (${t.failed.length}):` : "No failed request seen.");
    lines.push(...t.failed.map((e) => requestLine(e, d.requests!.origin)));
    if (t.slow.length)
      lines.push(`Slow, over ${durationText(d.slowMs)} (${t.slow.length}):`, ...t.slow.map((e) => requestLine(e, d.requests!.origin)));
    lines.push(
      `_From Resource Timing (${plural(t.total, "request")}). ${
        t.noStatus
          ? `${plural(t.noStatus, "request")} ${t.noStatus === 1 ? "has" : "have"} no status: cross-origin without CORS, blocked or aborted. `
          : ""
      }Requests that never got a response (CORS errors, offline) are not listed here.${d.requests.bufferFull ? " The timing buffer is full: later requests are missing." : ""}_`,
    );
    out.push({ part: "requests", markdown: lines.join("\n") });
  }

  if (d.vitals) {
    const v = d.vitals;
    const names: [VitalName, number | null][] = [
      ["lcp", v.lcp],
      ["inp", v.inp],
      ["cls", v.cls],
      ["fcp", v.fcp],
      ["ttfb", v.ttfb],
    ];
    const parts = names.map(([n, value]) => {
      const rating = rateVital(n, value);
      return `${VITALS[n].label} ${formatVital(n, value)}${rating ? ` (${RATING_TEXT[rating].toLowerCase()})` : ""}`;
    });
    out.push({
      part: "vitals",
      markdown: `## Web Vitals (measured in this tab)\n${parts.join(" · ")} · long tasks ${v.longTasks.count} (${Math.round(v.longTasks.total)} ms)`,
    });
  }

  if (d.tech)
    out.push({
      part: "tech",
      markdown: `## Tech stack (detected)\n${d.tech.length ? d.tech.map((t) => `${t.name} (${t.category.toLowerCase()})`).join(", ") : "Nothing detected."}`,
    });

  if (d.element) out.push({ part: "element", markdown: d.element.markdown.trim().replace(/^## UI element/, "## Picked element") });

  if (d.storage)
    out.push({ part: "storage", markdown: `${d.storage.trim()}\n_Names and sizes only: no cookie or storage value is read._` });

  if (d.text?.text)
    out.push({
      part: "text",
      markdown: `## Page text (excerpt)\n${fence("text", d.text.text)}${d.text.total > d.text.text.length ? `\n_First ${d.text.text.length} of ${d.text.total} characters._` : ""}`,
    });

  if (d.dom?.html)
    out.push({
      part: "dom",
      markdown: `## DOM snapshot of \`${d.dom.root}\`${d.dom.trimmed ? " (trimmed)" : ""}\n${fence("html", d.dom.html)}`,
    });

  return out.filter((s) => s.markdown);
}

export interface BuiltReport {
  markdown: string;
  /** Redacted size of each part's section, in characters. */
  sizes: Partial<Record<ReportPart | "description", number>>;
  redacted: number;
  redact: (text: string) => string;
}

/** The report as Markdown for a coding agent, with secrets masked. */
export function buildReport(d: ReportData, parts: ReportPart[]): BuiltReport {
  const all = reportSections(d);
  const corpus = all.map((s) => s.markdown).join("\n");
  const redactor = createRedactor(corpus);
  const sizes: BuiltReport["sizes"] = {};
  const chosen: string[] = [];
  const raw: string[] = [];
  for (const s of all) {
    const text = redactor.redact(s.markdown);
    sizes[s.part] = text.length;
    if (s.part === "description" || parts.includes(s.part)) {
      chosen.push(text);
      raw.push(s.markdown);
    }
  }
  const redacted = redactor.countIn(raw.join("\n"));
  const footer: string[] = [];
  if (d.screenshot) footer.push("A screenshot of the viewport is attached.");
  if (d.element?.image && parts.includes("element")) footer.push("A screenshot of the picked element is attached.");
  if (redacted)
    footer.push(
      `${redacted === 1 ? "1 value that looked like a secret was" : `${redacted} values that looked like secrets were`} redacted by devkit.`,
    );
  footer.push("Collected locally by devkit; nothing was sent anywhere.");
  const markdown = `# Bug report: ${d.title || d.url}\n\n${chosen.join("\n\n")}\n\n---\n_${footer.join(" ")}_\n`;
  return { markdown, sizes, redacted, redact: redactor.redact };
}

/** The same data as JSON, for tools and issue trackers. Strings go through the same redaction. */
export function buildReportJson(d: ReportData, parts: ReportPart[], redact: (s: string) => string): string {
  const has = (p: ReportPart) => parts.includes(p);
  const t = d.requests ? triageRequests(d.requests, d.slowMs) : null;
  const data = {
    $schema: "devkit-bug-report/1",
    createdAt: new Date(d.env?.time ?? Date.now()).toISOString(),
    url: d.url,
    title: d.title,
    description: d.description.trim() || undefined,
    environment: has("environment") && d.env ? { ...d.env, browser: browserName(d.env), os: osName(d.env) } : undefined,
    steps:
      has("steps") && d.steps?.steps.length
        ? {
            list: d.steps.steps.map((s) => ({ ...s, text: describeStep(s) })),
            playwright: playwrightTest(d.steps.steps, { url: d.url, title: d.title }),
          }
        : undefined,
    consoleErrors: has("errors") && d.errors ? { captureOn: d.errors.installed, errors: d.errors.errors } : undefined,
    requests:
      has("requests") && t
        ? { slowThresholdMs: d.slowMs, failed: t.failed, slow: t.slow, withoutStatus: t.noStatus, observed: t.total }
        : undefined,
    webVitals: has("vitals") ? d.vitals : undefined,
    tech: has("tech") ? d.tech : undefined,
    pickedElement: has("element") && d.element ? { markdown: d.element.markdown } : undefined,
    storage: has("storage") && d.storage ? { markdown: d.storage } : undefined,
    pageText: has("text") ? d.text : undefined,
    dom: has("dom") ? d.dom : undefined,
  };
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? redact(v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return `${JSON.stringify(walk(data), null, 2)}\n`;
}

/** File name for the download: bug-report-example.com-2026-11-07T10-12-00.md */
export function reportFileName(url: string, time: number, ext: "md" | "json"): string {
  let host = "page";
  try {
    host = new URL(url).host.replace(/[^\w.-]+/g, "-") || "page";
  } catch {
    /* keep page */
  }
  return `bug-report-${host}-${new Date(time).toISOString().slice(0, 19).replace(/:/g, "-")}.${ext}`;
}

/** Session storage key under which the report panel hands its Markdown to the AI panel. */
export const REPORT_HANDOFF_KEY = "bugReport";

export interface ReportHandoff {
  tabId: number;
  url: string;
  markdown: string;
  image?: string;
  at: number;
}
