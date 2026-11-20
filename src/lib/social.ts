// Open Graph and Twitter / X cards: the tag checklist, the mistakes crawlers trip on, what each network shows
// and the checks on the measured share image. Pure: the SEO panel passes the meta snapshot.
import type { Level } from "./headers";
import { normalizeUrl } from "./hreflang";
import type { MetaSnapshot } from "./page/collect";

const value = (snap: Pick<MetaSnapshot, "meta">, key: string) =>
  snap.meta.find((m) => m.key.toLowerCase() === key.toLowerCase())?.value?.trim() || undefined;

/** The tags Facebook's crawler needs (https://ogp.me/#metadata, https://developers.facebook.com/docs/sharing/webmasters). */
export const OG_ESSENTIAL = ["og:title", "og:description", "og:image", "og:url", "og:type"] as const;
/** Tags that make the card better or faster to build (https://ogp.me/#optional, https://ogp.me/#structured). */
export const OG_RECOMMENDED = ["og:site_name", "og:locale", "og:image:alt", "og:image:width", "og:image:height"] as const;

/** twitter:card values X knows (https://developer.x.com/en/docs/x-for-websites/cards/overview/markup). */
export const TWITTER_CARDS = ["summary", "summary_large_image", "app", "player"] as const;

export interface TagState {
  key: string;
  value?: string;
  /** "fallback": not set, but X reads `from` instead. */
  state: "set" | "fallback" | "missing";
  from?: string;
}

export interface SocialChecklist {
  essential: TagState[];
  recommended: TagState[];
  twitter: TagState[];
  /** Essential tags present, out of 5. */
  score: number;
}

/** X falls back to Open Graph for these (https://developer.x.com/en/docs/x-for-websites/cards/guides/getting-started). */
const TWITTER_FALLBACK: [string, string][] = [
  ["twitter:card", ""],
  ["twitter:title", "og:title"],
  ["twitter:description", "og:description"],
  ["twitter:image", "og:image"],
];

export function socialChecklist(snap: Pick<MetaSnapshot, "meta">): SocialChecklist {
  const tag = (key: string): TagState => {
    const v = value(snap, key);
    return v ? { key, value: v, state: "set" } : { key, state: "missing" };
  };
  const essential = OG_ESSENTIAL.map(tag);
  const twitter = TWITTER_FALLBACK.map(([key, from]): TagState => {
    const v = value(snap, key);
    if (v) return { key, value: v, state: "set" };
    // Without twitter:card, X renders a summary card from og:title and og:description.
    if (key === "twitter:card")
      return value(snap, "og:title") ? { key, value: "summary", state: "fallback", from: "Open Graph" } : { key, state: "missing" };
    const fb = value(snap, from);
    return fb ? { key, value: fb, state: "fallback", from } : { key, state: "missing" };
  });
  return {
    essential,
    recommended: OG_RECOMMENDED.map(tag),
    twitter,
    score: essential.filter((t) => t.state === "set").length,
  };
}

export interface SocialMistake {
  id: string;
  level: Level;
  text: string;
}

/** The mistakes that break or degrade a share card. */
export function socialMistakes(snap: Pick<MetaSnapshot, "meta" | "links" | "url">): SocialMistake[] {
  const out: SocialMistake[] = [];
  const ogUrl = value(snap, "og:url");
  const canonical = snap.links.find((l) => l.rel.toLowerCase().split(/\s+/).includes("canonical"))?.href;
  if (ogUrl && canonical && normalizeUrl(ogUrl, snap.url) !== normalizeUrl(canonical, snap.url))
    out.push({
      id: "og-url-canonical",
      level: "warn",
      text: `og:url (${ogUrl}) does not match the canonical (${canonical}): shares and likes are counted on og:url.`,
    });
  for (const key of ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"]) {
    const img = value(snap, key);
    if (!img) continue;
    if (/^http:\/\//i.test(img))
      out.push({ id: `${key}-http`, level: "warn", text: `${key} is served over http://: use https://, or some apps show no image.` });
    else if (!/^https:\/\//i.test(img))
      out.push({
        id: `${key}-relative`,
        level: "warn",
        text: `${key} is a relative URL (${img}): crawlers need an absolute https:// URL.`,
      });
  }
  const named = snap.meta.filter((m) => m.attr === "name" && /^og:/i.test(m.key)).map((m) => m.key);
  if (named.length)
    out.push({
      id: "og-name",
      level: "warn",
      text: `${named.join(", ")} use name="…": Open Graph tags take property="…" (Facebook ignores name=).`,
    });
  const card = value(snap, "twitter:card");
  if (card && !(TWITTER_CARDS as readonly string[]).includes(card))
    out.push({
      id: "twitter-card",
      level: "warn",
      text: `Unknown twitter:card "${card}": X knows ${TWITTER_CARDS.join(", ")}.`,
    });
  return out;
}

/** Character limits people go by: networks cut in pixels, so these are approximations. */
export const LENGTH_LIMITS = {
  /** Google cuts titles around 600 px, about 60 characters (https://moz.com/learn/seo/title-tag). */
  title: 60,
  /** Google cuts snippets around 920 px, about 155–160 characters. */
  description: 160,
  /** Facebook's link card cuts the title around 88 characters (commonly cited, not documented). */
  "og:title": 88,
  /** Facebook shows about 200 characters of og:description at most (commonly cited). */
  "og:description": 200,
} as const;

export interface LengthCount {
  length: number;
  max: number;
  over: boolean;
}

export const lengthCount = (text: string | undefined, max: number): LengthCount => {
  const length = [...(text ?? "").trim()].length;
  return { length, max, over: length > max };
};

export type Network = "facebook" | "linkedin" | "x" | "whatsapp" | "slack";

export interface NetworkSpec {
  id: Network;
  name: string;
  /** Characters shown before the cut (approximate); 0 when the network does not show the description. */
  title: number;
  description: number;
  /** Image aspect ratio of the large card, width / height. */
  ratio: number;
  ratioText: string;
  /** Minimum image size for the large card; smaller images get the small thumbnail or nothing. */
  minLarge: { width: number; height: number };
  /** Where the domain goes, as the network writes it. */
  domain: "upper" | "plain";
}

/**
 * What each network's link card shows. Ratios are the documented ones (Facebook 1.91:1
 * https://developers.facebook.com/docs/sharing/webmasters/images, X 2:1 for summary_large_image and 1:1 for
 * summary https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image, LinkedIn
 * 1.91:1 https://www.linkedin.com/help/linkedin/answer/a521928); text limits are approximations of what fits.
 */
export const NETWORKS: NetworkSpec[] = [
  {
    id: "facebook",
    name: "Facebook",
    title: 88,
    description: 110,
    ratio: 1.91,
    ratioText: "1.91:1",
    minLarge: { width: 600, height: 315 },
    domain: "upper",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    title: 70,
    description: 0,
    ratio: 1.91,
    ratioText: "1.91:1",
    minLarge: { width: 401, height: 210 },
    domain: "plain",
  },
  {
    id: "x",
    name: "X (Twitter)",
    title: 70,
    description: 200,
    ratio: 2,
    ratioText: "2:1",
    minLarge: { width: 300, height: 157 },
    domain: "plain",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    title: 65,
    description: 80,
    ratio: 1.91,
    ratioText: "1.91:1",
    minLarge: { width: 300, height: 157 },
    domain: "plain",
  },
  {
    id: "slack",
    name: "Slack",
    title: 80,
    description: 150,
    ratio: 1.91,
    ratioText: "1.91:1",
    minLarge: { width: 400, height: 200 },
    domain: "plain",
  },
];

/** `text` cut at `max` characters with an ellipsis, as the network shows it. */
export function truncate(text: string, max: number): { text: string; cut: boolean } {
  const chars = [...text.trim()];
  if (!max || chars.length <= max) return { text: text.trim(), cut: false };
  return {
    text: `${chars
      .slice(0, max - 1)
      .join("")
      .trimEnd()}…`,
    cut: true,
  };
}

export interface CardContent {
  title: string;
  description: string;
  image?: string;
  site: string;
  domain: string;
  /** Large image on top, or a small thumbnail beside the text. */
  layout: "large" | "small";
  ratio: number;
  ratioText: string;
  titleCut: boolean;
  descriptionCut: boolean;
}

/** One network's card: the values it reads (with X's Open Graph fallbacks), cut to its limits. */
export function networkCard(
  snap: Pick<MetaSnapshot, "meta" | "url" | "title">,
  spec: NetworkSpec,
  measured?: { width: number; height: number },
): CardContent {
  const x = spec.id === "x";
  const pick = (...keys: string[]) => keys.map((k) => value(snap, k)).find(Boolean);
  const title = (x ? pick("twitter:title", "og:title") : pick("og:title")) ?? snap.title.trim();
  const description = (x ? pick("twitter:description", "og:description") : pick("og:description")) ?? pick("description") ?? "";
  const image = x ? pick("twitter:image", "og:image") : pick("og:image", "og:image:url");
  let domain = "";
  try {
    domain = new URL(snap.url).hostname.replace(/^www\./, "");
  } catch {
    /* no URL */
  }
  const card = pick("twitter:card") ?? "summary";
  let layout: "large" | "small" = "large";
  let ratio = spec.ratio;
  let ratioText = spec.ratioText;
  if (x && card !== "summary_large_image") {
    layout = "small";
    ratio = 1;
    ratioText = "1:1";
  } else if (measured && (measured.width < spec.minLarge.width || measured.height < spec.minLarge.height)) layout = "small";
  const t = truncate(title, spec.title);
  const d = truncate(description, spec.description);
  return {
    title: t.text,
    description: spec.description ? d.text : "",
    image: image ? resolve(image, snap.url) : undefined,
    site: pick("og:site_name") ?? domain,
    domain: spec.domain === "upper" ? domain.toUpperCase() : domain,
    layout,
    ratio,
    ratioText,
    titleCut: t.cut,
    descriptionCut: spec.description ? d.cut : false,
  };
}

const resolve = (u: string, base: string) => {
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
};

/** Checks on the share image as loaded (natural size), against what networks need and what the tags declare. */
export function imageChecks(
  natural: { width: number; height: number },
  declared: { width?: string; height?: string } = {},
): SocialMistake[] {
  const { width: w, height: h } = natural;
  const out: SocialMistake[] = [];
  if (w < 200 || h < 200)
    out.push({ id: "img-tiny", level: "bad", text: `${w}×${h} is below the 200×200 minimum: Facebook shows no image.` });
  else if (w < 1200 || h < 630)
    out.push({ id: "img-small", level: "warn", text: `${w}×${h} is below 1200×630: the card may be blurry or shown small.` });
  const ratio = w / h;
  if (h && Math.abs(ratio - 1.91) / 1.91 > 0.15)
    out.push({
      id: "img-ratio",
      level: "info",
      text: `Aspect ratio ${ratio.toFixed(2)}:1: large cards crop to about 1.91:1 (2:1 on X).`,
    });
  const dw = Number(declared.width);
  const dh = Number(declared.height);
  if ((declared.width && dw !== w) || (declared.height && dh !== h))
    out.push({
      id: "img-declared",
      level: "warn",
      text: `og:image:width/height say ${declared.width ?? "?"}×${declared.height ?? "?"}, the file is ${w}×${h}.`,
    });
  if (!out.length) out.push({ id: "img-ok", level: "good", text: `${w}×${h}, ratio ${ratio.toFixed(2)}:1.` });
  return out;
}
