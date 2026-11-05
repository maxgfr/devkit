export interface JsonResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  line?: number;
  column?: number;
}

/**
 * Where JSON.parse failed in `text`, from its error message. V8 gives "at position N" for some
 * errors and only a quoted excerpt for others (`Unexpected token '}', ..."a": }" is not valid JSON`).
 */
export function jsonErrorPosition(text: string, message: string): number | null {
  const pos = /position (\d+)/.exec(message);
  if (pos) return Number(pos[1]);
  if (/Unexpected end of JSON input/.test(message)) return text.length;
  const m = /Unexpected token '(.+?)', (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(message);
  if (!m) return null;
  const [, token, excerpt] = m as unknown as [string, string, string];
  const at = text.indexOf(excerpt);
  if (at < 0) return null;
  const offset = excerpt.indexOf(token, Math.max(0, Math.floor(excerpt.length / 2) - token.length));
  return at + (offset >= 0 ? offset : excerpt.lastIndexOf(token));
}

export function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, position).split("\n");
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}

export function parseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const lc = /line (\d+) column (\d+)/.exec(message);
    if (lc) return { ok: false, error: message, line: Number(lc[1]), column: Number(lc[2]) };
    const pos = jsonErrorPosition(text, message);
    return pos === null ? { ok: false, error: message } : { ok: false, error: message, ...lineColumn(text, pos) };
  }
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  return value;
}

/** A TypeScript type describing a JSON value (handy for API responses). */
export function toTypeScript(value: unknown, name = "Root"): string {
  const decls: string[] = [];
  const pascal = (s: string) =>
    s.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase()).replace(/^\d/, "_$&") || "Item";
  const typeOf = (v: unknown, hint: string): string => {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (!v.length) return "unknown[]";
      const types = Array.from(new Set(v.map((x) => typeOf(x, hint))));
      return types.length === 1 ? `${types[0]}[]` : `(${types.join(" | ")})[]`;
    }
    if (typeof v === "object") {
      const iface = pascal(hint);
      const fields = Object.entries(v as Record<string, unknown>).map(
        ([k, x]) => `  ${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${typeOf(x, k)};`,
      );
      const decl = `interface ${iface} {\n${fields.join("\n")}\n}`;
      if (!decls.includes(decl)) decls.push(decl);
      return iface;
    }
    return typeof v;
  };
  const root = typeOf(value, name);
  if (root !== pascal(name)) decls.push(`type ${pascal(name)} = ${root};`);
  return decls.reverse().join("\n\n");
}

/** Every leaf as `path = value`, e.g. `$.items[0].id = 42`. */
export function jsonPaths(value: unknown, prefix = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonPaths(v, `${prefix}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      jsonPaths(v, /^[a-zA-Z_$][\w$]*$/.test(k) ? `${prefix}.${k}` : `${prefix}[${JSON.stringify(k)}]`),
    );
  return [`${prefix} = ${JSON.stringify(value)}`];
}
