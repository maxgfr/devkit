import { relative } from "./jwt";

export interface TimeView {
  ms: number;
  iso: string;
  utc: string;
  local: string;
  unix: number;
  unixMs: number;
  relative: string;
}

/** Reads a Unix timestamp (s, ms, µs, ns) or any date string. */
export function parseTime(input: string, now = Date.now()): TimeView | null {
  const t = input.trim();
  if (!t) return null;
  let ms: number;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    const digits = t.replace(/^-/, "").split(".")[0]!.length;
    ms = digits <= 11 ? n * 1000 : digits <= 14 ? n : digits <= 17 ? n / 1000 : n / 1e6;
  } else {
    ms = Date.parse(t);
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return {
    ms,
    iso: d.toISOString(),
    utc: d.toUTCString(),
    local: d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
    unix: Math.floor(ms / 1000),
    unixMs: Math.round(ms),
    relative: relative(ms - now),
  };
}
