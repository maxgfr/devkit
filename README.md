# devkit

A Chrome extension for web developers. Everything in one side panel and a command palette:
clear a site's cache and data, inspect what a page ships (tech stack, SEO, **JSON-LD**, headers,
Web Vitals, errors, links…), rewrite requests, a dozen utilities, and **AI analysis of the page
with your own model** through [llm-connect](https://www.npmjs.com/package/llm-connect) and
[llm-models](https://www.npmjs.com/package/llm-models).

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
- Right-click a page or a selection: summarize, explain code, inspect structured data or headers
- **Pop out** (side panel header) opens devkit in its own window, attached to one tab

## Tools

| Tab | Tools |
|---|---|
| Cache | Hard reload · clear this site's cache · fresh start (all site data + reload) · clear cookies · clear local/session storage · unregister service workers · no-cache mode per tab · site data checklist · cookie editor (edit, import/export JSON, flag audit: Secure, HttpOnly on session cookies, SameSite, expiry, size) · Web Storage editor |
| Inspect | Tech stack (frameworks, CMS, analytics, CDN, server) and DOM stats · SEO & meta (checks, social card preview, headings, meta, head links) · **Structured data**: every JSON-LD block parsed and checked against schema.org and Google rich results (required / recommended properties, ISO dates, absolute URLs, prices, currencies, `@id` references, breadcrumb positions, JSON syntax errors with line and column), tree and source views, snippet validator, Rich Results Test / Schema validator links · Performance (LCP, CLS, INP, FCP, TTFB, long tasks, heaviest resources) · Console errors (captured from the first script on every page, count on the toolbar badge) · Link checker · Fonts & colors (eyedropper, palette, contrast) · Accessibility hints · robots.txt tester, sitemap browser, PWA manifest checks · Open in PageSpeed, W3C validator, SSL Labs, securityheaders, Wayback… |
| Security | Headers & security (grade, CSP/HSTS/framing/…, caching, raw headers) · **Secrets scanner**: API keys, tokens and private keys shipped to the browser (inline scripts and JSON blobs, this origin's scripts, HTML comments, meta tags, config globals, Web Storage, readable cookies), masked until revealed, with where each was found; public-by-design keys (Stripe publishable, Firebase config, Supabase anon) shown as such · **Source maps & exposed files**: reachable source maps, and an opt-in probe for `.git`, `.env`, `.DS_Store`, `phpinfo.php`, `security.txt`… checked by content against a random-path baseline · **Third parties & SRI**: requests and bytes per site, cross-origin scripts and stylesheets without `integrity`, `crossorigin` mismatches, mixed content, iframes without `sandbox` · **CSP analyzer**: directive by directive (unsafe-inline, unsafe-eval, wildcards, `strict-dynamic`, missing `object-src`/`base-uri`/`frame-ancestors`, report-only) and a starter policy from the origins the page used |
| Page | Design mode · element outlines · disable CSS · block JavaScript per site · emulation (color scheme, reduced motion, contrast, print, CPU and network throttling, vision deficiencies) · responsive sizes · visible / full-page screenshots · form filler |
| Network | Request rules (set/append/remove request or response headers, redirects with regex, block, CORS unblock) with import/export · environments (local / staging / prod: same path on another env, red ribbon and badge on prod) |
| AI | Summarize · explain the stack · SEO audit · review/write JSON-LD · security headers review · performance advice · accessibility review · explain console errors · explain selected code · write a Playwright test · extract data as JSON · generate meta tags · UI critique from a screenshot (vision models) · free chat with chosen page data · model browser with prices and context windows |
| Utils | JSON (format, tree, TypeScript types, paths) · JWT · Base64/URL/HTML/hex/unicode · SHA hashes, HMAC, SRI · UUID v4/v7, nanoid · timestamps · regex tester · text diff · colors · cron explainer · URL & query params (strip tracking) · QR code |

A **DevTools panel** ("devkit") lists the page's requests with copy as cURL / fetch / HTTPie /
Python, response bodies as JSON trees and HAR export.

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

## Permissions

Asked at install: `activeTab`, `scripting`, `storage`, `sidePanel`, `contextMenus`, and
`declarativeNetRequest` and `debugger` (Chrome does not allow these two to be optional).
`browsingData`, `cookies`, `contentSettings` and host access ("this site" or "all sites") are
optional: devkit asks the first time a tool needs them. The options page lists and revokes them.

## Development

```bash
pnpm check   # biome + tsc + vitest + build
pnpm e2e     # after a build: loads the extension in Chromium and runs every tool against a local test site
```

`src/lib` holds framework-free logic (analyzers, rules, utilities, AI context), tested in `tests/`.
`src/lib/page` holds functions injected into pages: they must not use their enclosing scope.
`src/ui` is the React UI; `src/lib/actions.ts` and `src/lib/panels.ts` register every tool for the
palette, the side panel and the shortcuts.

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
