import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { loadRules, type NetRule, newRule, type RuleKind, ruleProblem, saveRules } from "../../lib/dnr";
import { type Env, type EnvGroup, ENVS_KEY, matchEnv, normalizeOrigin, switchUrl } from "../../lib/envs";
import { ALL_SITES, ensurePermission } from "../../lib/permissions";
import { Button, download, Empty, Notice, Section, useToast } from "../components";
import { useStored } from "../hooks";
import { usePage } from "../page";

const KIND_LABEL: Record<RuleKind, string> = { header: "Header", redirect: "Redirect", block: "Block", cors: "CORS" };

export function Rules() {
  const toast = useToast();
  const [rules, setRules] = useState<NetRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [hasAccess, setHasAccess] = useState(true);
  useEffect(() => {
    loadRules().then(setRules);
    browser.permissions.contains({ origins: [ALL_SITES] }).then(setHasAccess);
  }, []);
  const update = (id: string, patch: Partial<NetRule>) => {
    setRules((rs) => rs.map((r) => (r.id === id ? ({ ...r, ...patch } as NetRule) : r)));
    setDirty(true);
  };
  const apply = async (next = rules) => {
    if (!(await ensurePermission({ origins: [ALL_SITES] }))) return toast("Request rules need access to all sites.", true);
    setHasAccess(true);
    const bad = next.find((r) => r.enabled && ruleProblem(r));
    if (bad) return toast(`${bad.name || KIND_LABEL[bad.kind]}: ${ruleProblem(bad)}`, true);
    try {
      await saveRules(next);
      setDirty(false);
      toast(`${next.filter((r) => r.enabled).length} rule(s) active.`);
    } catch (e) {
      toast(`Chrome refused the rules: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  return (
    <Section
      title={`Request rules (${rules.filter((r) => r.enabled).length} active)`}
      hint="Applied by Chrome to every tab (declarativeNetRequest). URL filters use DNR syntax: ||api.example.com/v1/ matches the domain and its subdomains, * is a wildcard, | anchors."
      actions={
        <>
          <Button size="small" onClick={() => download("devkit-rules.json", JSON.stringify(rules, null, 2))}>
            Export
          </Button>
          <Button
            size="small"
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "application/json";
              input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) return;
                try {
                  const imported = (JSON.parse(await f.text()) as NetRule[]).map((r) => ({ ...r, id: crypto.randomUUID() }));
                  setRules([...rules, ...imported]);
                  setDirty(true);
                } catch (e) {
                  toast(`Import failed: ${e}`, true);
                }
              };
              input.click();
            }}
          >
            Import
          </Button>
        </>
      }
    >
      {!hasAccess ? (
        <Notice kind="warn">Rules that modify headers or redirect need access to all sites. devkit asks when you apply them.</Notice>
      ) : null}
      <div className="row">
        {(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => (
          <Button
            key={k}
            size="small"
            onClick={() => {
              setRules([...rules, newRule(k)]);
              setDirty(true);
            }}
          >
            + {KIND_LABEL[k]}
          </Button>
        ))}
        <span className="grow" />
        <Button variant="primary" disabled={!dirty} onClick={() => apply()}>
          Apply
        </Button>
      </div>
      {rules.length ? (
        rules.map((r) => (
          <div key={r.id} className="card stack">
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.id, { enabled: e.target.checked })} />
                <span className="pill accent">{KIND_LABEL[r.kind]}</span>
              </label>
              <input
                className="grow"
                style={{ width: "auto" }}
                placeholder="Name (optional)"
                value={r.name}
                onChange={(e) => update(r.id, { name: e.target.value })}
              />
              <Button
                size="small"
                variant="danger"
                onClick={() => {
                  setRules(rules.filter((x) => x.id !== r.id));
                  setDirty(true);
                }}
              >
                Remove
              </Button>
            </div>
            <input
              className="mono"
              placeholder={r.kind === "redirect" && r.regex ? "^https://cdn\\.example\\.com/(.*)$" : "||example.com/api/"}
              value={r.match}
              onChange={(e) => update(r.id, { match: e.target.value })}
              aria-label="URL filter"
            />
            {r.kind === "header" ? (
              <div className="row">
                <select
                  value={r.target}
                  onChange={(e) => update(r.id, { target: e.target.value as "request" | "response" })}
                  style={{ width: "auto" }}
                >
                  <option value="request">Request</option>
                  <option value="response">Response</option>
                </select>
                <select
                  value={r.operation}
                  onChange={(e) => update(r.id, { operation: e.target.value as "set" | "append" | "remove" })}
                  style={{ width: "auto" }}
                >
                  <option value="set">set</option>
                  <option value="append">append</option>
                  <option value="remove">remove</option>
                </select>
                <input
                  className="grow mono"
                  style={{ width: "auto" }}
                  placeholder="x-feature-flag"
                  value={r.header}
                  onChange={(e) => update(r.id, { header: e.target.value })}
                />
                {r.operation !== "remove" ? (
                  <input
                    className="grow mono"
                    style={{ width: "auto" }}
                    placeholder="value"
                    value={r.value}
                    onChange={(e) => update(r.id, { value: e.target.value })}
                  />
                ) : null}
              </div>
            ) : null}
            {r.kind === "redirect" ? (
              <div className="row">
                <label className="check small">
                  <input type="checkbox" checked={r.regex} onChange={(e) => update(r.id, { regex: e.target.checked })} /> Regex
                </label>
                <input
                  className="grow mono"
                  style={{ width: "auto" }}
                  placeholder={r.regex ? "http://localhost:3000/\\1" : "http://localhost:3000/app.js"}
                  value={r.to}
                  onChange={(e) => update(r.id, { to: e.target.value })}
                />
              </div>
            ) : null}
            {r.kind === "cors" ? (
              <label className="field">
                Allowed origin (* or the page origin to allow credentials)
                <input className="mono" value={r.origin} onChange={(e) => update(r.id, { origin: e.target.value })} />
              </label>
            ) : null}
            {r.enabled && ruleProblem(r) ? <div className="small t-warn">{ruleProblem(r)}</div> : null}
          </div>
        ))
      ) : (
        <Empty>
          No rule. Add one: set a header on API calls, map prod assets to localhost, block a third party, or unblock CORS on a dev API.
        </Empty>
      )}
    </Section>
  );
}

const COLORS = ["#16a34a", "#2563eb", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

export function Envs() {
  const page = usePage();
  const toast = useToast();
  const [groups, setGroups] = useStored<EnvGroup[]>(ENVS_KEY, []);
  const current = matchEnv(groups, page.url);
  const edit = (gid: string, fn: (g: EnvGroup) => EnvGroup) => setGroups(groups.map((g) => (g.id === gid ? fn(g) : g)));
  const setEnv = (gid: string, i: number, patch: Partial<Env>) =>
    edit(gid, (g) => ({ ...g, envs: g.envs.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  return (
    <>
      {current ? (
        <Section title={`${current.group.name}: you are on ${current.env.label}`}>
          <div className="row">
            {current.group.envs
              .filter((e) => e !== current.env)
              .map((e) => (
                <Button
                  key={e.origin}
                  onClick={() => page.tabId !== undefined && browser.tabs.update(page.tabId, { url: switchUrl(page.url, e) })}
                  onAuxClick={() => browser.tabs.create({ url: switchUrl(page.url, e) })}
                >
                  <span className="swatch" style={{ background: e.color, width: 10, height: 10 }} />
                  Open on {e.label}
                </Button>
              ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Same path, query and hash. Middle-click opens a new tab.
          </p>
        </Section>
      ) : page.origin ? (
        <Notice>
          <span className="grow small">{page.origin} is in no environment group.</span>
          <Button
            size="small"
            onClick={() =>
              setGroups([
                ...groups,
                {
                  id: crypto.randomUUID(),
                  name: new URL(page.origin!).hostname.replace(/^www\./, ""),
                  envs: [
                    { label: "local", origin: "http://localhost:3000", color: COLORS[0]!, danger: false },
                    { label: "prod", origin: page.origin!, color: COLORS[3]!, danger: true },
                  ],
                },
              ])
            }
          >
            Create a group from this site
          </Button>
        </Notice>
      ) : null}
      <Section
        title="Environment groups"
        hint="Pages of an env marked “danger” get a red ribbon and a badge, so you never test on prod by mistake. Needs access to all sites."
        actions={
          <Button
            size="small"
            onClick={async () => {
              if (!(await ensurePermission({ origins: [ALL_SITES] })))
                toast("Ribbons need access to all sites; switching still works.", true);
              await setGroups([
                ...groups,
                {
                  id: crypto.randomUUID(),
                  name: "New project",
                  envs: [{ label: "local", origin: "http://localhost:3000", color: COLORS[0]!, danger: false }],
                },
              ]);
            }}
          >
            + Group
          </Button>
        }
      >
        {groups.length ? null : <Empty>No group yet.</Empty>}
        {groups.map((g) => (
          <div key={g.id} className="card stack">
            <div className="row">
              <input
                className="grow"
                style={{ width: "auto", fontWeight: 600 }}
                value={g.name}
                onChange={(e) => edit(g.id, (x) => ({ ...x, name: e.target.value }))}
                aria-label="Group name"
              />
              <Button size="small" variant="danger" onClick={() => setGroups(groups.filter((x) => x.id !== g.id))}>
                Delete group
              </Button>
            </div>
            {g.envs.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: envs are edited in place
              <div key={i} className="row">
                <input
                  type="color"
                  value={e.color}
                  onChange={(ev) => setEnv(g.id, i, { color: ev.target.value })}
                  style={{ width: 28, padding: 0, border: 0, background: "none" }}
                  aria-label="Color"
                />
                <input
                  style={{ width: 80 }}
                  value={e.label}
                  onChange={(ev) => setEnv(g.id, i, { label: ev.target.value })}
                  aria-label="Label"
                />
                <input
                  className="grow mono"
                  style={{ width: "auto" }}
                  value={e.origin}
                  onChange={(ev) => setEnv(g.id, i, { origin: ev.target.value })}
                  onBlur={(ev) => setEnv(g.id, i, { origin: normalizeOrigin(ev.target.value) })}
                  aria-label="Origin"
                />
                <label className="check small">
                  <input type="checkbox" checked={e.danger} onChange={(ev) => setEnv(g.id, i, { danger: ev.target.checked })} /> danger
                </label>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => edit(g.id, (x) => ({ ...x, envs: x.envs.filter((_, j) => j !== i) }))}
                  aria-label="Remove env"
                >
                  ✕
                </Button>
              </div>
            ))}
            <div className="row">
              <Button
                size="small"
                onClick={() =>
                  edit(g.id, (x) => ({
                    ...x,
                    envs: [
                      ...x.envs,
                      {
                        label: "staging",
                        origin: "https://staging.example.com",
                        color: COLORS[x.envs.length % COLORS.length]!,
                        danger: false,
                      },
                    ],
                  }))
                }
              >
                + Environment
              </Button>
              {page.origin && !g.envs.some((e) => normalizeOrigin(e.origin) === page.origin) ? (
                <Button
                  size="small"
                  onClick={() =>
                    edit(g.id, (x) => ({
                      ...x,
                      envs: [
                        ...x.envs,
                        {
                          label: new URL(page.origin!).hostname.split(".")[0] ?? "env",
                          origin: page.origin!,
                          color: COLORS[x.envs.length % COLORS.length]!,
                          danger: false,
                        },
                      ],
                    }))
                  }
                >
                  + This site
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
