import { useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { ACTIONS, CATEGORIES } from "../lib/actions";
import { PANELS, PENDING_ROUTE_KEY, type Route } from "../lib/panels";
import { ToastProvider } from "./components";
import { PageProvider, usePage, useRunAction } from "./page";

interface Item {
  id: string;
  title: string;
  description: string;
  category: keyof typeof CATEGORIES;
  kind: "action" | "panel";
  haystack: string;
}

const ITEMS: Item[] = [
  ...ACTIONS.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    category: a.category,
    kind: "action" as const,
    haystack: `${a.title} ${a.description} ${a.keywords ?? ""}`.toLowerCase(),
  })),
  ...PANELS.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    kind: "panel" as const,
    haystack: `${p.title} ${p.description} ${p.keywords ?? ""} ${p.category}`.toLowerCase(),
  })),
];

/** Ranks items: title prefix, then title word, then anywhere. */
export function searchItems(query: string, items = ITEMS): Item[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items
    .filter((i) => terms.every((t) => i.haystack.includes(t)))
    .map((i) => {
      const title = i.title.toLowerCase();
      const score = title.startsWith(terms[0]!) ? 0 : title.split(/\W+/).some((w) => w.startsWith(terms[0]!)) ? 1 : 2;
      return { i, score };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.i);
}

function PaletteInner() {
  const page = usePage();
  const runAction = useRunAction();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const results = useMemo(() => searchItems(q), [q]);

  const openPanel = async (route: Route) => {
    if (page.tab) await browser.sidePanel.open({ windowId: page.tab.windowId });
    await browser.storage.session.set({ [PENDING_ROUTE_KEY]: route });
    window.close();
  };

  const choose = async (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === "panel") return openPanel({ panel: item.id });
    const action = ACTIONS.find((a) => a.id === item.id)!;
    await runAction(action);
    setTimeout(() => window.close(), 1200);
  };

  return (
    <div className="palette">
      <input
        autoFocus
        type="search"
        placeholder="Search devkit: clear cache, json-ld, jwt, headers, ask ai…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(results.length - 1, s + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(results[sel]);
          }
          listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
        }}
        aria-label="Search commands"
      />
      <ul ref={listRef}>
        {results.map((item, i) => (
          <li key={`${item.kind}:${item.id}`}>
            <button
              type="button"
              data-i={i}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(item)}
            >
              <span>{item.title}</span>
              <span className="desc">{item.description}</span>
              <span className={`pill cat ${item.kind === "action" ? "accent" : ""}`}>
                {item.kind === "action" ? "run" : CATEGORIES[item.category]}
              </span>
            </button>
          </li>
        ))}
        {results.length === 0 ? (
          <li className="muted" style={{ padding: 10 }}>
            Nothing matches.
          </li>
        ) : null}
      </ul>
      <footer>
        <span>↑↓ to move · Enter to run</span>
        <button type="button" className="btn small ghost" onClick={() => openPanel({ panel: "cache-actions" })}>
          Open side panel
        </button>
      </footer>
    </div>
  );
}

export function PaletteApp() {
  return (
    <ToastProvider>
      <PageProvider>
        <PaletteInner />
      </PageProvider>
    </ToastProvider>
  );
}
