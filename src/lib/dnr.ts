import { browser, type Browser } from "wxt/browser";

type DnrRule = Browser.declarativeNetRequest.Rule;

export type RuleKind = "header" | "redirect" | "block" | "cors";

interface Base {
  id: string;
  enabled: boolean;
  name: string;
  /** DNR urlFilter syntax: `||example.com/api/`, `*://*.cdn.com/*` (`*` and `|` anchors). */
  match: string;
}

export interface HeaderRule extends Base {
  kind: "header";
  target: "request" | "response";
  operation: "set" | "append" | "remove";
  header: string;
  value: string;
}
export interface RedirectRule extends Base {
  kind: "redirect";
  /** Regex replacement when `match` is a regex (`regex: true`), else the full destination URL. */
  to: string;
  regex: boolean;
}
export interface BlockRule extends Base {
  kind: "block";
}
export interface CorsRule extends Base {
  kind: "cors";
  origin: string;
}

export type NetRule = HeaderRule | RedirectRule | BlockRule | CorsRule;

const ALL_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as const;
const SUB_TYPES = ALL_TYPES.filter((t) => t !== "main_frame");

/** Turns devkit's rules into DNR dynamic rules, numbered from 1 in list order. */
export function toDnrRules(rules: NetRule[]): DnrRule[] {
  const out: DnrRule[] = [];
  rules.forEach((rule, i) => {
    if (!rule.enabled || !rule.match.trim()) return;
    const id = i + 1;
    const regex = rule.kind === "redirect" && rule.regex;
    const condition = { ...(regex ? { regexFilter: rule.match } : { urlFilter: rule.match }), resourceTypes: [...ALL_TYPES] };
    switch (rule.kind) {
      case "header": {
        const info = {
          header: rule.header.trim().toLowerCase(),
          operation: rule.operation,
          ...(rule.operation === "remove" ? {} : { value: rule.value }),
        };
        out.push({
          id,
          priority: 2,
          condition,
          action: { type: "modifyHeaders", [rule.target === "request" ? "requestHeaders" : "responseHeaders"]: [info] },
        } as DnrRule);
        break;
      }
      case "redirect":
        out.push({
          id,
          priority: 3,
          condition: { ...condition, resourceTypes: [...SUB_TYPES, "main_frame"] },
          action: { type: "redirect", redirect: regex ? { regexSubstitution: rule.to } : { url: rule.to } },
        } as DnrRule);
        break;
      case "block":
        out.push({ id, priority: 4, condition: { ...condition, resourceTypes: [...SUB_TYPES] }, action: { type: "block" } } as DnrRule);
        break;
      case "cors":
        out.push({
          id,
          priority: 2,
          condition: { ...condition, resourceTypes: ["xmlhttprequest", "other", "font", "script", "image", "media"] },
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "access-control-allow-origin", operation: "set", value: rule.origin || "*" },
              { header: "access-control-allow-methods", operation: "set", value: "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
              { header: "access-control-allow-headers", operation: "set", value: "*" },
              { header: "access-control-expose-headers", operation: "set", value: "*" },
              ...(rule.origin && rule.origin !== "*"
                ? [{ header: "access-control-allow-credentials", operation: "set", value: "true" }]
                : []),
            ],
          },
        } as DnrRule);
        break;
    }
  });
  return out;
}

/** What makes a rule unusable, before Chrome refuses it. */
export function ruleProblem(rule: NetRule): string | null {
  if (!rule.match.trim()) return "Set a URL filter";
  if (rule.kind === "redirect" && rule.regex) {
    try {
      new RegExp(rule.match);
    } catch {
      return "The regex does not compile";
    }
    if (!rule.to) return "Set the substitution (\\1 for the first group)";
  }
  if (rule.kind === "redirect" && !rule.regex && !/^https?:\/\//.test(rule.to)) return "The destination must be an absolute http(s) URL";
  if (rule.kind === "header" && !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(rule.header.trim())) return "Invalid header name";
  return null;
}

export const RULES_KEY = "netRules";

export async function loadRules(): Promise<NetRule[]> {
  const { [RULES_KEY]: rules } = await browser.storage.local.get(RULES_KEY);
  return (rules as NetRule[] | undefined) ?? [];
}

/** Saves the rules and replaces every dynamic rule in Chrome with them. */
export async function saveRules(rules: NetRule[]): Promise<void> {
  await browser.storage.local.set({ [RULES_KEY]: rules });
  const existing = await browser.declarativeNetRequest.getDynamicRules();
  await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: toDnrRules(rules) });
}

export function newRule(kind: RuleKind): NetRule {
  const base = { id: crypto.randomUUID(), enabled: true, name: "", match: "" };
  switch (kind) {
    case "header":
      return { ...base, kind, target: "request", operation: "set", header: "", value: "" };
    case "redirect":
      return { ...base, kind, to: "", regex: false };
    case "block":
      return { ...base, kind };
    case "cors":
      return { ...base, kind, origin: "*" };
  }
}
