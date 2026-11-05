import { base64Decode } from "./encode";

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  claims: { name: string; value: string }[];
  expired: boolean | null;
}

const TIME_CLAIMS = ["exp", "iat", "nbf", "auth_time", "updated_at"];

/** Decodes a JWT without verifying it (the key is not known here). */
export function decodeJwt(token: string, now = Date.now()): DecodedJwt {
  const parts = token
    .trim()
    .replace(/^Bearer\s+/i, "")
    .split(".");
  if (parts.length < 2) throw new Error("A JWT has three parts separated by dots");
  const parse = (part: string, what: string) => {
    try {
      return JSON.parse(base64Decode(part)) as Record<string, unknown>;
    } catch {
      throw new Error(`The ${what} is not base64url JSON`);
    }
  };
  const header = parse(parts[0]!, "header");
  const payload = parse(parts[1]!, "payload");
  const claims = TIME_CLAIMS.filter((c) => typeof payload[c] === "number").map((c) => {
    const date = new Date((payload[c] as number) * 1000);
    return { name: c, value: `${date.toISOString()} (${relative(date.getTime() - now)})` };
  });
  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : null;
  return { header, payload, signature: parts[2] ?? "", claims, expired: exp === null ? null : exp < now };
}

export function relative(ms: number): string {
  const abs = Math.abs(ms);
  const units: [number, string][] = [
    [86400000 * 365, "year"],
    [86400000 * 30, "month"],
    [86400000, "day"],
    [3600000, "hour"],
    [60000, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return ms < 0 ? `${n} ${name}${n > 1 ? "s" : ""} ago` : `in ${n} ${name}${n > 1 ? "s" : ""}`;
    }
  }
  return "now";
}
