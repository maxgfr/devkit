// Risky cookie flags, per cookie and for the whole jar.
import type { Check, Level } from "../headers";

export interface CookieLike {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  hostOnly: boolean;
}

export interface CookieFlag {
  id: string;
  level: Exclude<Level, "good">;
  label: string;
  detail: string;
}

/** Names that usually carry a session or credentials. A heuristic: CSRF tokens are left out, they are meant to be readable. */
export const AUTH_NAME =
  /(^|[_.-])(sess|sid|token|jwt|login|remember|refresh|id_token|access_token)([_.-]|$)|^(PHPSESSID|JSESSIONID|ASP\.NET_SessionId|connect\.sid|laravel_session)$|session|auth(?!or)/i;
const CSRF_NAME = /csrf|xsrf/i;

const DAY = 86400;

export function isAuthLike(name: string): boolean {
  return AUTH_NAME.test(name) && !CSRF_NAME.test(name);
}

/** Flags for one cookie. `https` is whether the page is served over TLS; `now` is in seconds. */
export function auditCookie(c: CookieLike, https: boolean, now = Date.now() / 1000): CookieFlag[] {
  const out: CookieFlag[] = [];
  const auth = isAuthLike(c.name);
  const size = c.name.length + c.value.length;
  if (https && !c.secure)
    out.push({
      id: "no-secure",
      level: auth ? "bad" : "warn",
      label: "no Secure",
      detail: "Also sent over plain HTTP, where the network can read it.",
    });
  if (auth && !c.httpOnly)
    out.push({
      id: "no-httponly",
      level: "bad",
      label: "readable by JS",
      detail: "Looks like a session cookie (by its name, a heuristic) but has no HttpOnly: an XSS can steal it.",
    });
  if (c.sameSite === "no_restriction" && !c.secure)
    out.push({
      id: "samesite-none",
      level: "bad",
      label: "SameSite=None, no Secure",
      detail: "Chrome rejects SameSite=None cookies that are not Secure.",
    });
  else if (c.sameSite === "no_restriction" && auth)
    out.push({
      id: "samesite-none-auth",
      level: "warn",
      label: "SameSite=None",
      detail: "Sent on cross-site requests: CSRF protection is up to the app.",
    });
  if (!c.session && c.expirationDate) {
    const days = (c.expirationDate - now) / DAY;
    if (days > 365)
      out.push({
        id: "long-expiry",
        level: auth ? "warn" : "info",
        label: `expires in ${Math.round(days)} d`,
        detail: "Lives over a year (Chrome caps new cookies at 400 days). A stolen long-lived session stays valid.",
      });
  }
  if (size > 4096) out.push({ id: "huge", level: "bad", label: `${size} B`, detail: "Over 4 KB: browsers drop it." });
  else if (size > 2048)
    out.push({ id: "large", level: "warn", label: `${size} B`, detail: "Large: it is sent with every request to this site." });
  if (auth && !c.hostOnly)
    out.push({
      id: "domain",
      level: "info",
      label: `shared with *.${c.domain.replace(/^\./, "")}`,
      detail: "Domain cookie: every subdomain receives it.",
    });
  return out;
}

export interface CookieAudit {
  perCookie: CookieFlag[][];
  summary: Check[];
}

export function auditCookies(cookies: CookieLike[], pageUrl: string, now = Date.now() / 1000): CookieAudit {
  const https = pageUrl.startsWith("https:");
  const perCookie = cookies.map((c) => auditCookie(c, https, now));
  const count = (id: string) => perCookie.filter((f) => f.some((x) => x.id === id)).length;
  const summary: Check[] = [];
  const total = cookies.reduce((s, c) => s + c.name.length + c.value.length + 3, 0);
  const noSecure = count("no-secure");
  if (https)
    summary.push({
      id: "secure",
      label: "Secure flag",
      level: noSecure ? "warn" : "good",
      detail: noSecure ? `${noSecure} cookie${noSecure > 1 ? "s" : ""} without Secure on an https site` : "Every cookie is Secure",
    });
  const auth = cookies.filter((c) => isAuthLike(c.name));
  const readable = count("no-httponly");
  summary.push({
    id: "httponly",
    label: "Session cookies (by name, heuristic)",
    level: readable ? "bad" : auth.length ? "good" : "info",
    detail: readable
      ? `${readable} readable from JavaScript: ${auth
          .filter((c) => !c.httpOnly)
          .map((c) => c.name)
          .slice(0, 4)
          .join(", ")}`
      : auth.length
        ? `${auth.length} found, all HttpOnly`
        : "None recognized by name",
  });
  const none = count("samesite-none");
  if (none)
    summary.push({
      id: "samesite",
      label: "SameSite=None without Secure",
      level: "bad",
      detail: `${none} cookie${none > 1 ? "s" : ""}: Chrome rejects them`,
    });
  const long = count("long-expiry");
  if (long)
    summary.push({
      id: "expiry",
      label: "Long-lived",
      level: "info",
      detail: `${long} cookie${long > 1 ? "s" : ""} expire in over a year`,
    });
  const large = count("large") + count("huge");
  if (large) summary.push({ id: "size", label: "Large cookies", level: "warn", detail: `${large} over 2 KB` });
  summary.push({
    id: "count",
    label: "Cookie jar",
    level: cookies.length > 50 || total > 8192 ? "warn" : "info",
    detail: `${cookies.length} cookie${cookies.length === 1 ? "" : "s"}, ${total} bytes in the Cookie header${total > 8192 ? ": many servers reject headers over 8 KB" : cookies.length > 50 ? ": many cookies slow every request" : ""}`,
  });
  return { perCookie, summary };
}
