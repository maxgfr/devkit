import { Readability } from "@mozilla/readability";

/** Injected on demand: the page's main content, as Readability sees it. Its return value is the script's result. */
export default defineUnlistedScript(() => {
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone, { charThreshold: 300 }).parse();
  if (article?.textContent && article.textContent.trim().length > 200) {
    return {
      title: article.title ?? document.title,
      byline: article.byline ?? undefined,
      excerpt: article.excerpt ?? undefined,
      text: article.textContent
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
      lang: article.lang ?? document.documentElement.lang,
      readable: true,
    };
  }
  // biome-ignore lint/performance/useDomNodeTextContent: innerText skips hidden text and keeps line breaks
  return { title: document.title, text: document.body?.innerText ?? "", lang: document.documentElement.lang, readable: false };
});
