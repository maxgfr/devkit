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
    description: "View, edit, delete, export and import cookies",
    keywords: "cookie editor session",
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
    description: "Frameworks, hosting, analytics, DOM stats",
    keywords: "wappalyzer technology framework detect",
  },
  {
    id: "seo",
    category: "inspect",
    title: "SEO & meta",
    short: "SEO",
    description: "Title, description, canonical, Open Graph, headings",
    keywords: "meta tags og twitter card headings",
  },
  {
    id: "jsonld",
    category: "inspect",
    title: "Structured data (JSON-LD)",
    short: "JSON-LD",
    description: "Validate JSON-LD against schema.org and rich results",
    keywords: "schema.org json-ld microdata rich results structured data",
  },
  {
    id: "headers",
    category: "inspect",
    title: "Headers & security",
    short: "Headers",
    description: "Security grade, caching, raw response headers",
    keywords: "csp hsts security headers cache-control",
  },
  {
    id: "perf",
    category: "inspect",
    title: "Performance",
    description: "Web Vitals, timings, heaviest resources",
    keywords: "lcp cls inp ttfb web vitals speed",
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
    short: "Fonts & colors",
    description: "Fonts in use, palette, color picker, contrast",
    keywords: "typography palette eyedropper contrast",
  },
  {
    id: "a11y",
    category: "inspect",
    title: "Accessibility hints",
    short: "A11y",
    description: "Quick checks: alt, labels, names, headings",
    keywords: "a11y wcag rgaa alt label",
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
    id: "external",
    category: "inspect",
    title: "Open in external tools",
    short: "External",
    description: "PageSpeed, validators, SSL Labs, Wayback…",
    keywords: "pagespeed lighthouse validator w3c ssl",
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
