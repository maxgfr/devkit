const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64Encode(text: string, urlSafe = false): string {
  let bin = "";
  for (const b of enc.encode(text)) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return urlSafe ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
}

export function base64Decode(b64: string): string {
  const clean = b64.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const htmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

export function htmlUnescape(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

export type Codec = "base64" | "base64url" | "url" | "url-component" | "html" | "hex" | "unicode";

export function encodeWith(codec: Codec, text: string): string {
  switch (codec) {
    case "base64":
      return base64Encode(text);
    case "base64url":
      return base64Encode(text, true);
    case "url":
      return encodeURI(text);
    case "url-component":
      return encodeURIComponent(text);
    case "html":
      return htmlEscape(text);
    case "hex":
      return Array.from(enc.encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
    case "unicode":
      return Array.from(text, (c) => {
        const cp = c.codePointAt(0)!;
        return cp < 128 ? c : cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
      }).join("");
  }
}

export function decodeWith(codec: Codec, text: string): string {
  switch (codec) {
    case "base64":
    case "base64url":
      return base64Decode(text);
    case "url":
      return decodeURI(text);
    case "url-component":
      return decodeURIComponent(text.replace(/\+/g, " "));
    case "html":
      return htmlUnescape(text);
    case "hex": {
      const clean = text.replace(/[^0-9a-f]/gi, "");
      if (clean.length % 2) throw new Error("Odd number of hex digits");
      return dec.decode(Uint8Array.from(clean.match(/../g) ?? [], (h) => Number.parseInt(h, 16)));
    }
    case "unicode":
      return text.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (_, a: string, b: string) =>
        String.fromCodePoint(Number.parseInt(a ?? b, 16)),
      );
  }
}
