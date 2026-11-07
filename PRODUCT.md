# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Web developers (front-end and full-stack) working in Chrome on their own sites, client sites and local dev servers. Their job: debug what a page ships and how it behaves (cache, storage, headers, structured data, performance, errors), tweak requests while developing, and get a second opinion on a page fast. *(Inferred from the original request "je suis dev… des trucs de dev qui peuvent être utiles"; the audience question went unanswered.)*

## Product Purpose

devkit is one Chrome extension that replaces the handful of single-purpose extensions and websites a developer keeps open: cache clearers, cookie and storage editors, header modifiers, tech detectors, SEO and JSON-LD checkers, JWT/JSON/regex utilities. On top, it analyzes the current page with the developer's own LLM. Success: a developer finds the tool they need from the palette in seconds and stops installing five other extensions.

## Positioning

- Bring your own model: AI analyses run from the browser against any provider of the llm-models catalog or a local server (Ollama, LM Studio, Jan) through llm-connect. No devkit server, no devkit account, the key stays encrypted on the device.
- The AI is fed by the same inspectors the developer sees (JSON-LD findings, security checks, Web Vitals, captured errors), so an answer cites the page's actual data.
- One registry drives a command palette (Alt+Shift+D), a side panel, a DevTools panel, shortcuts and context menus.

## Operating Context

Chrome 116+, side panel next to the page, DevTools open on the side, localhost / staging / production tabs side by side. Published on the [Chrome Web Store](https://chromewebstore.google.com/detail/devkit/jbiemmlhdehncfkapmhlnkcimpfihnba); also installable unpacked from a GitHub release or from source (`pnpm build`).

## Capabilities and Constraints

- Tabs: Cache, Inspect, Page, Network, AI, Utils, plus a DevTools panel. Full list in README.md.
- Install-time permissions: activeTab, scripting, storage, sidePanel, contextMenus, declarativeNetRequest, debugger (the last two cannot be optional in Chrome). browsingData, cookies, contentSettings and site access are optional and asked on first use.
- AI cost is the user's own provider bill; devkit shows token counts and a cost estimate from llm-models prices.
- Open decisions: license. The repository is public on GitHub, with the site on GitHub Pages.

## Brand Commitments

- Name: devkit, lowercase.
- Icon: cyan `</>` on a near-black rounded square (`public/icon/`). The extension UI uses a cyan accent (#0e7490 light, #22d3ee dark) on neutral grounds, system font stack.
- UI language: English.

## Evidence on Hand

- Real screenshots of the extension on Wikipedia and on a local test page (JSON-LD analyzer, headers grade, AI answer, popup palette, options).
- Verified runs: 47 unit tests, 29 end-to-end checks in Chromium, a real Anthropic analysis of Wikipedia's JSON-LD (≈4k tokens in, 4.5k out, $0.053).
- No users, testimonials, download counts or store ratings exist: never invent them.

## Product Principles

1. One place, found in seconds: every tool reachable from the palette by name.
2. Show the page's real data, then let the AI reason over that same data.
3. The developer's keys, model and permissions stay theirs: ask only when a tool needs it.
4. Honest tooling: heuristics are labeled as heuristics (a11y hints are not an audit).
