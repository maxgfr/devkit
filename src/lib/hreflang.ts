// hreflang validation of the page's <link rel="alternate" hreflang> tags, by Google's rules
// (https://developers.google.com/search/docs/specialty/international/localized-versions): an ISO 639-1
// language, optionally a script and an ISO 3166-1 alpha-2 region, or x-default; absolute URLs; the page
// listing itself; one URL per language. Pure: the SEO panel passes the collected links.
import type { Level } from "./headers";

/** ISO 639-1 language codes (184, `bh` included although retired). */
const ISO_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es " +
    "et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk " +
    "kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc " +
    "oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn " +
    "to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
);

/** ISO 3166-1 alpha-2 country codes (249). */
const ISO_3166_1 = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD " +
    "CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF " +
    "GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
    "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA " +
    "NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI " +
    "SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI " +
    "VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

/** Codes people write that are not the ISO one, with the code meant. */
const REGION_FIX: Record<string, string> = { UK: "GB" };
const DEPRECATED_LANG: Record<string, string> = { iw: "he", in: "id", ji: "yi" };

export const isLanguage = (code: string) => ISO_639_1.has(code.toLowerCase());
export const isRegion = (code: string) => ISO_3166_1.has(code.toUpperCase());

export interface HreflangProblem {
  level: Level;
  text: string;
}

/** Problems of one hreflang value (empty when valid). */
export function hreflangCodeProblems(value: string): HreflangProblem[] {
  const code = value.trim();
  if (!code) return [{ level: "bad", text: "Empty hreflang." }];
  if (code.toLowerCase() === "x-default") return [];
  const out: HreflangProblem[] = [];
  const fixed = code.replace(/_/g, "-");
  if (fixed !== code) out.push({ level: "bad", text: `Use a hyphen, not an underscore: ${suggest(fixed)}.` });
  const parts = fixed.split("-");
  const [lang = "", ...rest] = parts;
  let script: string | undefined;
  let region: string | undefined;
  for (const p of rest) {
    if (!script && !region && /^[a-z]{4}$/i.test(p)) script = p;
    else if (!region) region = p;
    else {
      out.push({ level: "bad", text: `Too many parts: hreflang is a language, an optional script and an optional region.` });
      break;
    }
  }
  if (!/^[a-z]{2,3}$/i.test(lang)) out.push({ level: "bad", text: `"${lang}" is not a language code (ISO 639-1, like en or fr).` });
  else if (DEPRECATED_LANG[lang.toLowerCase()])
    out.push({ level: "warn", text: `"${lang}" is a retired code: use ${DEPRECATED_LANG[lang.toLowerCase()]}.` });
  else if (lang.length === 3) out.push({ level: "warn", text: `"${lang}" is not ISO 639-1: Google expects a two-letter language code.` });
  else if (!isLanguage(lang))
    out.push({
      level: "bad",
      text: isRegion(lang)
        ? `"${lang}" is a country code, not a language: write the language first (for example ${guessLanguage(lang)}-${lang.toUpperCase()}).`
        : `"${lang}" is not an ISO 639-1 language code.`,
    });
  if (region) {
    if (/^\d{3}$/.test(region))
      out.push({ level: "warn", text: `"${region}" is a UN M.49 area: Google only reads ISO 3166-1 country codes.` });
    else if (REGION_FIX[region.toUpperCase()])
      out.push({ level: "bad", text: `"${region}" is not a country code: use ${lang.toLowerCase()}-${REGION_FIX[region.toUpperCase()]}.` });
    else if (!isRegion(region)) out.push({ level: "bad", text: `"${region}" is not an ISO 3166-1 alpha-2 country code.` });
  }
  if (!rest.length && lang.toLowerCase() === "uk")
    out.push({ level: "info", text: `"uk" means Ukrainian; for English in the United Kingdom use en-GB.` });
  return out;
}

const suggest = (code: string) => {
  const [lang = "", ...rest] = code.split("-");
  return [lang.toLowerCase(), ...rest.map((p) => (p.length === 4 ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()))].join(
    "-",
  );
};

const LANG_OF_REGION: Record<string, string> = {
  GB: "en",
  US: "en",
  AT: "de",
  CH: "de",
  BE: "fr",
  CA: "en",
  MX: "es",
  BR: "pt",
  CN: "zh",
  JP: "ja",
  GR: "el",
  SE: "sv",
  DK: "da",
  CZ: "cs",
};
const guessLanguage = (region: string) => LANG_OF_REGION[region.toUpperCase()] ?? "xx";

/** Compares URLs the way a crawler would: host case, default port and a trailing slash do not matter. */
export function sameUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

export function normalizeUrl(u: string, base?: string): string {
  try {
    const url = new URL(u, base);
    url.hash = "";
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return u.trim();
  }
}

export interface HreflangEntry {
  lang: string;
  href: string;
  /** The attribute as written. */
  raw: string;
  /** This entry is the page itself. */
  self: boolean;
  /** Language and region names, when known ("French (Canada)"). */
  name?: string;
  problems: HreflangProblem[];
}

export interface HreflangReport {
  entries: HreflangEntry[];
  xDefault: boolean;
  selfReference: boolean;
  languages: number;
  /** Problems of the whole set (missing self-reference, x-default, conflicts). */
  problems: HreflangProblem[];
}

const displayName = (code: string): string | undefined => {
  try {
    if (code.toLowerCase() === "x-default") return "fallback for other languages";
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const name = names.of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : undefined;
  } catch {
    return undefined;
  }
};

/** Validates the alternates of a page; `pageUrl` and `canonical` both count as "this page". */
export function hreflangReport(
  links: { rel: string; href: string; rawHref?: string; hreflang?: string }[],
  pageUrl: string,
  canonical?: string | null,
): HreflangReport {
  const alternates = links.filter((l) => l.rel.toLowerCase().split(/\s+/).includes("alternate") && l.hreflang !== undefined);
  const selfKeys = new Set([normalizeUrl(pageUrl), ...(canonical ? [normalizeUrl(canonical, pageUrl)] : [])]);
  const entries: HreflangEntry[] = alternates.map((l) => {
    const lang = (l.hreflang ?? "").trim();
    const raw = l.rawHref ?? l.href;
    const problems = hreflangCodeProblems(lang);
    if (!/^https?:\/\//i.test(raw.trim()))
      problems.push({
        level: "warn",
        text: raw.trim().startsWith("//")
          ? "Protocol-relative URL: write the full https:// URL."
          : "Relative URL: Google needs a fully qualified URL (https://…).",
      });
    return { lang, href: l.href, raw, self: selfKeys.has(normalizeUrl(l.href, pageUrl)), name: displayName(lang), problems };
  });
  const problems: HreflangProblem[] = [];
  const byLang = new Map<string, HreflangEntry[]>();
  for (const e of entries) byLang.set(e.lang.toLowerCase(), [...(byLang.get(e.lang.toLowerCase()) ?? []), e]);
  for (const [lang, list] of byLang) {
    if (list.length < 2) continue;
    const urls = new Set(list.map((e) => normalizeUrl(e.href)));
    if (urls.size > 1) {
      const text = `Conflict: ${list[0]!.lang} points to ${urls.size} different URLs.`;
      problems.push({ level: "bad", text });
      for (const e of list) e.problems.push({ level: "bad", text: `Conflicts with another ${lang} entry.` });
    } else {
      problems.push({ level: "warn", text: `Duplicate: ${list[0]!.lang} is listed ${list.length} times.` });
      for (const e of list.slice(1)) e.problems.push({ level: "warn", text: "Duplicate entry." });
    }
  }
  const xDefault = entries.some((e) => e.lang.toLowerCase() === "x-default");
  const selfReference = entries.some((e) => e.self);
  if (entries.length && !selfReference)
    problems.unshift({ level: "warn", text: "No self-reference: the page should list itself among its hreflang alternates." });
  if (entries.length && !xDefault)
    problems.push({ level: "info", text: "No x-default entry — it is the fallback for languages you do not target." });
  const languages = new Set(entries.filter((e) => e.lang.toLowerCase() !== "x-default").map((e) => e.lang.toLowerCase())).size;
  return { entries, xDefault, selfReference, languages, problems };
}

export const RETURN_LINKS_NOTE =
  "Return links from the other language versions can only be verified by requesting those URLs — not checked here.";
