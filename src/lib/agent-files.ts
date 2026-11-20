// The agent and crawler files of a page's origin (robots.txt, llms.txt, llms-full.txt, ai.txt, the sitemap), read
// for the Agent readiness panel, the AI context and the Overview. Plain fetches from the extension, no cookies.
import { type AiTxt, type CrawlerAccess, crawlerAccess, type LlmsTxt, parseAiTxt, parseLlmsTxt } from "./readiness";
import { parseRobots, type Robots } from "./site-files";

export interface AgentFiles {
  robotsStatus: number;
  robots: Robots | null;
  crawlers: CrawlerAccess[];
  /** The page's path, the one the crawler rules are checked against. */
  path: string;
  llms: LlmsTxt;
  llmsFull: LlmsTxt;
  aiTxt: AiTxt;
  sitemap: { url: string; found: boolean };
}

async function fetchText(url: string): Promise<{ status: number; text: string; type: string }> {
  try {
    const res = await fetch(url, { credentials: "omit", cache: "no-store" });
    return { status: res.status, text: await res.text(), type: res.headers.get("content-type") ?? "" };
  } catch {
    return { status: 0, text: "", type: "" };
  }
}

/** /llms.txt alone: the only agent file the readiness score counts (the others only add recommendations). */
export async function fetchLlmsTxt(origin: string): Promise<LlmsTxt> {
  const r = await fetchText(`${origin}/llms.txt`);
  return parseLlmsTxt(`${origin}/llms.txt`, r.status, r.type, r.text);
}

/** robots.txt, llms.txt, llms-full.txt, ai.txt and the sitemap of `origin`; crawler rules checked for `url`'s path. */
export async function fetchAgentFiles(origin: string, url: string): Promise<AgentFiles> {
  const [robots, llms, llmsFull, ai] = await Promise.all(
    ["/robots.txt", "/llms.txt", "/llms-full.txt", "/ai.txt"].map((p) => fetchText(`${origin}${p}`)),
  );
  const parsedRobots = robots!.status > 0 && robots!.status < 400 && !/text\/html/i.test(robots!.type) ? parseRobots(robots!.text) : null;
  let path = "/";
  try {
    path = new URL(url).pathname || "/";
  } catch {
    /* keep / */
  }
  const listed = parsedRobots?.sitemaps[0];
  let sitemap: { url: string; found: boolean };
  if (listed) sitemap = { url: listed, found: true };
  else {
    const s = await fetchText(`${origin}/sitemap.xml`);
    sitemap = { url: `${origin}/sitemap.xml`, found: s.status > 0 && s.status < 400 && /<(urlset|sitemapindex)\b/.test(s.text) };
  }
  return {
    robotsStatus: robots!.status,
    robots: parsedRobots,
    crawlers: crawlerAccess(parsedRobots, path),
    path,
    llms: parseLlmsTxt(`${origin}/llms.txt`, llms!.status, llms!.type, llms!.text),
    llmsFull: parseLlmsTxt(`${origin}/llms-full.txt`, llmsFull!.status, llmsFull!.type, llmsFull!.text),
    aiTxt: parseAiTxt(`${origin}/ai.txt`, ai!.status, ai!.type, ai!.text),
    sitemap,
  };
}
