import { lazy, Suspense } from "react";
import { browser } from "wxt/browser";
import { ENVS_KEY } from "../lib/envs";
import { loadRules, RULES_KEY, saveRules } from "../lib/dnr";
import { ALL_SITES } from "../lib/permissions";
import { Button, download, Notice, Section, ToastProvider, useToast } from "./components";
import { useAsync } from "./hooks";
import { disableErrorCapture, enableErrorCapture } from "./panels/inspect";
import { ERROR_SCRIPT_IDS } from "../lib/page/errors";

const AiSettings = lazy(() => import("./panels/ai").then((m) => ({ default: m.AiSettings })));

const OPTIONAL = [
  ["browsingData", "Clear cache and site data"],
  ["cookies", "Cookie editor"],
  ["contentSettings", "Block JavaScript per site"],
] as const;

function Permissions() {
  const toast = useToast();
  const perms = useAsync(async () => {
    const all = await browser.permissions.getAll();
    return { permissions: all.permissions ?? [], origins: all.origins ?? [] };
  }, []);
  const has = (p: string) => perms.data?.permissions.includes(p as never);
  const allSites = perms.data?.origins.includes(ALL_SITES);
  const sites = (perms.data?.origins ?? []).filter((o) => o !== ALL_SITES);
  return (
    <Section title="Permissions" hint="devkit asks for each permission the first time a tool needs it. You can grant or revoke them here.">
      <table className="kv">
        <tbody>
          <tr>
            <th>Access to all sites</th>
            <td>
              <div className="row">
                <span className="grow">
                  {allSites ? "granted" : "not granted"} — lets the side panel follow you across tabs, check links, rewrite requests,
                  capture errors.
                </span>
                {allSites ? (
                  <Button
                    size="small"
                    onClick={async () => {
                      await browser.permissions.remove({ origins: [ALL_SITES] });
                      perms.run();
                    }}
                  >
                    Revoke
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="primary"
                    onClick={async () => {
                      await browser.permissions.request({ origins: [ALL_SITES] });
                      perms.run();
                    }}
                  >
                    Grant
                  </Button>
                )}
              </div>
            </td>
          </tr>
          {OPTIONAL.map(([p, label]) => (
            <tr key={p}>
              <th>{p}</th>
              <td>
                <div className="row">
                  <span className="grow">
                    {has(p) ? "granted" : "not granted"} — {label}
                  </span>
                  {has(p) ? (
                    <Button
                      size="small"
                      onClick={async () => {
                        await browser.permissions.remove({ permissions: [p] });
                        perms.run();
                      }}
                    >
                      Revoke
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      onClick={async () => {
                        await browser.permissions.request({ permissions: [p] });
                        perms.run();
                      }}
                    >
                      Grant
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {sites.length ? (
            <tr>
              <th>Single sites</th>
              <td>
                <div className="row">
                  <span className="grow">{sites.join(", ")}</span>
                  <Button
                    size="small"
                    onClick={async () => {
                      await browser.permissions.remove({ origins: sites });
                      toast("Site access revoked.");
                      perms.run();
                    }}
                  >
                    Revoke all
                  </Button>
                </div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Section>
  );
}

function Capture() {
  const toast = useToast();
  const state = useAsync(async () => (await browser.scripting.getRegisteredContentScripts({ ids: ERROR_SCRIPT_IDS })).length > 0, []);
  return (
    <Section
      title="Error capture"
      hint="Records JavaScript errors, failed resources and console.error on every page from its first script, and shows the count on the toolbar icon."
    >
      <div className="row">
        <span className="grow">{state.data ? "On" : "Off"}</span>
        {state.data ? (
          <Button
            onClick={async () => {
              await disableErrorCapture();
              state.run();
            }}
          >
            Turn off
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={async () => ((await enableErrorCapture()) ? state.run() : toast("Needs access to all sites.", true))}
          >
            Turn on
          </Button>
        )}
      </div>
    </Section>
  );
}

function Backup() {
  const toast = useToast();
  return (
    <Section title="Backup" hint="Request rules and environment groups. AI keys are never exported.">
      <div className="row">
        <Button
          onClick={async () => {
            const data = await browser.storage.local.get([RULES_KEY, ENVS_KEY]);
            download("devkit-backup.json", JSON.stringify({ version: 1, ...data }, null, 2));
          }}
        >
          Export
        </Button>
        <Button
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json";
            input.onchange = async () => {
              const f = input.files?.[0];
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                if (data[ENVS_KEY]) await browser.storage.local.set({ [ENVS_KEY]: data[ENVS_KEY] });
                if (data[RULES_KEY]) await saveRules(data[RULES_KEY]);
                toast(`Restored ${(await loadRules()).length} rules and ${(data[ENVS_KEY] ?? []).length} env groups.`);
              } catch (e) {
                toast(`Import failed: ${e}`, true);
              }
            };
            input.click();
          }}
        >
          Import
        </Button>
      </div>
    </Section>
  );
}

export function OptionsApp() {
  return (
    <ToastProvider>
      <div className="options">
        <header className="row options-head">
          <img src="/icon/48.png" alt="" width={32} height={32} />
          <div>
            <h1>devkit</h1>
            <span className="muted small">Settings</span>
          </div>
        </header>
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <AiSettings />
        </Suspense>
        <Permissions />
        <Capture />
        <Backup />
        <Section title="Keyboard shortcuts">
          <Notice>
            <span className="grow">Alt+Shift+D palette · Alt+Shift+S side panel · Alt+Shift+X fresh start.</span>
            <Button size="small" onClick={() => browser.tabs.create({ url: "chrome://extensions/shortcuts" })}>
              Change
            </Button>
          </Notice>
        </Section>
      </div>
    </ToastProvider>
  );
}
