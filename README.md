# devkit

A Chrome extension for web developers. Everything in one side panel and a command palette:
clear a site's cache and data, inspect what a page ships (tech stack, SEO, **JSON-LD**, headers,
Web Vitals, errors, links…), rewrite requests, a dozen utilities, and **AI analysis of the page
with your own model** through [llm-connect](https://www.npmjs.com/package/llm-connect) and
[llm-models](https://www.npmjs.com/package/llm-models).

Every panel that finds a problem has **Copy for agent**: a Markdown report a coding agent (Claude Code,
Cursor, Copilot…) can act on, with what is wrong, where (selector, JSON path, header, script, cookie
name), the exact fix and how to check it. Overview copies **one fix list for the whole page**. Secrets
stay masked and cookie values are left out.

[Chrome Web Store](https://chromewebstore.google.com/detail/devkit/jbiemmlhdehncfkapmhlnkcimpfihnba) · Site: <https://maxgfr.github.io/devkit/> (sources in `site/`, deployed by `.github/workflows/pages.yml`) · [Privacy policy](https://maxgfr.github.io/devkit/privacy.html).

## Install

**From the [Chrome Web Store](https://chromewebstore.google.com/detail/devkit/jbiemmlhdehncfkapmhlnkcimpfihnba)** (recommended): click *Add to Chrome*. Chrome updates devkit on its own.

**From a release** (no build needed):

1. Download `devkit-<version>-chrome.zip` from the [latest release](https://github.com/maxgfr/devkit/releases/latest) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
3. To update, unzip the new release over the same folder and click the reload icon on devkit's card.

**From source**:

```bash
pnpm install
pnpm build          # → .output/chrome-mv3, then Load unpacked as above
pnpm dev            # Chrome with the extension and hot reload
```

Chrome 116 or later.

- **Alt+Shift+D** opens the command palette (type `json-ld`, `jwt`, `fresh`…)
- **Alt+Shift+S** opens the side panel, **Alt+Shift+X** clears the site's data and hard reloads
- Right-click a page or a selection: summarize, explain code, inspect structured data or headers, pick an element, write a bug report
- **Pop out** (side panel header) opens devkit in its own window, attached to one tab

## Tools

| Tab | Tools |
|---|---|
| Cache | **Storage usage**: how much the site keeps on the device (quota, usage by kind, persistent or best-effort), IndexedDB databases with their stores and record counts, Cache Storage caches with entries and sizes, OPFS files, the largest localStorage keys, cookies, service workers, a Markdown report · Hard reload · clear this site's cache · fresh start (all site data + reload) · clear cookies · clear local/session storage · unregister service workers · no-cache mode per tab · site data checklist · cookie editor (edit, add, delete, flag audit: Secure, HttpOnly on session cookies, SameSite, expiry, size) · **cookies.txt export** like "Get cookies.txt LOCALLY": this site's cookies as Netscape cookies.txt for curl, wget and yt-dlp (`#HttpOnly_` lines, session cookies at expiry 0), JSON or a `Cookie` header string, to copy, download or save where you pick; export all cookies of every site (asks for all-sites access, since Chrome only lists cookies of sites devkit can reach); a table view of the cookies.txt fields with a nowrap toggle; partitioned (CHIPS) cookies included and marked; import JSON or cookies.txt; "Copy cookies.txt" in the palette · Web Storage editor · **IndexedDB**: databases, object stores (key path, autoIncrement, indexes with unique / multiEntry, record counts) and records page by page, through the primary key or an index, filtered by an exact key or a text prefix; a record as a tree, edited as JSON with Date, Map, Set, BigInt, Blob, typed arrays… kept as `$type` tags and written back as they were, add, delete, clear a store, delete a database (confirmed in the panel), export a store as JSON · **Cache Storage**: service worker caches and their requests with status, content type and size, an entry's headers and body (JSON as a tree, text, image preview; opaque responses marked), delete an entry or a cache, export a cache as JSON |
| Inspect | Tech stack (frameworks, CMS, analytics, CDN, server) and DOM stats · **SEO & meta**: a counters strip (issues, words, headings, images with missing alt, internal · external links), the issues (share of images without alt, title and description too short or long with their length, Open Graph tags still worth adding, hreflang problems), PageSpeed / W3C links, Copy report and Copy for agent; meta lengths against their limits (title 60, description 160, og:title 88, og:description 200); the Open Graph / Twitter checklist (essential and recommended tags, Twitter tags covered by Open Graph shown as fallbacks) and its mistakes (og:url not the canonical, relative or http:// og:image, `name="og:…"` instead of `property=`, unknown `twitter:card`); share previews for Facebook, LinkedIn, X, WhatsApp and Slack with each network's layout, image ratio and approximate truncation, the image requested only after **Load preview image**, then checked on the measured file (below 1200×630, below 200 px, odd ratio, `og:image:width` / `height` that do not match); an hreflang table with BCP-47 checks (`de_AT`, `en-UK`, a country code used as a language), self-reference, x-default, duplicates, conflicting targets and relative URLs; images and links (total, missing alt, without title, internal, external, unique, nofollow); indexability (meta robots and `X-Robots-Tag`, robots.txt for Googlebot, HTTP status); a searchable headings list and the meta and head links · **Headings & landmarks**: every h1–h6 and `role="heading"` as a tree, with what a screen reader gets (visually hidden, `aria-hidden`, hidden) and the problems (no h1 or several, headings before the h1, skipped levels shown as gaps, empty or overlong headings, `role="heading"` without `aria-level`, duplicates, empty sections); a **Landmarks** view of the ARIA landmarks as browsers map the HTML (banner, navigation, main, region, complementary, contentinfo, search, form), listed HeadingsMap-style as `Breadcrumbs [navigation]`, with their problems (no main or several, several top-level banners or contentinfos, same-role landmarks without distinct names, hidden landmarks, redundant `role`, headings outside every landmark), and an All view with each landmark's headings nested under it, Expand all / Collapse all; click a heading or landmark to find it in the page, level or landmark badges drawn on the page, a page map of where the headings fall and how many words each section holds, a table of contents to copy as Markdown or HTML (ids proposed where missing), Copy for agent and AI help (review the outline, rewrite the headings, check them against their sections, find missing sections, or ask about one heading) · **Structured data**: page URL, canonical, robots meta and `X-Robots-Tag` at a glance; every JSON-LD block (`@graph`, arrays, nested nodes) parsed and validated in two modes, Rich Results (Google's required / recommended properties) or Schema.org (the vocabulary, checked locally: unknown types and properties with "Did you mean…?", properties on the wrong type, nested values of the wrong type, invalid enumeration values such as `InStok`, superseded terms such as `serviceArea` → `areaServed`), plus value formats in both (ISO 8601 dates and durations with the fix, prices with a comma or currency sign, `priceCurrency` not ISO 4217, relative URLs or URLs with spaces, `@id` references, breadcrumb positions, JSON syntax errors with line and column); a Valid / Warning / Error badge per block (Experimental for pending Schema.org terms, Not supported for types Google dropped from rich results), identical findings grouped as ×N, search with highlighted matches, code or tree view (blocks open on the one you pick, findings folded below), Copy JSON, Copy `<script>` tag, Download, a schema.org link per type, snippet validator, Rich Results Test / Schema validator links · **dataLayer inspector**: the page's GA4 events, gtag commands, Consent Mode and GTM containers (`dataLayer` and the other names GTM reads, container ids from `google_tag_manager` and the tag scripts), read without the console and without touching the page (`dataLayer.push` is never wrapped): counters for issues, events, unique events, entries, consent commands and containers; GA4 checks (purchase or refund without `transaction_id`, `value` sent as a string or not numeric like `"129,00"`, value 0, `currency` missing or not ISO 4217, `items[]` missing or items without `item_id` / `item_name`, ecommerce not cleared between pushes, invalid or reserved event names, events fired twice and transactions sent twice, legacy Universal Analytics structure and `UA-` tags); Consent Mode v2 (no `ad_user_data` / `ad_personalization` in the default, update without or before the default, default after tags, values other than granted / denied, `wait_for_update`) with a consent timeline; e-mails, phone numbers, IBANs (mod-97) and card numbers (Luhn) reported by path, never by value, and always masked, in the JSON view, copies and snapshots too (heuristics); price, currency and SKU of `items[]` checked against the JSON-LD Product; every entry as a tree with a filter; up to 50 masked snapshots kept on the device, compared with each other or with the current read (added, removed, duplicated, changed events); Copy report and Copy for agent · a **page report** at the top of Overview (security grade, SEO, headings, JSON-LD, errors, accessibility, Web Vitals, landmarks, dataLayer, agent readiness score, each opening its panel; Copy for agent, and Print / Save as PDF: a print-ready page rendered locally, nothing uploaded) · Performance (Web Vitals on their good / poor scales, navigation timeline, bytes by type, request waterfall, long tasks) · **Responsiveness** (why it is slow): record while you use the page, then the slowest interactions split into input delay / handlers / paint against INP's thresholds, the scripts that ran in each (Long Animation Frames: function, file, character offset turned into line:column, invoker, forced layout), script time per file, suggestions labeled as heuristics and a copy as Markdown for a coding agent; back/forward cache test with Chrome's not-restored reasons explained; speculation rules (inline and `Speculation-Rules` header) and whether the page was prerendered or prefetched · Console errors (captured from the first script on every page, count on the toolbar badge) · Link checker · Fonts & colors (eyedropper, palette, contrast) · **Accessibility audit** with [axe-core](https://github.com/dequelabs/axe-core) (WCAG 2.0/2.1/2.2 A and AA, optional best practices and AAA, whole page or one region): violations by impact, needs-review items, each failing element outlined in the page on click, WCAG criteria and Deque's fix guide, Copy for agent / Ask AI · robots.txt tester, sitemap browser, PWA manifest checks · **Repo dependencies** (like [npmhub](https://github.com/npmhub/npmhub), beyond npm): on a GitHub or GitLab repository or folder page (github.com, gitlab.com, GitHub Enterprise, self-hosted GitLab), the packages its `package.json` (dependencies, dev, peer, optional, workspaces), `requirements*.txt`, `pyproject.toml` (PEP 621, dependency groups, Poetry), `Cargo.toml` (workspaces, targets, renames), `go.mod` (indirect marked), `composer.json` and `Gemfile` declare, read with your session so private repositories work, grouped by kind with the requested version, the latest one and the registry's description (npm, PyPI, crates.io, Packagist, RubyGems; Go gets links only), links to npmjs, BundlePhobia, PackagePhobia, npmgraph, UNPKG, PyPI, crates.io, docs.rs, pkg.go.dev, Packagist and RubyGems, a filter and Copy as Markdown; optionally the same list in a box below the README on github.com and gitlab.com · **Agent tools (WebMCP, experimental)**: the tools a page exposes to AI agents through `document.modelContext` (and the earlier `navigator.modelContext` / `navigator.modelContextTesting` of Chrome's early preview) or `<form toolname>`, each with its description, input and output schemas and annotations, a static analysis (naming, description, schema problems, contradictory annotations) and a Low / Medium / High / Critical risk class (heuristic), and a tester that builds a form from the input schema: Low runs on one click, Medium asks once, High asks twice (the second time by typing the tool's name), Critical is blocked unless allowed for the site for the session; declarative forms are filled, never submitted; a local history of the last 20 runs per site with sensitive arguments masked · **Agent readiness**: a local, transparent 0–100 score (heuristic) over structured data 25, tool availability 15, tool descriptions 15, input schemas 15, safety 15, testability 10, accessibility & semantics 5, every rule shown on tap, recommendations by High / Medium / Low impact, `/llms.txt` and `/llms-full.txt`, `/ai.txt` (AI training opt-out), the sitemap, and which AI crawlers robots.txt allows or blocks (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, Google-Extended, CCBot, PerplexityBot, Applebot-Extended, Bytespider, Amazonbot, Meta-ExternalAgent…), with Copy report and Copy for agent · **Served vs rendered**: the HTML the server sends (the page's URL fetched again from the page, with its cookies: a re-fetch, so a personalized or A/B-tested page can answer differently) next to the DOM after JavaScript, both parsed without running scripts and compared on what crawlers read: title, meta description, meta robots, canonical, `<html lang>`, hreflang, Open Graph / Twitter tags, JSON-LD (compared as parsed JSON), h1–h6, links (internal / external, rel), images and word count; ranked findings (heuristics) such as noindex only in the served HTML, canonical only after JavaScript or changed by it, most of the text rendered by JavaScript, share tags only after JavaScript, JSON-LD injected by JavaScript, links only after JavaScript; a field-by-field table, the lists of what JavaScript added or removed, and both sources pretty-printed the same way with a folded line diff, copy and download of each side (5 MB cap per side, 3,000 lines drawn), Copy for agent · Open in external tools, by group: Rich Results Test and Schema.org validator; PageSpeed Insights, GTmetrix (the URL is copied to paste) and WebPageTest; W3C HTML, W3C CSS and WAVE; Facebook Sharing Debugger, LinkedIn Post Inspector and opengraph.xyz; Ahrefs Site Explorer (signed in), Sistrix, WHOIS, DNS, BuiltWith and Wayback; securityheaders, Mozilla Observatory and SSL Labs |
| Security | Headers & security (grade, CSP/HSTS/framing/…, caching, raw headers with search, Copy all and Copy report) · **Secrets scanner**: API keys, tokens and private keys shipped to the browser (inline scripts and JSON blobs, this origin's scripts, HTML comments, meta tags, config globals, Web Storage, readable cookies), masked until revealed, with where each was found; public-by-design keys (Stripe publishable, Firebase config, Supabase anon) shown as such · **Source maps & exposed files**: reachable source maps, and an opt-in probe for `.git`, `.env`, `.DS_Store`, `phpinfo.php`, `security.txt`… checked by content against a random-path baseline · **Third parties & SRI**: requests and bytes per site, cross-origin scripts and stylesheets without `integrity`, `crossorigin` mismatches, mixed content, iframes without `sandbox` · **Vulnerable libraries**: jQuery, jQuery UI, AngularJS, Angular, Bootstrap, Vue, React, Lodash, Moment, Handlebars, DOMPurify… found by their version globals, script URLs and file names (CDN paths included) and the banners of the site's own scripts, matched against a bundled [Retire.js](https://github.com/RetireJS/retire.js) database: advisories with severity, CVE / GHSA links and fixed-in version, the first clean release to upgrade to, end-of-life notes (AngularJS 1.x, Vue 2, jQuery 1–2, Bootstrap 3), Copy for agent; detection by version only · **CSP analyzer**: directive by directive (unsafe-inline, unsafe-eval, wildcards, `strict-dynamic`, missing `object-src`/`base-uri`/`frame-ancestors`, report-only) and a starter policy from the origins the page used |
| Page | **Element picker**: click an element, get its React / Vue / Svelte / Angular component stack with file:line (dev builds), props, a unique selector, a Playwright locator, trimmed HTML, the computed styles that matter and a cropped screenshot, then **Copy for agent** (Markdown for Claude Code, Cursor…) or ask your AI about it · **Measure distances**: hover for the box model (content, padding, border, margin with px values, size and font), click two elements for the gap between them, Alt for the distance to the parent, drag to measure an area; the panel keeps the last measurement with **Copy** (CSS values) and **Copy for agent** (expected value and a note) · **Assets**: every image, inline SVG, background image, video poster, favicon, manifest icon and social image, with thumbnails, intrinsic vs displayed size ("served 8× larger than displayed"), bytes by type, missing alt text and broken files; open, copy the URL or the SVG markup, download one or all as a zip · design mode · element outlines · disable CSS · block JavaScript per site · emulation (color scheme, reduced motion, contrast, print, CPU and network throttling, vision deficiencies) · responsive sizes · visible / full-page screenshots · form filler |
| Network | Request rules (set/append/remove request or response headers, redirects with regex, block, CORS unblock) with import/export · **Mock API responses**: fake the body, status, headers or delay of matching fetch/XHR calls, or make them fail like a network error, on the tabs you turn it on for (Chrome debugger, keeps working with the panel closed), a live log of the tab's requests with a count on the panel, a mock from any logged request or from a URL's real response, JSON editor with validation, import/export · environments (local / staging / prod: same path on another env, red ribbon and badge on prod) |
| AI | **Bug report for a coding agent** (no model needed): your description, an opt-in recorder that turns clicks, typing (values masked), Enter / Escape and navigations into numbered steps and a Playwright test, console errors, failed and slow requests (Resource Timing status), environment (browser, viewport, DPR, color scheme, language), Web Vitals, tech stack, the picked element, a storage summary and optional page text and DOM, as Markdown or JSON with keys and tokens redacted, plus a viewport screenshot to paste; one-click "Copy a bug report" in the palette · Fix plan for the whole page (every finding ranked, each with its fix) · Summarize · explain the stack · SEO audit · heading outline review, heading rewrite, headings vs their sections, missing sections · review/write JSON-LD · security headers review · performance advice · accessibility review · explain console errors · explain selected code · write a Playwright test · extract data as JSON · generate meta tags · UI critique from a screenshot (vision models) · free chat with chosen page data (landmarks, the dataLayer with personal data masked and agent readiness included) · model browser with prices and context windows |
| Utils | JSON (format, tree, TypeScript types, paths) · **JSON page viewer**: JSON documents opened in a tab (API responses, `.json` files) as a collapsible, syntax-colored tree with item counts, clickable URLs, click a key to copy its path, filter on keys and values, Parsed / Raw, wrap, copy and download; invalid JSON shows the line and column, very large documents (10 MB+) open raw until you ask; on every JSON page once turned on in the options, or on demand with "Format this JSON page" in the palette · JWT · Base64/URL/HTML/hex/unicode · SHA hashes, HMAC, SRI · UUID v4/v7, nanoid · timestamps · regex tester · text diff · colors · cron explainer · URL & query params (strip tracking) · QR code |

A **DevTools panel** ("devkit") lists the page's requests with copy as cURL / fetch / HTTPie /
Python, response bodies as JSON trees and HAR export. Its **GraphQL** view lists every operation
the page sends (POST JSON, batches, automatic persisted queries by hash or id, GET, `application/graphql`
bodies, multipart uploads) with its name, type, status, errors, duration, size and endpoint; filter by
name and type, then read the query pretty-printed, the variables and the response as trees with the
errors (message, path, code) on top, and copy the query, the variables or the request as cURL / fetch.
Subscriptions over WebSocket are not part of the HAR, so they are not listed.

## AI

Settings (AI tab or the options page) use llm-connect's settings store: any provider of the
llm-models catalog (OpenAI, Anthropic, Google, Mistral and every OpenAI-compatible one), or a
local server (Ollama, LM Studio, Jan). The key is encrypted at rest with `secureStorage`
(AES-GCM under a non-extractable key) and sent only to the provider. Calls stream from the side
panel with `callOptions` / `callProblem` / `resolveCapabilities` (effort levels, web search when
the model has it); limits and prices come from llm-models. Page data is trimmed to the model's
context window and treated as untrusted in the system prompt.

Ollama refuses unknown origins: start it with `OLLAMA_ORIGINS=chrome-extension://*`.

`public/models.json` is the offline fallback catalog; refresh it with `pnpm catalog`.

## Vulnerable libraries database

`public/vuln-db.json` is a trimmed snapshot of the [Retire.js](https://github.com/RetireJS/retire.js)
vulnerability repository (`repository/jsrepository.json`, Copyright 2018 Erlend Oftedal, Apache
License 2.0); the commit and date it comes from are in the file and shown in the panel. Refresh it
with `pnpm vuln-db` (`scripts/vuln-db.mjs`): it drops file hashes, keeps patterns, ranges, severities,
CVE / GHSA ids and summaries, and turns Retire's `func` extractors into plain property paths that
the page script reads (no expression from the data is ever evaluated). The Apache-2.0 license, the
Retire.js notice and the list of changes ship next to it in `public/vuln-db.LICENSE.txt`. Matching
runs locally; nothing about the page is sent anywhere.

## Schema.org vocabulary

`public/schema-vocab.json` is a trimmed snapshot of the [Schema.org](https://schema.org) vocabulary
(`schemaorg-current-https.jsonld` of the release named in the file, with its date, and shown in the
Structured data panel). Refresh it with `pnpm schema-vocab` (`scripts/schema-vocab.mjs`, optionally
with a release number): it keeps each type with its direct parents, each property with its domain and
range, enumeration members, superseded terms and the pending flag, and drops comments, labels and
mappings to other vocabularies. Schema.org is licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) by its sponsors (Google, Yahoo,
Microsoft and Yandex); the attribution and the list of changes ship next to it in
`public/schema-vocab.LICENSE.txt`, and the derived file is shared under the same license. The checks
run locally; the vocabulary is loaded only when the Structured data checks need it.

## Permissions

Asked at install: `activeTab`, `scripting`, `storage`, `sidePanel`, `contextMenus`, and
`declarativeNetRequest` and `debugger` (Chrome does not allow these two to be optional).
`browsingData`, `cookies`, `contentSettings` and host access ("this site" or "all sites") are
optional: devkit asks the first time a tool needs them. The options page lists and revokes them.
Formatting every JSON page automatically (Options › JSON viewer) needs access to all sites; the
palette's "Format this JSON page" works on the current tab through `activeTab`, without it.
The Dependencies box on GitHub / GitLab pages (off by default, turned on in Options or Inspect › Repo
dependencies) asks for `https://github.com/*` and `https://gitlab.com/*` only, not all sites. Package
descriptions come from registries that allow any origin to read them, so they need no permission.

## Development

```bash
pnpm check   # biome + tsc + vitest + build
pnpm e2e     # after a build: loads the extension in Chromium and runs every tool against a local test site
```

`src/lib` holds framework-free logic (analyzers, rules, utilities, AI context), tested in `tests/`.
`src/lib/page` holds functions injected into pages: they must not use their enclosing scope.
`src/ui` is the React UI; `src/lib/actions.ts` and `src/lib/panels.ts` register every tool for the
palette, the side panel and the shortcuts.

## Third-party code

devkit bundles [axe-core](https://github.com/dequelabs/axe-core) (© Deque Systems, [MPL-2.0](https://www.mozilla.org/MPL/2.0/)),
unmodified, in `axe-audit.js`: it is injected only when an accessibility audit runs. Its source is on GitHub
and npm. Other dependencies are listed in `package.json`.

## Releases

Releases are automatic. On every push to `main`, CI runs lint, types, unit tests, the build and the
end-to-end test, then `scripts/next-version.ts` reads the [Conventional Commits](https://www.conventionalcommits.org/)
since the last `v*` tag:

| Commits since the last release | Release |
|---|---|
| `fix:` or `perf:` | patch (0.1.0 → 0.1.1) |
| `feat:` | minor (0.1.1 → 0.2.0) |
| `feat!:`, `fix!:` or a `BREAKING CHANGE:` footer | major (minor before 1.0) |
| only `docs:`, `ci:`, `chore:`, `test:`, `refactor:`, `style:` | none |

A release builds the zip with that version, publishes it as a GitHub release with generated notes,
and, once the Chrome Web Store variables and secrets are set, uploads it to the store and submits it for review.
The version lives in the git tags; `package.json` is not bumped. Store listing texts, images and
the API setup are in [`store/`](store/README.md).
