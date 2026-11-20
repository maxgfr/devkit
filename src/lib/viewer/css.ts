// Styles of the data viewer, inside its shadow root: the page's styles cannot reach them.
export const CSS = `
:host { all: initial; display: block; }
.app {
  --bg: #ffffff; --bg-2: #f6f7f9; --fg: #14171f; --fg-3: #646b7a; --line: #e2e5eb;
  --accent: #0e7490; --accent-fg: #ffffff; --hit: #e0f4f8; --bad: #b91c1c;
  --key: #0e7490; --str: #15803d; --num: #b45309; --bool: #7c3aed; --null: #646b7a;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font: 13px / 1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .app {
    --bg: #111318; --bg-2: #181b22; --fg: #e7e9ee; --fg-3: #8a91a0; --line: #2a2f3a;
    --accent: #22d3ee; --accent-fg: #062a33; --hit: #0f2f37; --bad: #f87171;
    --key: #22d3ee; --str: #4ade80; --num: #fbbf24; --bool: #c4b5fd; --null: #8a91a0;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.bar {
  position: sticky; top: 0; z-index: 1;
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 8px 12px; background: var(--bg-2); border-bottom: 1px solid var(--line);
}
.brand { font-weight: 600; color: var(--accent); margin-right: 4px; }
.grow { flex: 1; }
.controls { display: inline-flex; align-items: center; gap: 6px; }
.controls:empty { display: none; }
.meta { color: var(--fg-3); font-size: 12px; }
button {
  font: inherit; color: inherit; background: var(--bg); cursor: pointer;
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.seg { display: inline-flex; }
.seg button { border-radius: 0; }
.seg button:first-child { border-radius: 6px 0 0 6px; }
.seg button:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
input[type="search"] {
  font: inherit; color: inherit; background: var(--bg); min-width: 14em;
  border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px;
}
.banner { display: flex; align-items: center; gap: 8px; margin: 12px 12px 0; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--line); }
.banner.error { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); background: color-mix(in srgb, var(--bad) 8%, transparent); }
.banner.info { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.banner .detail { color: var(--fg-3); font-family: var(--mono); font-size: 12px; }
.view { padding: 8px 12px 48px; font: 13px / 1.6 var(--mono); overflow-x: auto; }
.raw { margin: 0; font: inherit; white-space: pre; }
.line { white-space: nowrap; border-radius: 3px; }
.line:hover { background: var(--bg-2); }
.children { margin-left: 0.55em; padding-left: 1em; border-left: 1px solid var(--line); }
.tog, .key {
  border: 0; background: none; padding: 0; border-radius: 3px;
  font: inherit; line-height: inherit;
}
.tog { display: inline-block; width: 1.3em; text-align: center; color: var(--fg-3); }
.tog:disabled { opacity: 0.35; }
.sp { display: inline-block; width: 1.3em; }
.key { color: var(--key); cursor: copy; }
.key:hover { text-decoration: underline; }
.key.idx { color: var(--fg-3); }
.colon, .count { color: var(--fg-3); }
.s { color: var(--str); }
.s a { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
.n { color: var(--num); }
.b { color: var(--bool); }
.null { color: var(--null); font-style: italic; }
.hit > .line { background: var(--hit); }
.more { margin: 2px 0 2px 1.3em; font-family: inherit; font-size: 12px; padding: 1px 8px; color: var(--accent); }
.empty { color: var(--fg-3); font-family: system-ui, sans-serif; }
.wrap .raw { white-space: pre-wrap; overflow-wrap: anywhere; }
.wrap .line { white-space: pre-wrap; overflow-wrap: anywhere; }
/* JSON Lines: a line that is not valid JSON */
.bad > .line .err { color: var(--bad); font-family: system-ui, sans-serif; }
.bad > .line .src { color: var(--fg-3); }
/* XML */
.xml .tag { color: var(--fg-3); }
.xml .tagname { color: var(--key); cursor: copy; }
.xml .an { color: var(--num); }
.xml .eq { color: var(--fg-3); }
.xml .av { color: var(--str); }
.xml .av a, .xml .t a { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
.xml .t { white-space: pre-wrap; }
.xml .cdata { color: var(--str); }
.xml .punct, .xml .pi { color: var(--fg-3); }
.xml .comment { color: var(--fg-3); font-style: italic; white-space: pre-wrap; }
.xml .tail .count { color: var(--fg-3); padding: 0 2px; }
.feed { margin: 4px 0 12px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); font: 13px / 1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.feed summary { cursor: pointer; }
.feed-head { display: flex; flex-direction: column; margin: 6px 0; }
.feed-title { font-weight: 600; font-size: 14px; }
.feed-desc { color: var(--fg-3); }
.feed-items { margin: 0; padding-left: 2em; }
.feed-items li { margin: 2px 0; }
.feed-items a { color: var(--accent); }
.feed-date { color: var(--fg-3); font-size: 12px; margin-left: 8px; }
.feed-more { color: var(--fg-3); margin: 4px 0 0; }
/* CSV */
.table-wrap { width: fit-content; max-width: 100%; overflow: auto; max-height: calc(100vh - var(--bar-h, 48px) - 16px); border: 1px solid var(--line); border-radius: 6px; }
.grid { border-collapse: separate; border-spacing: 0; font: 12px / 1.5 var(--mono); }
.grid th, .grid td { padding: 3px 8px; border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); text-align: left; vertical-align: top; white-space: pre; max-width: 32em; overflow: hidden; text-overflow: ellipsis; }
.grid thead th { position: sticky; top: 0; z-index: 2; background: var(--bg-2); padding: 0; }
.grid .rn { position: sticky; left: 0; z-index: 1; background: var(--bg-2); color: var(--fg-3); text-align: right; font-weight: normal; }
.grid thead .rn { z-index: 3; padding: 3px 8px; }
.grid .sort { border: 0; border-radius: 0; background: none; width: 100%; text-align: left; padding: 3px 8px; font-weight: 600; white-space: pre; }
.grid .arrow { color: var(--accent); }
.grid tbody tr:hover td { background: var(--bg-2); }
.grid tr.ragged td { background: color-mix(in srgb, var(--bad) 6%, transparent); }
.grid td a { color: var(--accent); }
.wrap .grid td { white-space: pre-wrap; overflow-wrap: anywhere; }
.offscreen { position: fixed; top: 0; left: -9999px; opacity: 0; }
.toast {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  padding: 6px 12px; border-radius: 6px; background: var(--fg); color: var(--bg);
  font-size: 12px; opacity: 0; pointer-events: none; transition: opacity 0.15s;
}
.toast.show { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .toast { transition: none; } }
`;
