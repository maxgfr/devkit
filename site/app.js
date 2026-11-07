// devkit site: Fig. 1 leaders, the palette demo over the real command list, the tab tour, copy buttons.
const root = document.documentElement;
root.classList.add("js", "pre");

const CATEGORY = { cache: "Cache", inspect: "Inspect", security: "Security", page: "Page", network: "Network", ai: "AI", utils: "Utils" };

/* Fig. 1: draw the leaders once, when the figure is on screen. */
const fig = document.querySelector(".fig1");
if (fig && "IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        requestAnimationFrame(() => root.classList.remove("pre"));
        io.disconnect();
      }
    },
    { threshold: 0.35 },
  );
  io.observe(fig);
} else {
  root.classList.remove("pre");
}

/* Copy buttons */
for (const box of document.querySelectorAll("[data-copy]")) {
  const button = box.querySelector(".copy");
  button?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(box.dataset.copy);
      button.textContent = "Copied";
      button.dataset.done = "";
      setTimeout(() => {
        button.textContent = "Copy";
        delete button.dataset.done;
      }, 1400);
    } catch {
      button.textContent = "Select and copy";
    }
  });
}

const commandsReady = fetch("commands.json").then((r) => r.json());

/* Palette demo: the same ranking as the extension's popup. */
const input = document.getElementById("pq");
const list = document.getElementById("pr");
const count = document.getElementById("pcount");
const picked = document.getElementById("picked");
let items = [];
let shown = [];
let sel = 0;

function search(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items
    .filter((i) => terms.every((t) => i.hay.includes(t)))
    .map((i) => {
      const title = i.title.toLowerCase();
      const score = title.startsWith(terms[0]) ? 0 : title.split(/\W+/).some((w) => w.startsWith(terms[0])) ? 1 : 2;
      return { i, score };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.i);
}

function render() {
  list.replaceChildren();
  const visible = shown.slice(0, 7);
  if (!visible.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing matches. Try “cookies”, “regex” or “sitemap”.";
    list.append(li);
  }
  visible.forEach((item, i) => {
    const li = document.createElement("li");
    li.setAttribute("aria-selected", String(i === sel));
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = item.title;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = item.description;
    const c = document.createElement("span");
    c.className = item.kind === "action" ? "c run" : "c";
    c.textContent = item.kind === "action" ? "run" : CATEGORY[item.category];
    li.append(t, d, c);
    li.addEventListener("mouseenter", () => {
      sel = i;
      render();
    });
    li.addEventListener("click", () => choose(item));
    list.append(li);
  });
  count.textContent = `${shown.length} of ${items.length} commands`;
}

function choose(item) {
  if (!item) return;
  picked.hidden = false;
  picked.textContent =
    item.kind === "action"
      ? `In the extension, Enter runs “${item.title}” on the current tab right away.`
      : `In the extension, Enter opens the side panel on ${CATEGORY[item.category]} › ${item.title}.`;
}

if (input) {
  commandsReady.then((data) => {
    items = data.map((c) => ({ ...c, hay: `${c.title} ${c.description} ${c.keywords} ${c.category}`.toLowerCase() }));
    shown = items;
    render();
  });
  input.addEventListener("input", () => {
    shown = search(input.value);
    sel = 0;
    picked.hidden = true;
    render();
  });
  input.addEventListener("keydown", (e) => {
    const max = Math.min(shown.length, 7) - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(max, sel + 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[sel]);
    }
  });
}

/* Tour */
const TOUR = {
  cache: { shot: "panel-cache", alt: "devkit Cache tab: cache and storage actions.", lede: "Clear exactly what you mean to clear, for this origin only, then reload. Edit cookies and Web Storage in place." },
  inspect: { shot: "panel-overview", alt: "devkit Inspect tab: the page report, one row per area with its status.", lede: "What the page ships, read from the page itself: a page report, stack, SEO, structured data, Web Vitals, errors, links." },
  security: { shot: "panel-security", alt: "devkit Security tab: a Stripe live secret key found in an inline script, masked.", lede: "What an attacker would look at first: header grade, secrets shipped to the browser, source maps and exposed files, third parties, CSP." },
  page: { shot: "panel-page", alt: "devkit Page tab: emulation of color scheme, motion, CPU and network.", lede: "Pick an element and hand its component, file:line, props and styles to your coding agent. Then bend the page: edit it, outline it, strip its CSS, emulate media and slow networks, capture it." },
  network: { shot: "panel-network", alt: "devkit Network tab: local, staging and prod environments.", lede: "Rewrite requests with Chrome's own rule engine, and jump between local, staging and prod on the same path." },
  ai: { shot: "panel-ai", alt: "devkit AI tab: a structured data review by Claude.", lede: "Analyses and chat with the model you choose, fed with the data the other tabs collect." },
  utils: { shot: "panel-utils", alt: "devkit Utils tab: JSON converted to TypeScript types.", lede: "The small converters you otherwise paste into random websites, offline and private." },
};

const tabs = [...document.querySelectorAll('[role="tab"]')];
const panel = document.getElementById("tp");
const shot = document.getElementById("tour-shot");
const titleEl = document.getElementById("tour-title-cat");
const ledeEl = document.getElementById("tour-lede");
const toolList = document.getElementById("tour-list");

function showTab(tab, focus = false) {
  const cat = tab.dataset.cat;
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  }
  if (focus) tab.focus();
  panel.setAttribute("aria-labelledby", tab.id);
  const info = TOUR[cat];
  shot.src = `img/${info.shot}.webp`;
  shot.alt = info.alt;
  shot.height = info.shot === "panel-ai" ? 1000 : 900;
  titleEl.textContent = CATEGORY[cat];
  ledeEl.textContent = info.lede;
  commandsReady.then((data) => {
    toolList.replaceChildren(
      ...data
        .filter((c) => c.category === cat)
        .map((c) => {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = c.title;
          if (c.kind === "action") {
            const r = document.createElement("span");
            r.className = "run";
            r.textContent = "ONE CLICK";
            b.append(r);
          }
          const d = document.createElement("span");
          d.textContent = c.description;
          li.append(b, d);
          return li;
        }),
    );
  });
}

tabs.forEach((tab, i) => {
  tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
  tab.addEventListener("click", () => showTab(tab));
  tab.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) {
      e.preventDefault();
      showTab(tabs[(i + step + tabs.length) % tabs.length], true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      showTab(tabs[e.key === "Home" ? 0 : tabs.length - 1], true);
    }
  });
});
const initial = tabs.find((t) => t.getAttribute("aria-selected") === "true");
if (initial) showTab(initial);
