import type { Category } from "./actions";

/** Side panel views. The popup palette and context menus open them by id. */
export interface PanelDef {
  id: string;
  category: Category;
  title: string;
  /** Label in the side panel's sub-navigation, when the title is too long for a pill. */
  short?: string;
  description: string;
  keywords?: string;
}

export const PANELS: PanelDef[] = [
  {
    id: "cache-actions",
    category: "cache",
    title: "Cache actions",
    short: "Actions",
    description: "Hard reload, clear cache, fresh start, service workers",
    keywords: "reload clear",
  },
  {
    id: "usage",
    category: "cache",
    title: "Storage usage",
    short: "Usage",
    description: "How much this site stores: quota, IndexedDB, Cache Storage, Web Storage, cookies",
    keywords: "storage quota disk size space bytes gb mb indexeddb cache storage opfs persist service worker how much",
  },
  {
    id: "site-data",
    category: "cache",
    title: "Clear site data",
    short: "Clear data",
    description: "Pick what to remove for this origin",
    keywords: "browsing data indexeddb cache storage",
  },
  {
    id: "cookies",
    category: "cache",
    title: "Cookies",
    description: "View, edit, export and import cookies, and audit their flags",
    keywords:
      "cookie editor session audit flags httponly secure samesite cookies.txt netscape curl wget yt-dlp export header partitioned chips",
  },
  {
    id: "storage",
    category: "cache",
    title: "Local & session storage",
    short: "Storage",
    description: "View and edit Web Storage keys",
    keywords: "localstorage sessionstorage",
  },

  {
    id: "overview",
    category: "inspect",
    title: "Overview & tech stack",
    short: "Overview",
    description: "Page report, tech stack, DOM stats",
    keywords: "page report summary score wappalyzer technology framework detect",
  },
  {
    id: "seo",
    category: "inspect",
    title: "SEO & meta",
    short: "SEO",
    description: "Meta lengths, Open Graph / Twitter checklist and share previews, hreflang, indexability, headings",
    keywords:
      "meta tags og open graph twitter card social share preview facebook linkedin whatsapp slack hreflang indexability noindex alt links words",
  },
  {
    id: "headings",
    category: "inspect",
    title: "Headings & landmarks",
    short: "Headings",
    description:
      "h1–h6 and ARIA landmarks as trees: skipped levels, missing h1 or main, hidden headings, badges in the page, table of contents, AI rewrite",
    keywords:
      "headings h1 h2 h3 h4 h5 h6 hn outline hierarchy structure toc table of contents aria-level role heading sections rewrite titles landmarks aria banner navigation main region contentinfo complementary",
  },
  {
    id: "rendered-source",
    category: "inspect",
    title: "Served vs rendered",
    short: "Rendered",
    description: "The HTML the server sends next to the DOM after JavaScript: what crawlers that do not render miss, and a source diff",
    keywords:
      "view source rendered raw html view rendered source javascript seo ssr csr client-side rendering hydration diff crawler googlebot dom",
  },
  {
    id: "jsonld",
    category: "inspect",
    title: "Structured data (JSON-LD)",
    short: "JSON-LD",
    description: "Validate JSON-LD against schema.org and rich results",
    keywords: "schema.org json-ld microdata rich results structured data vocabulary canonical x-robots-tag",
  },
  {
    id: "datalayer",
    category: "inspect",
    title: "dataLayer inspector",
    short: "dataLayer",
    description: "GA4 events, Consent Mode and GTM containers: validation, PII warnings, snapshots",
    keywords:
      "datalayer data layer gtm ga4 google analytics tag manager gtag consent mode events ecommerce purchase transaction_id pii snapshot",
  },
  {
    id: "headers",
    category: "security",
    title: "Headers & security",
    short: "Headers",
    description: "Security grade, caching, raw response headers",
    keywords: "csp hsts security headers cache-control",
  },
  {
    id: "perf",
    category: "inspect",
    title: "Performance",
    description: "Web Vitals, navigation timeline, resource waterfall",
    keywords: "lcp cls inp ttfb fcp web vitals speed waterfall timeline long tasks resources crux field data real users chrome ux report",
  },
  {
    id: "responsiveness",
    category: "inspect",
    title: "Responsiveness",
    short: "Slowness",
    description: "Slow interactions and the scripts behind them, back/forward cache, speculation rules",
    keywords:
      "inp interaction to next paint long animation frames loaf jank main thread blocking script slow click why slow bfcache back forward cache not restored reasons unload speculation rules prefetch prerender",
  },
  {
    id: "errors",
    category: "inspect",
    title: "Console errors",
    short: "Errors",
    description: "JavaScript errors and failed resources",
    keywords: "console error exception rejection",
  },
  {
    id: "links",
    category: "inspect",
    title: "Link checker",
    short: "Links",
    description: "Find broken links on the page",
    keywords: "404 broken links dead",
  },
  {
    id: "fonts",
    category: "inspect",
    title: "Fonts & colors",
    description: "Fonts in use, palette, color picker, contrast",
    keywords: "typography palette eyedropper contrast",
  },
  {
    id: "a11y",
    category: "inspect",
    title: "Accessibility audit",
    short: "A11y",
    description: "axe-core audit against WCAG 2.2 A/AA: violations by impact, failing elements outlined in the page",
    keywords: "a11y accessibility axe wcag rgaa audit alt label contrast aria heading screen reader",
  },
  {
    id: "site-files",
    category: "inspect",
    title: "robots.txt, sitemap, manifest",
    short: "Site files",
    description: "Crawl rules, sitemap URLs, PWA manifest",
    keywords: "robots sitemap pwa manifest crawl",
  },
  {
    id: "repo-deps",
    category: "inspect",
    title: "Repo dependencies",
    short: "Deps",
    description: "Packages a GitHub or GitLab folder declares, with descriptions and registry links",
    keywords:
      "npmhub dependencies package.json npm pypi requirements pyproject poetry cargo crates go.mod composer packagist gemfile rubygems github gitlab repository",
  },
  {
    id: "agent-tools",
    category: "inspect",
    title: "Agent tools (WebMCP)",
    short: "Agent tools",
    description: "WebMCP tools the page exposes to AI agents: schemas, annotations, risk, a safe tester",
    keywords: "webmcp modelcontext model context agent tools mcp ai agents registertool toolname declarative tester",
  },
  {
    id: "agent-readiness",
    category: "inspect",
    title: "Agent readiness",
    short: "Readiness",
    description: "0–100 score for AI agents, llms.txt, ai.txt, AI crawlers in robots.txt, sitemap",
    keywords: "llms.txt ai.txt ai crawlers gptbot claudebot perplexitybot google-extended ccbot robots readiness score agents geo",
  },
  {
    id: "external",
    category: "inspect",
    title: "Open in external tools",
    short: "External",
    description: "PageSpeed, GTmetrix, W3C, WAVE, Facebook and LinkedIn debuggers, Ahrefs, Sistrix, WHOIS…",
    keywords: "pagespeed lighthouse gtmetrix validator w3c css wave facebook debugger linkedin post inspector ahrefs sistrix whois ssl",
  },

  {
    id: "secrets",
    category: "security",
    title: "Secrets scanner",
    short: "Secrets",
    description: "API keys, tokens and private keys shipped to the browser",
    keywords: "secret leak api key token credential aws stripe github jwt supabase firebase",
  },
  {
    id: "exposed",
    category: "security",
    title: "Source maps & exposed files",
    short: "Exposed files",
    description: "Reachable source maps, .git, .env and other files that should not be served",
    keywords: "sourcemap source map .git .env ds_store phpinfo security.txt",
  },
  {
    id: "third-parties",
    category: "security",
    title: "Third parties & SRI",
    short: "Third parties",
    description: "Who the page loads from, integrity, mixed content, iframe sandbox",
    keywords: "third party sri subresource integrity crossorigin mixed content iframe sandbox domains",
  },
  {
    id: "libraries",
    category: "security",
    title: "Vulnerable libraries",
    short: "Libraries",
    description: "Outdated jQuery, AngularJS, Bootstrap, lodash… with known CVEs, from the Retire.js database",
    keywords:
      "retire retire.js cve ghsa vulnerable outdated library libraries dependency jquery angularjs angular bootstrap lodash moment vue react handlebars dompurify end of life eol",
  },
  {
    id: "csp",
    category: "security",
    title: "CSP analyzer",
    short: "CSP",
    description: "Content-Security-Policy directive by directive, and a starter policy",
    keywords: "content security policy csp nonce strict-dynamic unsafe-inline report-only",
  },

  {
    id: "element",
    category: "page",
    title: "Element picker",
    short: "Element",
    description: "Pick an element, copy its component, source and styles for a coding agent",
    keywords: "inspect element react vue svelte angular component props source selector locator agent claude cursor",
  },
  {
    id: "measure",
    category: "page",
    title: "Measure distances",
    short: "Measure",
    description: "Box model, spacing between two elements, drag to measure an area",
    keywords: "ruler spacing distance gap padding margin box model px pixel dimensions visbug page ruler measure",
  },
  {
    id: "assets",
    category: "page",
    title: "Assets",
    description: "Images, SVG, icons and backgrounds: sizes, bytes, alt text, download as zip",
    keywords: "images img svg icons favicon background poster media download zip alt oversized srcset",
  },
  {
    id: "page-tools",
    category: "page",
    title: "Page tools",
    short: "Tools",
    description: "Design mode, outlines, disable CSS or JavaScript",
    keywords: "design mode outline css javascript",
  },
  {
    id: "emulation",
    category: "page",
    title: "Emulation",
    description: "Color scheme, reduced motion, print, CPU and network throttling",
    keywords: "dark mode prefers-color-scheme throttle offline 3g print",
  },
  {
    id: "viewport",
    category: "page",
    title: "Responsive sizes",
    short: "Sizes",
    description: "Resize the window to common viewports",
    keywords: "responsive mobile tablet resize viewport",
  },
  {
    id: "screenshot",
    category: "page",
    title: "Screenshot",
    description: "Visible area or full page",
    keywords: "capture screenshot full page png",
  },
  {
    id: "forms",
    category: "page",
    title: "Form filler",
    short: "Forms",
    description: "Fill every field with plausible test data",
    keywords: "fake data form fill test",
  },

  {
    id: "rules",
    category: "network",
    title: "Request rules",
    short: "Rules",
    description: "Modify headers, redirect, block, unblock CORS",
    keywords: "modheader redirect block cors declarativenetrequest",
  },
  {
    id: "mocks",
    category: "network",
    title: "Mock API responses",
    short: "Mocks",
    description: "Fake the body, status, headers or delay of fetch/XHR calls on this tab",
    keywords: "mock api response fake stub fetch xhr json status delay network error requestly mokku intercept",
  },
  {
    id: "envs",
    category: "network",
    title: "Environments",
    description: "Jump between local, staging and prod; ribbon on prod",
    keywords: "environment staging production localhost switch",
  },

  {
    id: "ask",
    category: "ai",
    title: "Ask AI about the page",
    short: "Ask",
    description: "Analyses and chat with your own model",
    keywords: "llm gpt claude gemini summarize chat",
  },
  {
    id: "report",
    category: "ai",
    title: "Bug report",
    short: "Report",
    description: "Steps, errors, failed requests and environment as Markdown for a coding agent",
    keywords: "bug issue repro reproduce steps recorder jam ticket agent claude cursor playwright failed requests errors",
  },
  {
    id: "models",
    category: "ai",
    title: "Model browser",
    short: "Models",
    description: "Search models, prices and context windows",
    keywords: "llm models price context openrouter models.dev",
  },
  {
    id: "ai-settings",
    category: "ai",
    title: "AI settings",
    short: "Settings",
    description: "Provider, model, API key, local servers",
    keywords: "api key ollama lm studio provider",
  },

  {
    id: "json",
    category: "utils",
    title: "JSON",
    description: "Format, validate, tree, TypeScript types, paths",
    keywords: "json formatter prettify validate typescript",
  },
  {
    id: "jwt",
    category: "utils",
    title: "JWT decoder",
    short: "JWT",
    description: "Header, payload and expiry of a token",
    keywords: "jwt token bearer decode",
  },
  {
    id: "encode",
    category: "utils",
    title: "Encode / decode",
    short: "Encode",
    description: "Base64, URL, HTML entities, hex, unicode",
    keywords: "base64 urlencode html entities hex",
  },
  {
    id: "hash",
    category: "utils",
    title: "Hash & SRI",
    short: "Hash",
    description: "SHA-1/256/384/512, HMAC, subresource integrity",
    keywords: "sha256 hash hmac sri integrity",
  },
  {
    id: "ids",
    category: "utils",
    title: "UUID & IDs",
    short: "UUID",
    description: "UUID v4 / v7, nanoid, inspect a UUID",
    keywords: "uuid guid nanoid v7",
  },
  {
    id: "time",
    category: "utils",
    title: "Timestamps",
    short: "Time",
    description: "Unix ↔ ISO date, relative time",
    keywords: "epoch unix timestamp date",
  },
  {
    id: "regex",
    category: "utils",
    title: "Regex tester",
    short: "Regex",
    description: "Matches and groups, live",
    keywords: "regexp regular expression",
  },
  {
    id: "diff",
    category: "utils",
    title: "Text diff",
    short: "Diff",
    description: "Compare two texts line by line",
    keywords: "compare diff",
  },
  {
    id: "color",
    category: "utils",
    title: "Color converter",
    short: "Color",
    description: "HEX, RGB, HSL and WCAG contrast",
    keywords: "color hex rgb hsl contrast",
  },
  {
    id: "cron",
    category: "utils",
    title: "Cron explainer",
    short: "Cron",
    description: "Plain English and next runs",
    keywords: "cron crontab schedule",
  },
  {
    id: "url",
    category: "utils",
    title: "URL & query params",
    short: "URL",
    description: "Edit the current URL's parts and parameters",
    keywords: "query string params utm",
  },
  {
    id: "qr",
    category: "utils",
    title: "QR code",
    short: "QR",
    description: "QR code of the current URL or any text",
    keywords: "qr code mobile",
  },
];

export const PANEL_IDS = new Set(PANELS.map((p) => p.id));

export interface Route {
  panel: string;
  /** Extra state for the panel, such as an AI action and a selection. */
  params?: Record<string, string>;
}

export const PENDING_ROUTE_KEY = "pendingRoute";
