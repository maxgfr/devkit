import type { Check } from "./headers";
import type { MetaSnapshot } from "./page/collect";

export const metaValue = (snap: MetaSnapshot, key: string) => snap.meta.find((m) => m.key.toLowerCase() === key.toLowerCase())?.value;
export const linkHref = (snap: MetaSnapshot, rel: string) => snap.links.find((l) => l.rel.toLowerCase().split(/\s+/).includes(rel))?.href;

export function seoReport(snap: MetaSnapshot): Check[] {
  const out: Check[] = [];
  const add = (id: string, label: string, level: Check["level"], detail: string) => out.push({ id, label, level, detail });
  const len = (s: string | undefined) => (s ?? "").length;

  const title = snap.title.trim();
  add(
    "title",
    "Title",
    !title ? "bad" : len(title) < 10 || len(title) > 60 ? "warn" : "good",
    title ? `${len(title)} chars (aim for 10–60): ${title}` : "Missing",
  );
  const desc = metaValue(snap, "description");
  add(
    "description",
    "Meta description",
    !desc ? "bad" : len(desc) < 50 || len(desc) > 160 ? "warn" : "good",
    desc ? `${len(desc)} chars (aim for 50–160): ${desc}` : "Missing",
  );

  const canonical = linkHref(snap, "canonical");
  if (!canonical) add("canonical", "Canonical", "warn", "No <link rel=canonical>");
  else {
    const same = canonical.split("#")[0] === snap.url.split("#")[0];
    add("canonical", "Canonical", "good", same ? `Self-referencing: ${canonical}` : `Points elsewhere: ${canonical}`);
  }
  const robots = [metaValue(snap, "robots"), metaValue(snap, "googlebot")].filter(Boolean).join(", ");
  add("robots", "Robots meta", /noindex/i.test(robots) ? "bad" : "good", robots ? robots : "Not set (index, follow)");
  add(
    "viewport",
    "Viewport",
    metaValue(snap, "viewport") ? "good" : "bad",
    metaValue(snap, "viewport") ?? "Missing: mobile browsers render at desktop width",
  );
  add("lang", "Language", snap.lang ? "good" : "warn", snap.lang || "No lang on <html>");
  add("charset", "Charset", /utf-8/i.test(snap.charset) ? "good" : "warn", snap.charset);
  add("doctype", "Doctype", /<!DOCTYPE html>/i.test(snap.doctype) ? "good" : "warn", snap.doctype || "Missing: quirks mode");

  const h1 = snap.headings.filter((h) => h.level === 1);
  add(
    "h1",
    "H1",
    h1.length === 1 ? "good" : h1.length ? "warn" : "bad",
    h1.length
      ? `${h1.length} × h1: ${h1
          .map((h) => h.text)
          .join(" | ")
          .slice(0, 160)}`
      : "No h1",
  );

  const og = ["og:title", "og:description", "og:image", "og:url", "og:type"].filter((k) => !metaValue(snap, k));
  add("og", "Open Graph", og.length === 0 ? "good" : og.length > 2 ? "bad" : "warn", og.length ? `Missing ${og.join(", ")}` : "Complete");
  const tw = metaValue(snap, "twitter:card");
  add("twitter", "Twitter / X card", tw ? "good" : "info", tw ? `twitter:card ${tw}` : "Not set (Open Graph is used as fallback)");

  const icon = snap.links.some((l) => /icon/i.test(l.rel));
  add(
    "favicon",
    "Favicon",
    icon ? "good" : "warn",
    icon
      ? snap.links
          .filter((l) => /icon/i.test(l.rel))
          .map((l) => `${l.rel}${l.sizes ? ` ${l.sizes}` : ""}`)
          .join(", ")
      : "No <link rel=icon>: /favicon.ico is requested",
  );
  const alternates = snap.links.filter((l) => l.rel === "alternate" && l.hreflang);
  if (alternates.length) {
    const xDefault = alternates.some((l) => l.hreflang === "x-default");
    add(
      "hreflang",
      "hreflang",
      xDefault ? "good" : "warn",
      `${alternates.length} alternates (${alternates.map((a) => a.hreflang).join(", ")})${xDefault ? "" : ", no x-default"}`,
    );
  }
  add(
    "jsonld",
    "Structured data",
    snap.jsonLd.length || snap.microdataTypes.length ? "good" : "info",
    snap.jsonLd.length
      ? `${snap.jsonLd.length} JSON-LD block(s)`
      : snap.microdataTypes.length
        ? `Microdata: ${snap.microdataTypes.join(", ")}`
        : "None",
  );
  const manifest = linkHref(snap, "manifest");
  add("manifest", "Web app manifest", manifest ? "good" : "info", manifest ?? "None");
  return out;
}

/** Open Graph / Twitter values, with the fallbacks crawlers use. */
export function socialPreview(snap: MetaSnapshot) {
  return {
    title: metaValue(snap, "og:title") ?? metaValue(snap, "twitter:title") ?? snap.title,
    description: metaValue(snap, "og:description") ?? metaValue(snap, "twitter:description") ?? metaValue(snap, "description") ?? "",
    image: metaValue(snap, "og:image") ?? metaValue(snap, "twitter:image"),
    site: metaValue(snap, "og:site_name") ?? new URL(snap.url).hostname,
    card: metaValue(snap, "twitter:card") ?? "summary",
  };
}
