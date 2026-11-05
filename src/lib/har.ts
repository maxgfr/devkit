// Request → command line / code, from a HAR entry (what chrome.devtools.network hands out).

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarRequestLike {
  method: string;
  url: string;
  headers: HarHeader[];
  postData?: { mimeType?: string; text?: string };
}

const SKIP = new Set(["content-length", "host", "connection", "accept-encoding"]);
const keep = (h: HarHeader) => !h.name.startsWith(":") && !SKIP.has(h.name.toLowerCase());

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(req: HarRequestLike): string {
  const parts = [`curl ${sh(req.url)}`];
  if (req.method !== "GET" && !(req.method === "POST" && req.postData?.text)) parts.push(`-X ${req.method}`);
  for (const h of req.headers.filter(keep)) parts.push(`-H ${sh(`${h.name}: ${h.value}`)}`);
  if (req.postData?.text) parts.push(`--data-raw ${sh(req.postData.text)}`);
  if (req.headers.some((h) => h.name.toLowerCase() === "accept-encoding")) parts.push("--compressed");
  return parts.join(" \\\n  ");
}

export function toFetch(req: HarRequestLike): string {
  const headers = Object.fromEntries(req.headers.filter(keep).map((h) => [h.name, h.value]));
  const init: Record<string, unknown> = { method: req.method, headers };
  if (req.postData?.text) init.body = req.postData.text;
  return `await fetch(${JSON.stringify(req.url)}, ${JSON.stringify(init, null, 2)});`;
}

export function toHttpie(req: HarRequestLike): string {
  const parts = [`http ${req.method} ${sh(req.url)}`];
  for (const h of req.headers.filter(keep)) parts.push(sh(`${h.name}:${h.value}`));
  const cmd = parts.join(" \\\n  ");
  return req.postData?.text ? `printf %s ${sh(req.postData.text)} | ${cmd}` : cmd;
}

export function toPython(req: HarRequestLike): string {
  const headers = Object.fromEntries(req.headers.filter(keep).map((h) => [h.name, h.value]));
  const lines = ["import requests", "", `headers = ${JSON.stringify(headers, null, 4)}`];
  const data = req.postData?.text ? `, data=${JSON.stringify(req.postData.text)}` : "";
  lines.push(
    `response = requests.request(${JSON.stringify(req.method)}, ${JSON.stringify(req.url)}, headers=headers${data})`,
    "print(response.status_code, response.text[:500])",
  );
  return lines.join("\n");
}

export const EXPORTERS = { curl: toCurl, fetch: toFetch, httpie: toHttpie, python: toPython } as const;
export type ExportFormat = keyof typeof EXPORTERS;
