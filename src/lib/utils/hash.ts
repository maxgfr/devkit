export type HashAlgo = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
export const HASH_ALGOS: HashAlgo[] = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"];

export async function hash(algo: HashAlgo, text: string): Promise<{ hex: string; base64: string }> {
  const buf = new Uint8Array(await crypto.subtle.digest(algo, new TextEncoder().encode(text)));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { hex: Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join(""), base64: btoa(bin) };
}

/** `sha384-…` for a <script integrity> attribute. */
export async function sri(text: string, algo: "SHA-256" | "SHA-384" | "SHA-512" = "SHA-384"): Promise<string> {
  return `${algo.toLowerCase().replace("-", "")}-${(await hash(algo, text)).base64}`;
}

export async function hmac(algo: Exclude<HashAlgo, "SHA-1"> | "SHA-1", key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: algo }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}
