# Chrome Web Store

Everything the store listing needs, and how releases reach the store once it exists.

- `screenshots/`: five 1280×800 screenshots, in upload order.
- `promo-small-440x280.png`: small promo tile.
- `icon-128.png`: store icon (same as the extension's).
- Privacy policy: https://maxgfr.github.io/devkit/privacy.html

Regenerate the images with `pnpm store-assets` after updating the screenshots in `site/img/`.

## 1. First submission (by hand, once)

Chrome does not let an extension or a script create a store item, so the first version goes through the
[developer dashboard](https://chrome.google.com/webstore/devconsole):

1. **Add new item** and upload `devkit-<version>-chrome.zip` from the [latest release](https://github.com/maxgfr/devkit/releases/latest).
2. **Store listing**: paste the texts below, pick the category and language, upload the images from this folder.
3. **Privacy**: paste the single purpose, the permission justifications and the data usage answers below.
4. **Distribution**: Public (or Unlisted to test first), all regions.
5. **Submit for review.** The `debugger` permission usually means an in-depth review: count a few days.

## 2. Listing texts

**Name**: devkit

**Summary** (from the manifest, 127 / 132 characters):
Dev toolbox: clear a site's cache and data, inspect the page, rewrite requests, utilities, and AI analysis with your own model.

**Category**: Developer Tools · **Language**: English

**Description**:

```
devkit puts the tools a web developer keeps installing into one Chrome side panel, reachable from a command palette (Alt+Shift+D).

CACHE & STORAGE
• Hard reload, clear this site's cache, or a "fresh start" that clears every kind of site data for the origin and reloads
• Turn the HTTP cache off for one tab
• Edit cookies, localStorage and sessionStorage in place; export and import cookies as JSON
• Unregister service workers

INSPECT
• Tech stack detection (frameworks, CMS, analytics, CDN, server)
• SEO and meta: title and description lengths, canonical, robots, hreflang, Open Graph and Twitter cards, heading outline
• Structured data (JSON-LD) analyzer: invalid JSON with its line and column, wrong prices, relative URLs, missing recommended fields
• Response headers with a security grade (CSP, HSTS, framing, referrer policy, COOP/COEP, cookie flags) and what the caching headers do
• Web Vitals and the heaviest resources
• Console errors captured from page load, with a count on the toolbar badge
• Link checker, robots.txt, sitemap and web app manifest checks, fonts and colors, quick accessibility hints

PAGE
• Design mode, element outlines, CSS off, JavaScript off for a site
• Emulate dark/light, reduced motion, contrast, print, CPU and network throttling, vision deficiencies
• Responsive window sizes, full-page screenshots, a form filler with plausible fake data

NETWORK
• Request rules: add or remove headers, redirect (prod assets to localhost), block, CORS for localhost
• Environment groups: jump between local, staging and prod on the same path, with a red ribbon on prod

AI, WITH YOUR OWN MODEL
• Summaries, SEO and security reviews, structured data reviews, error explanations, generated Playwright tests, and a chat about the page
• Fed with what the inspectors found, so answers cite the page's actual data
• Works with any provider of the llm-models catalog (OpenAI, Anthropic, Google, Mistral and more) or a local server (Ollama, LM Studio, Jan)
• Your key stays in your browser, encrypted. Token counts and a cost estimate are shown for every answer

UTILITIES
JSON formatter and JSON → TypeScript, JWT decoder, Base64 / URL / HTML entities, hashes and SRI, UUID v4/v7, timestamps, regex tester, text diff, color converter, cron explainer, URL params editor, QR code.

DEVTOOLS PANEL
Copy any request as cURL, fetch, HTTPie or Python; export HAR.

No account, no server, no tracking. Optional permissions are asked only when a tool needs them.
Source: https://github.com/maxgfr/devkit
```

## 3. Privacy tab

**Single purpose**:
devkit is a toolbox for web developers to inspect, debug and test the web page open in the current tab: clear its cache and site data, check what it ships (headers, structured data, SEO, performance, errors), emulate conditions, rewrite its requests, and analyze it with an AI model the developer configures.

**Permission justifications**:

| Permission | Justification |
|---|---|
| activeTab | Runs the tool the developer picks (from the popup, a shortcut or the context menu) on the tab they are on. |
| scripting | Injects devkit's own bundled scripts into the current page to read its metadata, JSON-LD, performance entries and storage, and to apply page tools (design mode, outlines, CSS off, form filler). No remote code. |
| storage | Keeps settings, request rules, environment groups and the last opened tool on the device. |
| sidePanel | The extension's main interface is a side panel next to the page. |
| contextMenus | Right-click entries: ask the AI about a selection or the page, open the JSON-LD and headers tools. |
| declarativeNetRequest | Applies the request rules the developer writes (add/remove headers, redirects, blocks, CORS for localhost) and the per-tab "disable cache" rule. |
| debugger | Uses the Chrome DevTools Protocol, only when the developer turns emulation on or takes a full-page screenshot: emulates color scheme, reduced motion, contrast, print media, CPU and network throttling and vision deficiencies, and captures the full page. It detaches when they stop. |
| browsingData (optional) | Clears the cache, cookies and storage of the current site only, when asked. |
| cookies (optional) | The cookie editor: list, edit, delete, export and import the current site's cookies. |
| contentSettings (optional) | The "JavaScript off for this site" toggle. |
| Host permissions (optional, all sites) | Asked on first use: lets the panel follow the developer across tabs, fetch the page's headers, robots.txt and sitemap, check its links, capture console errors from page load, and show environment ribbons. |

**Remote code**: No, I am not using remote code. All JavaScript is bundled in the package.

**Data usage**: tick **Website content** (page text, metadata and errors are sent to the AI provider the user configured, only when they run an AI action) and **Authentication information** (the user's own AI provider key, stored encrypted on the device and sent only to that provider). Then certify the three statements: data is not sold, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL**: https://maxgfr.github.io/devkit/privacy.html

## 4. Automatic store releases

After the item exists, the `release` job of `.github/workflows/ci.yml` uploads every new release to the store and submits it for review.
It needs, in the repository's **Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
|---|---|---|
| `CWS_PUBLISHER_ID` | variable | the ID in the dashboard URL (`/devconsole/<publisher id>`) |
| `CWS_EXTENSION_ID` | variable | the item's ID, shown in the dashboard after the first upload |
| `CWS_CLIENT_ID` | secret | OAuth client ID |
| `CWS_CLIENT_SECRET` | secret | OAuth client secret |
| `CWS_REFRESH_TOKEN` | secret | refresh token for that client |

Until `CWS_EXTENSION_ID` is set, the store step is skipped and releases stop at GitHub.

To get the OAuth values ([Google's guide](https://developer.chrome.com/docs/webstore/using-api)):

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Chrome Web Store API**.
2. Configure the OAuth consent screen (External, add yourself as a test user), then create an **OAuth client ID** of type *Web application* with `https://developers.google.com/oauthplayground` as redirect URI.
3. In the [OAuth Playground](https://developers.google.com/oauthplayground), open the settings, tick *Use your own OAuth credentials*, paste the client ID and secret, authorize the scope `https://www.googleapis.com/auth/chromewebstore`, then exchange the code for tokens and copy the refresh token.
4. Save the three values as secrets: `gh secret set CWS_CLIENT_ID`, `gh secret set CWS_CLIENT_SECRET`, `gh secret set CWS_REFRESH_TOKEN` (each prompts for the value), and the item ID with `gh variable set CWS_EXTENSION_ID --body <id>`.

To publish one zip by hand with the same values in the environment: `node scripts/publish-cws.ts .output/devkit-<version>-chrome.zip`.
