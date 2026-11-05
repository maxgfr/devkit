import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { ACTIONS } from "../../lib/actions";
import { runInTab } from "../../lib/inject";
import { fillForms } from "../../lib/page/forms";
import { viewportDelta } from "../../lib/page/toggles";
import { Button, download, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { AccessGate, usePage, useRunAction } from "../page";

export function PageTools() {
  const run = useRunAction();
  return (
    <Section title="Page tools">
      <div className="grid2">
        {ACTIONS.filter((a) => a.category === "page").map((a) => (
          <button key={a.id} type="button" className="action" onClick={() => run(a)}>
            <strong>{a.title}</strong>
            <span>{a.description}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/* chrome.debugger: one session per tab, kept for the life of the side panel. */
const attached = new Set<number>();

async function attach(tabId: number) {
  if (attached.has(tabId)) return;
  await browser.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
}

export async function cdp<T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
  await attach(tabId);
  return (await browser.debugger.sendCommand({ tabId }, method, params)) as T;
}

async function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await browser.debugger.detach({ tabId }).catch(() => undefined);
}

interface EmulationState {
  scheme: "" | "light" | "dark";
  motion: "" | "reduce";
  contrast: "" | "more";
  media: "" | "print";
  cpu: number;
  network: "" | "offline" | "slow-3g" | "fast-3g" | "slow-4g";
  vision: "" | "blurredVision" | "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia";
}

const NETWORKS = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  "slow-3g": { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 },
  "fast-3g": { offline: false, latency: 562, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  "slow-4g": { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 },
} as const;

const NONE: EmulationState = { scheme: "", motion: "", contrast: "", media: "", cpu: 1, network: "", vision: "" };

export function Emulation() {
  const page = usePage();
  const toast = useToast();
  const [state, setState] = useState<EmulationState>(NONE);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onDetach = (source: { tabId?: number }) => {
      if (source.tabId !== undefined) attached.delete(source.tabId);
      if (source.tabId === page.tabId) {
        setActive(false);
        setState(NONE);
      }
    };
    browser.debugger.onDetach.addListener(onDetach);
    setActive(page.tabId !== undefined && attached.has(page.tabId));
    return () => browser.debugger.onDetach.removeListener(onDetach);
  }, [page.tabId]);

  const apply = async (next: EmulationState) => {
    if (page.tabId === undefined) return;
    setState(next);
    try {
      const id = page.tabId;
      const features = [
        { name: "prefers-color-scheme", value: next.scheme },
        { name: "prefers-reduced-motion", value: next.motion },
        { name: "prefers-contrast", value: next.contrast },
      ];
      await cdp(id, "Emulation.setEmulatedMedia", { media: next.media, features });
      await cdp(id, "Emulation.setCPUThrottlingRate", { rate: next.cpu });
      await cdp(id, "Network.enable");
      await cdp(
        id,
        "Network.emulateNetworkConditions",
        next.network ? NETWORKS[next.network] : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      );
      await cdp(id, "Emulation.setEmulatedVisionDeficiency", { type: next.vision || "none" });
      setActive(true);
    } catch (e) {
      toast(`Emulation failed: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  const select = <K extends keyof EmulationState>(key: K, label: string, options: [EmulationState[K], string][]) => (
    <label className="field">
      {label}
      <select
        value={String(state[key])}
        onChange={(e) => {
          const raw = e.target.value;
          apply({ ...state, [key]: key === "cpu" ? Number(raw) : raw });
        }}
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
  if (!page.origin) return <Empty>Open a web page to emulate.</Empty>;
  return (
    <Section
      title="Emulation"
      hint="Uses the Chrome debugger: Chrome shows a “devkit started debugging this browser” bar while it is on. Closing DevTools on this tab may stop it."
      actions={
        active ? (
          <Button
            size="small"
            onClick={async () => {
              if (page.tabId !== undefined) await detach(page.tabId);
              setActive(false);
              setState(NONE);
            }}
          >
            Stop & reset
          </Button>
        ) : null
      }
    >
      <div className="grid2">
        {select("scheme", "prefers-color-scheme", [
          ["", "Page default"],
          ["light", "light"],
          ["dark", "dark"],
        ])}
        {select("motion", "prefers-reduced-motion", [
          ["", "Page default"],
          ["reduce", "reduce"],
        ])}
        {select("contrast", "prefers-contrast", [
          ["", "Page default"],
          ["more", "more"],
        ])}
        {select("media", "Media type", [
          ["", "screen"],
          ["print", "print"],
        ])}
        {select("cpu", "CPU", [
          [1, "No throttling"],
          [4, "4× slower"],
          [6, "6× slower"],
          [20, "20× slower"],
        ])}
        {select("network", "Network", [
          ["", "No throttling"],
          ["slow-4g", "Slow 4G"],
          ["fast-3g", "Fast 3G"],
          ["slow-3g", "Slow 3G"],
          ["offline", "Offline"],
        ])}
        {select("vision", "Vision deficiency", [
          ["", "None"],
          ["blurredVision", "Blurred vision"],
          ["protanopia", "Protanopia"],
          ["deuteranopia", "Deuteranopia"],
          ["tritanopia", "Tritanopia"],
          ["achromatopsia", "Achromatopsia"],
        ])}
      </div>
    </Section>
  );
}

const SIZES: [string, number, number][] = [
  ["iPhone SE", 375, 667],
  ["iPhone 15", 393, 852],
  ["Pixel 8", 412, 915],
  ["iPad mini", 768, 1024],
  ["iPad Pro 11", 834, 1194],
  ["Laptop", 1280, 800],
  ["Desktop HD", 1440, 900],
  ["Full HD", 1920, 1080],
];

export function Viewport() {
  const page = usePage();
  const toast = useToast();
  const [w, setW] = useState(1280);
  const [h, setH] = useState(800);
  const resize = async (width: number, height: number) => {
    if (page.tabId === undefined || !page.tab) return;
    try {
      const d = page.canScript ? await runInTab(page.tabId, viewportDelta) : { dw: 16, dh: 88 };
      await browser.windows.update(page.tab.windowId, { state: "normal", width: width + d.dw, height: height + d.dh });
      toast(`Viewport ≈ ${width}×${height}. The side panel takes room too: close it for exact sizes.`);
    } catch (e) {
      toast(String(e), true);
    }
  };
  return (
    <Section
      title="Responsive sizes"
      hint="Resizes the browser window so the page viewport gets the chosen size. For device emulation (touch, DPR, user agent), use DevTools’ device mode."
    >
      <div className="grid2">
        {SIZES.map(([name, width, height]) => (
          <button key={name} type="button" className="action" onClick={() => resize(width, height)}>
            <strong>{name}</strong>
            <span>
              {width} × {height}
            </span>
          </button>
        ))}
      </div>
      <div className="row">
        <input type="number" value={w} onChange={(e) => setW(Number(e.target.value))} style={{ width: 90 }} aria-label="Width" />×
        <input type="number" value={h} onChange={(e) => setH(Number(e.target.value))} style={{ width: 90 }} aria-label="Height" />
        <Button onClick={() => resize(w, h)}>Resize</Button>
        <Button
          onClick={async () => {
            if (page.tabId === undefined || !page.canScript) return;
            const d = await runInTab(page.tabId, viewportDelta);
            toast(`Current viewport: ${d.w}×${d.h}`);
          }}
        >
          Current size
        </Button>
      </div>
    </Section>
  );
}

export function Screenshot() {
  const page = usePage();
  const toast = useToast();
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = () =>
    `${page.origin ? new URL(page.origin).host : "page"}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
  const visible = async () => {
    if (!page.tab) return;
    setBusy(true);
    setError(null);
    try {
      setShot(await browser.tabs.captureVisibleTab(page.tab.windowId, { format: "png" }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const full = async () => {
    if (page.tabId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const metrics = await cdp<{ cssContentSize: { width: number; height: number } }>(page.tabId, "Page.getLayoutMetrics");
      const width = Math.ceil(metrics.cssContentSize.width);
      const height = Math.min(Math.ceil(metrics.cssContentSize.height), 16384);
      const { data } = await cdp<{ data: string }>(page.tabId, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      setShot(`data:image/png;base64,${data}`);
      await detach(page.tabId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AccessGate>
      <Section
        title="Screenshot"
        actions={
          <>
            <Button busy={busy} onClick={visible}>
              Visible area
            </Button>
            <Button busy={busy} variant="primary" onClick={full}>
              Full page
            </Button>
          </>
        }
        hint="Full page uses the Chrome debugger for a moment (capped at 16 384 px high)."
      >
        <ErrorText error={error} />
        {shot ? (
          <>
            <div className="row">
              <Button onClick={() => download(name(), dataUrlToBlob(shot))}>Download</Button>
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.write([new ClipboardItem({ "image/png": dataUrlToBlob(shot) })]);
                    toast("Screenshot copied.");
                  } catch (e) {
                    toast(String(e), true);
                  }
                }}
              >
                Copy image
              </Button>
              <Button variant="ghost" onClick={() => setShot(null)}>
                Discard
              </Button>
            </div>
            <img src={shot} alt="Screenshot of the page" style={{ width: "100%", border: "1px solid var(--line)", borderRadius: 6 }} />
          </>
        ) : null}
      </Section>
    </AccessGate>
  );
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const type = /data:([^;]+)/.exec(head ?? "")?.[1] ?? "image/png";
  const bin = atob(b64 ?? "");
  return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type });
}

export function Forms() {
  const page = usePage();
  const toast = useToast();
  return (
    <AccessGate>
      <Section
        title="Form filler"
        hint="Fills visible inputs, selects, checkboxes and textareas with plausible fake data (example.com e-mail, Stripe test card). Nothing is submitted."
      >
        <div className="row">
          <Button
            variant="primary"
            onClick={async () => {
              if (page.tabId === undefined) return;
              try {
                const n = await runInTab(page.tabId, fillForms);
                toast(n ? `Filled ${n} field${n > 1 ? "s" : ""}.` : "No fillable field found.");
              } catch (e) {
                toast(String(e), true);
              }
            }}
          >
            Fill the forms
          </Button>
        </div>
        <Notice>
          <span className="small">The filler fires input and change events, so React, Vue and Angular forms see the values.</span>
        </Notice>
      </Section>
    </AccessGate>
  );
}
