import { beforeEach, describe, expect, it } from "vitest";
import { renderContext } from "../src/lib/ai/context";
import {
  buildElementMarkdown,
  buildLocator,
  cropRegion,
  type ElementInfo,
  firstUserFrame,
  formatSource,
  isLibraryUrl,
  parseStack,
  serializeValue,
  sourceFromAttributes,
  sourcePath,
} from "../src/lib/element";
import {
  collectElement,
  collectPicked,
  installElementPicker,
  isStableClass,
  isStableId,
  readFramework,
  startPicker,
  trimmedHtml,
  uniqueSelector,
} from "../src/lib/page/element";

const ELEMENT = Symbol.for("react.transitional.element");

describe("serializeValue", () => {
  it("keeps plain data and names what JSON cannot hold", () => {
    function handleSave() {}
    const out = serializeValue({
      label: "Save",
      count: 3,
      ok: true,
      none: null,
      missing: undefined,
      big: 10n,
      nan: Number.NaN,
      onClick: handleSave,
      arrow: () => 1,
      when: new Date("2026-01-02T03:04:05Z"),
      re: /a+/g,
      icon: { $$typeof: ELEMENT, type: function Icon() {}, props: {} },
      title: { $$typeof: Symbol.for("react.element"), type: "b", props: { children: "Hi" } },
      tags: new Set(["a", "b"]),
      map: new Map([["k", 1]]),
    }) as Record<string, unknown>;
    expect(out).toMatchObject({
      label: "Save",
      count: 3,
      ok: true,
      none: null,
      missing: "[undefined]",
      big: "10n",
      nan: "NaN",
      onClick: "ƒ handleSave",
      arrow: "ƒ arrow",
      when: "2026-01-02T03:04:05.000Z",
      re: "/a+/g",
      icon: "<Icon />",
      title: "<b>Hi</b>",
      tags: ["a", "b"],
      map: { k: 1 },
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
  it("breaks cycles but keeps shared references", () => {
    const shared = { x: 1 };
    const a: Record<string, unknown> = { shared, again: shared };
    a.self = a;
    expect(serializeValue(a)).toEqual({ shared: { x: 1 }, again: { x: 1 }, self: "[Circular]" });
  });
  it("caps depth, keys, items, strings and the total size", () => {
    expect(serializeValue({ a: { b: { c: { d: { e: 1 } } } } }, { maxDepth: 2 })).toEqual({ a: { b: "[Object]" } });
    expect(
      serializeValue(
        Array.from({ length: 30 }, (_, i) => i),
        { maxItems: 3 },
      ),
    ).toEqual([0, 1, 2, "… 27 more"]);
    expect(serializeValue("x".repeat(50), { maxString: 10 })).toBe(`${"x".repeat(10)}… (50 chars)`);
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(serializeValue(wide, { maxKeys: 5 }) as object)).toEqual(["k0", "k1", "k2", "k3", "k4", "…"]);
    const huge = Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => "v"));
    expect(JSON.stringify(serializeValue(huge, { maxItems: 100, maxNodes: 100 }))).toContain("[…]");
  });
  it("describes DOM nodes, class instances and getters that throw", () => {
    const div = document.createElement("div");
    div.id = "root";
    class Store {
      items = [1];
    }
    const tricky = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    expect(serializeValue({ div, store: new Store(), tricky })).toEqual({
      div: "[node div#root]",
      store: { __class: "Store", items: [1] },
      tricky: { boom: "[throws]" },
    });
  });
});

describe("stack frames and sources", () => {
  const react19 = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b:250:16)
    at SaveButton (http://localhost:5173/src/components/SaveButton.tsx?t=1730000000:14:9)
    at react-stack-bottom-frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b:16242:20)`;
  it("parses V8 and Firefox frames", () => {
    expect(parseStack(react19)).toHaveLength(3);
    expect(parseStack("App@http://localhost:3000/static/js/main.js:10:20\n@http://x/y.js:1:2")).toEqual([
      { fn: "App", url: "http://localhost:3000/static/js/main.js", line: 10, column: 20 },
      { fn: undefined, url: "http://x/y.js", line: 1, column: 2 },
    ]);
  });
  it("finds the first frame in the app's own code", () => {
    expect(firstUserFrame(react19)).toEqual({
      file: "http://localhost:5173/src/components/SaveButton.tsx?t=1730000000",
      line: 14,
      column: 9,
      via: "_debugStack",
    });
    const next = `Error: react-stack-top-frame
    at jsxDEV (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js:346:13)
    at Page (webpack-internal:///(app-pages-browser)/./src/app/page.tsx:22:91)`;
    expect(formatSource(firstUserFrame(next))).toBe("src/app/page.tsx:22:91");
    expect(firstUserFrame("Error\n    at chrome-extension://abc/element-picker.js:1:2")).toBeUndefined();
    expect(isLibraryUrl("http://localhost:3000/_next/static/chunks/framework.js")).toBe(true);
  });
  it("turns dev-server URLs into source paths", () => {
    expect(sourcePath("http://localhost:5173/src/App.tsx?t=123")).toBe("src/App.tsx");
    expect(sourcePath("http://localhost:5173/@fs/Users/me/app/src/x.tsx?v=1")).toBe("/Users/me/app/src/x.tsx");
    expect(sourcePath("webpack:///./components/Nav.jsx")).toBe("components/Nav.jsx");
    expect(sourcePath("/home/me/app/src/Button.tsx")).toBe("/home/me/app/src/Button.tsx");
    expect(formatSource({ file: "src/App.vue", via: "__file" })).toBe("src/App.vue");
  });
  it("reads the attributes of locator tools", () => {
    expect(
      sourceFromAttributes([
        ["data-inspector-relative-path", "src/App.tsx"],
        ["data-inspector-line", "12"],
        ["data-inspector-column", "5"],
      ]),
    ).toEqual({ file: "src/App.tsx", line: 12, column: 5, via: "data-inspector" });
    expect(sourceFromAttributes([["data-v-inspector", "src/components/Hello.vue:3:5"]])).toEqual({
      file: "src/components/Hello.vue",
      line: 3,
      column: 5,
      via: "data-v-inspector",
    });
    expect(
      sourceFromAttributes([
        ["data-astro-source-file", "/app/src/pages/index.astro"],
        ["data-astro-source-loc", "8:3"],
      ]),
    ).toMatchObject({ line: 8, column: 3 });
    expect(sourceFromAttributes([["data-source", "hero"]])).toBeUndefined();
  });
});

describe("buildLocator", () => {
  const base = { text: "", selector: "main > div:nth-of-type(2)" };
  it("prefers test ids, then role and name, label, placeholder, text, CSS", () => {
    expect(buildLocator({ ...base, testId: { attr: "data-testid", value: "save" } })).toBe("page.getByTestId('save')");
    expect(buildLocator({ ...base, testId: { attr: "data-cy", value: "save" } })).toBe(`page.locator('[data-cy="save"]')`);
    expect(buildLocator({ ...base, role: "button", name: "Don't save" })).toBe("page.getByRole('button', { name: 'Don\\'t save' })");
    expect(buildLocator({ ...base, role: "textbox", label: "Email" })).toBe("page.getByLabel('Email')");
    expect(buildLocator({ ...base, placeholder: "Search" })).toBe("page.getByPlaceholder('Search')");
    expect(buildLocator({ ...base, text: "Welcome back" })).toBe("page.getByText('Welcome back', { exact: true })");
    expect(buildLocator({ ...base, text: "x".repeat(80) })).toBe("page.locator('main > div:nth-of-type(2)')");
  });
});

describe("cropRegion", () => {
  it("scales CSS pixels to the capture and pads", () => {
    expect(cropRegion({ x: 100, y: 50, width: 40, height: 20 }, { width: 800 }, { width: 1600, height: 1200 }, 0)).toEqual({
      sx: 200,
      sy: 100,
      sw: 80,
      sh: 40,
    });
    expect(cropRegion({ x: 100, y: 50, width: 40, height: 20 }, { width: 800 }, { width: 800, height: 600 })).toEqual({
      sx: 92,
      sy: 42,
      sw: 56,
      sh: 36,
    });
  });
  it("clips to the image and gives up off screen", () => {
    expect(cropRegion({ x: -50, y: 580, width: 100, height: 100 }, { width: 800 }, { width: 800, height: 600 }, 0)).toEqual({
      sx: 0,
      sy: 580,
      sw: 50,
      sh: 20,
    });
    expect(cropRegion({ x: 900, y: 10, width: 10, height: 10 }, { width: 800 }, { width: 800, height: 600 })).toBeNull();
  });
});

const info = (over: Partial<ElementInfo> = {}): ElementInfo => ({
  url: "http://localhost:5173/settings",
  title: "Settings",
  viewport: { width: 1280, height: 720, dpr: 2 },
  tag: "button",
  id: "save",
  classes: ["btn", "primary"],
  attributes: [["type", "button"]],
  text: "Save",
  html: '<button id="save" class="btn primary" type="button">Save</button>',
  htmlTruncated: false,
  selector: "#save",
  selectorUnique: true,
  path: [
    { label: "body", up: 2 },
    { label: "div.toolbar", up: 1 },
    { label: "button#save.btn.primary", up: 0 },
  ],
  childCount: 0,
  rect: { x: 340.4, y: 88, width: 120, height: 32 },
  inView: true,
  styles: [
    ["display", "inline-flex"],
    ["padding", "4px 10px"],
  ],
  role: "button",
  name: "Save",
  locatorAttrs: [],
  ...over,
});

describe("buildElementMarkdown", () => {
  it("leads with the note, the source and how to find the element", () => {
    const md = buildElementMarkdown(
      info({
        framework: {
          name: "React",
          dev: true,
          components: [
            {
              name: "SaveButton",
              kind: "memo",
              source: { file: "/Users/me/app/src/Toolbar.tsx", line: 12, column: 7, via: "_debugSource" },
            },
            { name: "Toolbar", source: { file: "http://localhost:5173/src/App.tsx", line: 8, via: "_debugStack" } },
            { name: "InnerLayoutRouter", library: true },
          ],
          props: { label: "Save", onSave: "ƒ handleSave" },
          propsOf: "SaveButton",
          source: { file: "http://localhost:5173/src/components/SaveButton.tsx?t=1", line: 14, column: 9, via: "_debugSource" },
        },
        source: { file: "http://localhost:5173/src/components/SaveButton.tsx?t=1", line: 14, column: 9, via: "_debugSource" },
        parentLayout: "`div.toolbar` display: flex; gap: 8px",
      }),
      {
        note: "The label wraps on mobile.",
        errors: [
          {
            kind: "error",
            message: "TypeError: x is undefined\n  at foo",
            source: "http://localhost:5173/src/x.ts",
            line: 3,
            count: 2,
            time: 1,
          },
        ],
        image: true,
      },
    );
    expect(md).toContain("## UI element: `<button>` in `SaveButton`");
    expect(md).toContain("**What's wrong / what should change:** The label wraps on mobile.");
    expect(md).toContain("- Page: http://localhost:5173/settings (viewport 1280×720, DPR 2)");
    expect(md).toContain("- Source: `src/components/SaveButton.tsx:14:9` (from _debugSource)");
    expect(md).toContain("- Selector: `#save`");
    expect(md).toContain("- Playwright: `page.getByRole('button', { name: 'Save' })`");
    expect(md).toContain("- DOM path: `body > div.toolbar > button#save.btn.primary`");
    expect(md).toContain("- Box: 120×32 at x 340, y 88");
    expect(md).toContain("1. `SaveButton` (memo) — rendered at `/Users/me/app/src/Toolbar.tsx:12:7`");
    expect(md).toContain("2. `Toolbar` — rendered at `src/App.tsx:8`");
    expect(md).toContain("… and 1 more (libraries and framework internals)");
    expect(md).not.toContain("InnerLayoutRouter");
    expect(md).toContain('"onSave": "ƒ handleSave"');
    expect(md).toContain("display: inline-flex;");
    expect(md).toContain("Parent: `div.toolbar` display: flex; gap: 8px");
    expect(md).toContain("- [error ×2] TypeError: x is undefined (src/x.ts:3)");
    expect(md).toContain("_A screenshot of the element is attached._");
  });
  it("says honestly when there is no source", () => {
    expect(buildElementMarkdown(info())).toContain("Framework: none detected");
    const prod = buildElementMarkdown(info({ framework: { name: "React", dev: false, components: [{ name: "t" }] } }));
    expect(prod).toContain("production build, which strips it: run the dev server to get file:line");
    expect(buildElementMarkdown(info({ selectorUnique: false }))).toContain("(not unique)");
  });
  it("goes into the AI context as the element part", () => {
    const text = renderContext({ url: "http://x/", title: "X", element: buildElementMarkdown(info()) }, ["element"]);
    expect(text).toContain("## UI element: `<button>`");
    expect(renderContext({ url: "http://x/", title: "X", element: "## UI element" }, ["text"])).not.toContain("UI element");
  });
});

describe("selectors (in page)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  it("tells stable ids and classes from generated ones", () => {
    expect(isStableId("save")).toBe(true);
    expect(["_r_1_", ":r3:", "radix-:R1:", "headlessui-menu-3", "a1b2c3d4-e5f6", "item-12345"].map(isStableId)).toEqual(
      Array(6).fill(false),
    );
    expect(isStableClass("toolbar__button")).toBe(true);
    expect(["px-4", "flex", "items-center", "sc-bdfBwQ", "css-1x2y3z", "Button_root__a1b2", "hover:bg-red"].map(isStableClass)).toEqual(
      Array(7).fill(false),
    );
  });
  it("prefers an id, then a test id, then a short path with nth-of-type", () => {
    document.body.innerHTML = `
      <main>
        <button id="save">Save</button>
        <div data-testid="card"><span>a</span></div><span>b</span>
        <ul class="menu px-4"><li>one</li><li>two</li><li id=":r1:">three</li></ul>
        <input name="email">
        <ol><li>1</li><li>2</li><li>3</li></ol>
      </main>`;
    expect(uniqueSelector(document.querySelector("#save")!)).toEqual({ selector: "#save", unique: true });
    expect(uniqueSelector(document.querySelector("[data-testid=card]")!).selector).toBe('[data-testid="card"]');
    expect(uniqueSelector(document.querySelector("[data-testid=card] span")!).selector).toBe('[data-testid="card"] > span');
    const third = uniqueSelector(document.querySelectorAll("li")[2]!);
    expect(third.selector).toBe("ul.menu > li:nth-of-type(3)");
    expect(third.unique).toBe(true);
    expect(uniqueSelector(document.querySelector("input")!).selector).toBe('input[name="email"]');
  });
});

describe("collectElement (in page)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  const setup = () => {
    document.body.innerHTML = `<div id="root"><section class="toolbar"><button id="save" class="btn" aria-label="Save changes">Save</button></section></div>`;
    const button = document.querySelector("#save")!;
    function Toolbar() {}
    function SaveButton() {}
    const root = { tag: 3, type: null, return: null };
    const toolbar = { tag: 0, type: Toolbar, elementType: Toolbar, return: root, memoizedProps: {}, _debugOwner: null };
    const inner = {
      tag: 0,
      type: SaveButton,
      elementType: SaveButton,
      return: null as unknown,
      memoizedProps: { label: "Save", onSave: function handleSave() {} },
      _debugSource: { fileName: "/app/src/Toolbar.tsx", lineNumber: 12, columnNumber: 7 },
      _debugOwner: toolbar,
    };
    const memo = { tag: 14, type: SaveButton, elementType: { $$typeof: Symbol.for("react.memo"), type: SaveButton }, return: toolbar };
    inner.return = memo;
    const host = {
      tag: 5,
      type: "button",
      return: inner,
      _debugSource: { fileName: "/app/src/components/SaveButton.tsx", lineNumber: 14, columnNumber: 9 },
      _debugOwner: inner,
    };
    (button as unknown as Record<string, unknown>).__reactFiber$abc = host;
    return button;
  };

  it("reads React fibers: component stack, memo, props and the element's source", () => {
    const data = collectElement(setup());
    expect(data.selector).toBe("#save");
    expect(data.role).toBe("button");
    expect(data.name).toBe("Save changes");
    expect(data.path.map((c) => c.label)).toEqual(["body", "div#root", "section.toolbar", "button#save.btn"]);
    expect(data.framework?.name).toBe("React");
    expect(data.framework?.dev).toBe(true);
    expect(data.framework?.components.map((c) => [c.name, c.kind])).toEqual([
      ["SaveButton", "memo"],
      ["Toolbar", undefined],
    ]);
    expect(data.framework?.props).toEqual({ label: "Save", onSave: "ƒ handleSave" });
    expect(formatSource(data.source)).toBe("/app/src/components/SaveButton.tsx:14:9");
    expect(buildLocator(data)).toBe("page.getByRole('button', { name: 'Save changes' })");
  });

  it("parses React 19's _debugStack", () => {
    document.body.innerHTML = `<p>Hello</p>`;
    function Greeting() {}
    const comp = { tag: 0, type: Greeting, return: null, memoizedProps: { who: "you" }, _debugStack: new Error("x") };
    comp._debugStack.stack = "Error: react-stack-top-frame\n    at Root (http://localhost:5173/src/main.tsx:5:3)";
    const stack =
      "Error: react-stack-top-frame\n    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react.js:1:1)\n    at Greeting (http://localhost:5173/src/Greeting.tsx?t=9:4:10)";
    const host = { tag: 5, type: "p", return: comp, _debugStack: { stack }, _debugOwner: comp };
    (document.querySelector("p") as unknown as Record<string, unknown>).__reactFiber$x = host;
    const data = collectElement(document.querySelector("p")!);
    expect(formatSource(data.source)).toBe("src/Greeting.tsx:4:10");
    expect(formatSource(data.framework?.components[0]?.source)).toBe("src/main.tsx:5:3");
  });

  it("reads Vue 3, Vue 2 and Svelte debug data", () => {
    document.body.innerHTML = `<div class="a"><b>vue3</b></div><div class="b"><i>vue2</i></div><span>svelte</span>`;
    const app = { type: { name: "App", __file: "/src/App.vue" }, parent: null, props: {} };
    (document.querySelector(".a") as unknown as Record<string, unknown>).__vueParentComponent = {
      type: { __name: "HelloWorld", __file: "/src/components/HelloWorld.vue" },
      parent: app,
      props: { msg: "hi" },
      appContext: { app: { version: "3.5.0" } },
    };
    const v3 = readFramework(document.querySelector("b")!)!;
    expect(v3).toMatchObject({ name: "Vue 3", version: "3.5.0", dev: true, props: { msg: "hi" }, propsOf: "HelloWorld" });
    expect(v3.components.map((c) => c.name)).toEqual(["HelloWorld", "App"]);
    (document.querySelector(".b") as unknown as Record<string, unknown>).__vue__ = {
      $options: { name: "TodoItem", __file: "src/TodoItem.vue" },
      $props: { done: false },
      constructor: { version: "2.7.16" },
    };
    expect(readFramework(document.querySelector("i")!)).toMatchObject({ name: "Vue 2", version: "2.7.16", props: { done: false } });
    (document.querySelector("span") as unknown as Record<string, unknown>).__svelte_meta = {
      loc: { file: "src/routes/+page.svelte", line: 9, column: 2, char: 120 },
    };
    expect(formatSource(readFramework(document.querySelector("span")!)!.source)).toBe("src/routes/+page.svelte:10:3");
  });

  it("trims long HTML and says so", () => {
    document.body.innerHTML = `<ul id="list">${Array.from({ length: 200 }, (_, i) => `<li><a href="/item/${i}"><span>Item ${i} ${"x".repeat(40)}</span></a></li>`).join("")}</ul>`;
    const r = trimmedHtml(document.querySelector("#list")!);
    expect(r.trimmed).toBe(true);
    expect(r.html.length).toBeLessThanOrEqual(4096 + 20);
    expect(r.html).toContain("more -->");
    const svg = document.createElement("div");
    svg.innerHTML = `<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>`;
    expect(trimmedHtml(svg).html).toContain('<svg viewBox="0 0 10 10">…</svg>');
  });
});

describe("picker (in page)", () => {
  type W = { __devkitPicked?: Element; __devkitPickedSelector?: string; __devkitElement?: unknown };
  beforeEach(() => {
    document.body.innerHTML = `<div id="card"><button id="go">Go</button></div>`;
    delete (window as W).__devkitPicked;
    delete (window as W).__devkitElement;
  });
  it("selects on pointerdown without letting the page see it, and removes the overlay", async () => {
    let clicks = 0;
    const go = document.querySelector("#go")!;
    go.addEventListener("pointerdown", () => clicks++);
    const done = startPicker();
    expect(document.querySelector("devkit-picker")).not.toBeNull();
    go.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true }));
    go.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true, button: 0 }));
    expect(await done).toEqual({ status: "picked" });
    expect(clicks).toBe(0);
    expect((window as W).__devkitPicked).toBe(go);
    expect(document.querySelector("devkit-picker")).toBeNull();
  });
  it("moves to the parent with the arrow keys and cancels with Escape", async () => {
    const go = document.querySelector("#go")!;
    const first = startPicker();
    go.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, composed: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(await first).toEqual({ status: "picked" });
    expect((window as W).__devkitPicked?.id).toBe("card");
    const second = startPicker();
    const third = startPicker();
    expect(await second).toEqual({ status: "replaced" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(await third).toEqual({ status: "cancelled" });
    expect(document.querySelectorAll("devkit-picker")).toHaveLength(0);
  });
  it("re-reads the pick, finds a re-rendered element by selector, reports a removed one", async () => {
    installElementPicker();
    expect(await collectPicked()).toEqual({ status: "none" });
    (window as W).__devkitPicked = document.querySelector("#go")!;
    const first = await collectPicked();
    expect(first.status === "ok" && first.info.selector).toBe("#go");
    const up = await collectPicked({ up: 1 });
    expect(up.status === "ok" && up.info.id).toBe("card");
    (window as W).__devkitPickedSelector = "#card";
    document.body.innerHTML = `<div id="card"><button id="go">Go</button></div>`;
    const again = await collectPicked();
    expect(again).toMatchObject({ status: "ok", refound: true });
    document.body.innerHTML = "";
    expect(await collectPicked()).toEqual({ status: "detached", selector: "#card" });
  });
});
