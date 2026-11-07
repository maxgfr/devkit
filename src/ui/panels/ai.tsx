import type { ModelMessage } from "ai";
import {
  type Capabilities,
  type Effort,
  effortLevels,
  ENDPOINT_PRESETS,
  isConfigured,
  type LlmSettings,
  providerKindOf,
  RESPONSE_LANGUAGES,
} from "llm-connect";
import { useLlmSettings } from "llm-connect/react";
import type { UnifiedModel } from "llm-models";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { estimateCost, formatUsd, unifiedModels } from "../../lib/ai/catalog";
import { type ContextPart, contextBudget, PART_LABELS, renderContext } from "../../lib/ai/context";
import { gatherContext } from "../../lib/ai/gather";
import { AI_ACTIONS, type AiAction, SYSTEM_PROMPT } from "../../lib/ai/prompts";
import { capabilitiesOf, streamAnswer } from "../../lib/ai/run";
import { aiStore } from "../../lib/ai/settings";
import { ensurePermission } from "../../lib/permissions";
import { Button, Code, CopyButton, Empty, ErrorText, Notice, Section, useToast } from "../components";
import { useAsync, useStored } from "../hooks";
import { AccessGate, usePage } from "../page";

/* Settings */

export function AiSettings({ onSaved }: { onSaved?: () => void }) {
  const store = aiStore();
  const state = useLlmSettings(store);
  const toast = useToast();
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    store.load().then(() => store.open());
  }, [store]);
  const d = state.draft;
  const providers = [...state.providers.recommended, ...state.providers.others];
  return (
    <Section
      title="AI settings"
      hint="Bring your own model: any provider from the llm-models catalog, or a local OpenAI-compatible server. The key is encrypted on this device (AES-GCM, non-extractable key) and only sent to the provider."
    >
      <div className="row">
        <label className="check">
          <input type="radio" checked={!d.custom} onChange={() => store.toggleCustom(false)} /> Provider
        </label>
        <label className="check">
          <input type="radio" checked={d.custom} onChange={() => store.toggleCustom(true)} /> Local / custom endpoint
        </label>
      </div>
      {d.custom ? (
        <>
          <div className="row">
            {Object.values(ENDPOINT_PRESETS).map((p) => (
              <Button key={p.id} size="small" onClick={() => store.applyPreset(p)}>
                {p.name}
              </Button>
            ))}
          </div>
          <label className="field">
            Endpoint (OpenAI-compatible, ends in /v1)
            <input
              className="mono"
              value={d.customEndpoint}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => store.setEndpoint(e.target.value)}
            />
          </label>
          <label className="field">
            Model
            <input className="mono" value={d.customModel} placeholder="llama3.2" onChange={(e) => store.setCustomModel(e.target.value)} />
          </label>
          <p className="small muted" style={{ margin: 0 }}>
            Ollama refuses unknown origins: start it with <code>OLLAMA_ORIGINS=chrome-extension://*</code>.
          </p>
        </>
      ) : (
        <>
          {state.catalogStatus === "error" ? (
            <Notice kind="bad">
              <span className="grow">Catalog unavailable: {state.catalogError}</span>
              <Button size="small" onClick={() => store.retryCatalog()}>
                Retry
              </Button>
            </Notice>
          ) : null}
          <label className="field">
            Provider
            <select
              value={d.providerId}
              onChange={(e) => store.selectProvider(e.target.value)}
              disabled={state.catalogStatus === "loading"}
            >
              {state.catalogStatus === "loading" ? <option>Loading catalog…</option> : null}
              <optgroup label="Recommended">
                {state.providers.recommended.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Others">
                {state.providers.others.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="field">
            Model {state.recommendedModel ? <span className="muted">(recommended: {state.recommendedModel.name})</span> : null}
            <input type="search" placeholder="Search models" value={state.search} onChange={(e) => store.setSearch(e.target.value)} />
            <select
              aria-label="Model"
              value={d.model}
              onChange={(e) => store.selectModel(e.target.value)}
              size={Math.min(8, Math.max(3, state.models.length))}
            >
              {state.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} {m.reasoning ? "· reasoning" : ""} {m.input?.includes("image") ? "· vision" : ""}
                </option>
              ))}
            </select>
          </label>
          {providers.length === 0 && state.catalogStatus === "ready" ? <Empty>No provider in the catalog.</Empty> : null}
        </>
      )}
      <label className="field">
        API key {d.custom ? <span className="muted">(optional for local servers)</span> : null}
        <div className="row">
          <input
            className="grow mono"
            style={{ width: "auto" }}
            type={showKey ? "text" : "password"}
            value={state.apiKey}
            autoComplete="off"
            onChange={(e) => store.setApiKey(e.target.value)}
          />
          <Button size="small" onClick={() => setShowKey(!showKey)}>
            {showKey ? "Hide" : "Show"}
          </Button>
        </div>
      </label>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={d.rememberKey} onChange={(e) => store.setRememberKey(e.target.checked)} /> Remember the key on
          this device
        </label>
        <span className="grow" />
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          Answers in
          <select value={d.language} onChange={(e) => store.setLanguage(e.target.value)} style={{ width: "auto" }}>
            {RESPONSE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <Button
          busy={state.testing}
          disabled={!state.canTest}
          onClick={async () => {
            if (d.custom && d.customEndpoint)
              await ensurePermission({ origins: [`${new URL(d.customEndpoint).origin}/*`] }).catch(() => false);
            await store.test();
          }}
        >
          Test connection
        </Button>
        <Button
          variant="primary"
          disabled={!state.canSave}
          onClick={async () => {
            if (d.custom && d.customEndpoint)
              await ensurePermission({ origins: [`${new URL(d.customEndpoint).origin}/*`] }).catch(() => false);
            const r = await store.save();
            if (!r.ok)
              return toast(
                r.reason === "insecure-endpoint"
                  ? "Use https, or http only on localhost."
                  : r.reason === "invalid-endpoint"
                    ? "Invalid endpoint URL."
                    : "Pick a model and enter a key.",
                true,
              );
            toast(r.persisted ? "AI settings saved." : "Saved for this session only (storage refused the write).");
            onSaved?.();
          }}
        >
          Save
        </Button>
        <span className="grow" />
        <Button
          variant="danger"
          title="Forget the provider, model and key stored on this device"
          onClick={async () => {
            await store.clear();
            toast("AI settings and key cleared.");
          }}
        >
          Clear settings
        </Button>
      </div>
      {state.testResult ? (
        state.testResult.ok ? (
          <Notice kind="good">
            Connection works{state.testResult.modelCount ? ` · ${state.testResult.modelCount} models listed` : ""}.
          </Notice>
        ) : (
          <Notice kind="bad">
            {state.testResult.reason === "auth"
              ? "Key refused."
              : state.testResult.reason === "cors"
                ? "Key refused or network error."
                : state.testResult.reason === "insecure"
                  ? "Plain http is only allowed on localhost."
                  : "Connection failed."}{" "}
            {state.testResult.message ?? ""}
          </Notice>
        )
      ) : null}
    </Section>
  );
}

/* Model status */

function useModel() {
  const store = aiStore();
  const state = useLlmSettings(store);
  useEffect(() => {
    store.load();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "devkit-ai") store.load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [store]);
  const settings: LlmSettings | null = state.saved && isConfigured(state.saved) ? (state.saved as LlmSettings) : null;
  const caps = useAsync(
    async () => (settings ? capabilitiesOf(settings) : null),
    [settings?.model, settings?.customModel, settings?.providerId, settings?.customEndpoint],
  );
  return { settings, capabilities: caps.data ?? null, loading: caps.loading };
}

/* Chat */

interface Turn {
  role: "user" | "assistant";
  display: string;
  reasoning?: string;
  error?: string;
  stop?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: ({ node, children }) => {
            const code =
              node?.children?.[0] && "children" in node.children[0]
                ? (node.children[0].children[0] as { value?: string } | undefined)?.value
                : undefined;
            return code !== undefined ? <Code text={code.replace(/\n$/, "")} /> : <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const DEFAULT_CHAT_PARTS: ContextPart[] = ["text", "meta"];

export function Ask({ params }: { params?: Record<string, string> }) {
  const page = usePage();
  const toast = useToast();
  const { settings, capabilities } = useModel();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<ModelMessage[]>([]);
  const [input, setInput] = useState("");
  const [actionInput, setActionInput] = useState<{ action: AiAction; value: string } | null>(null);
  const [parts, setParts] = useStored<ContextPart[]>("aiChatParts", DEFAULT_CHAT_PARTS);
  const [effort, setEffort] = useStored<string>("aiEffort", "");
  const [webSearch, setWebSearch] = useStored<boolean>("aiWebSearch", false);
  const [busy, setBusy] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const handled = useRef<string | null>(null);

  const levels = useMemo(
    () => (settings ? effortLevels(providerKindOf(settings), settings.customModel || settings.model) : []),
    [settings],
  );
  const budget = contextBudget(capabilities?.contextWindow, capabilities?.maxOutput);

  const send = async (prompt: string, display: string, ctxParts: ContextPart[], selection?: string) => {
    if (!settings || !capabilities || !page.tab) return;
    if (ctxParts.includes("screenshot") && !capabilities.vision) return toast("This model does not read images.", true);
    setBusy("Reading the page…");
    let contextText = "";
    let screenshot: string | undefined;
    const firstTurn = history.length === 0 || ctxParts.length > 0;
    if (firstTurn && ctxParts.length && page.canScript) {
      const ctx = await gatherContext(page.tab, ctxParts, { selection });
      contextText = renderContext(ctx, ctxParts, budget);
      screenshot = ctx.screenshot ?? (capabilities.vision ? ctx.elementImage : undefined);
    } else if (selection) {
      contextText = `## Selected text\n\`\`\`\n${selection}\n\`\`\``;
    }
    const content = contextText ? `${contextText}\n\n# Request\n${prompt}` : prompt;
    const userMessage: ModelMessage = screenshot
      ? {
          role: "user",
          content: [
            { type: "text", text: content },
            { type: "image", image: screenshot },
          ],
        }
      : { role: "user", content };
    const messages = [...history, userMessage];
    setTurns((t) => [...t, { role: "user", display }, { role: "assistant", display: "" }]);
    setBusy("Thinking…");
    const ctrl = new AbortController();
    abort.current = ctrl;
    const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1]!)]);
    const outcome = await streamAnswer(
      settings,
      SYSTEM_PROMPT,
      messages,
      { effort: (effort || null) as Effort | null, webSearch, capabilities, signal: ctrl.signal },
      {
        onText: (delta) => {
          setBusy(null);
          patchLast((t) => ({ ...t, display: t.display + delta }));
        },
        onReasoning: (delta) => patchLast((t) => ({ ...t, reasoning: (t.reasoning ?? "") + delta })),
      },
    );
    abort.current = null;
    setBusy(null);
    patchLast((t) => ({ ...t, error: outcome.error, stop: outcome.stop, usage: outcome.usage }));
    if (!outcome.error && outcome.stop !== "aborted") setHistory([...messages, ...outcome.messages]);
  };

  const runAction = (action: AiAction, extra?: string, selection?: string) => {
    if (action.input && extra === undefined) return setActionInput({ action, value: "" });
    setActionInput(null);
    const prompt = extra ? `${action.prompt}\n\nThe user asks for: ${extra}` : action.prompt;
    return send(prompt, extra ? `${action.title}: ${extra}` : action.title, action.parts, selection);
  };

  // Opened from a context menu or the palette with an action to run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per route
  useEffect(() => {
    const id = params?.action;
    const key = params ? JSON.stringify(params) : null;
    if (!id || !settings || !capabilities || !page.tab || handled.current === key) return;
    handled.current = key;
    const action = AI_ACTIONS.find((a) => a.id === id);
    if (action) runAction(action, undefined, params?.selection);
  }, [params, settings, capabilities, page.tab]);

  // Leaving the panel drops the conversation: stop the stream too, so it does not keep spending tokens unseen.
  useEffect(() => () => abort.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new delta
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  if (!settings)
    return (
      <>
        <Notice kind="warn">No model configured yet. Pick a provider and paste a key, or point devkit at Ollama / LM Studio.</Notice>
        <AiSettings />
      </>
    );

  const cost = capabilities?.cost;
  const modelLine = settings.customEndpoint
    ? `${settings.customModel} @ ${new URL(settings.customEndpoint).host}`
    : `${settings.model} · ${settings.providerName ?? settings.providerId}`;
  const estimate = (chars: number) => {
    const tokens = Math.min(Math.ceil(chars / 4), Math.ceil(budget / 4));
    return `≈${(tokens / 1000).toFixed(1)}k tokens in · ${formatUsd(estimateCost(cost, tokens, 1500))}`;
  };

  return (
    <>
      <div className="card stack">
        <div className="row small">
          <b className="grow ellipsis" title={modelLine}>
            {modelLine}
          </b>
          {capabilities ? (
            <>
              <span className="pill">{Math.round(capabilities.contextWindow / 1000)}k ctx</span>
              {cost ? (
                <span className="pill" title="USD per million tokens, input / output">
                  ${cost.input} / ${cost.output}
                </span>
              ) : null}
              {capabilities.vision ? <span className="pill">vision</span> : null}
            </>
          ) : null}
        </div>
        <div className="row small">
          {levels.length ? (
            <label className="check">
              Effort
              <select value={effort} onChange={(e) => setEffort(e.target.value)} style={{ width: "auto" }}>
                <option value="">default</option>
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {capabilities?.webSearch ? (
            <label className="check">
              <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> Web search
            </label>
          ) : null}
          <span className="grow" />
          {turns.length ? (
            <Button
              size="small"
              onClick={() => {
                abort.current?.abort();
                setTurns([]);
                setHistory([]);
              }}
            >
              New chat
            </Button>
          ) : null}
        </div>
      </div>
      <AccessGate />
      {turns.length === 0 ? (
        <Section title="Analyze this page" hint={`Each analysis sends the listed page data to ${settings.providerName ?? "your model"}.`}>
          <div className="grid2">
            {AI_ACTIONS.filter((a) => !a.hidden && (!a.needsVision || capabilities?.vision)).map((a) => (
              <button
                key={a.id}
                type="button"
                className="action"
                disabled={Boolean(busy) || !page.canScript}
                onClick={() => runAction(a)}
                title={`Sends: ${a.parts.map((p) => PART_LABELS[p]).join(", ")}`}
              >
                <strong>{a.title}</strong>
                <span>{a.description}</span>
              </button>
            ))}
          </div>
          {actionInput ? (
            <div className="card stack">
              <label className="field">
                {actionInput.action.input?.label}
                <input
                  autoFocus
                  value={actionInput.value}
                  placeholder={actionInput.action.input?.placeholder}
                  onChange={(e) => setActionInput({ ...actionInput, value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && actionInput.value && runAction(actionInput.action, actionInput.value)}
                />
              </label>
              <div className="row">
                <Button variant="primary" disabled={!actionInput.value} onClick={() => runAction(actionInput.action, actionInput.value)}>
                  Run
                </Button>
                <Button onClick={() => setActionInput(null)}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </Section>
      ) : (
        <div className="chat" role="log" aria-label="Conversation" aria-busy={abort.current !== null}>
          {turns.map((t, i) =>
            t.role === "user" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: conversation order
              <div key={i} className="msg user">
                {t.display}
              </div>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: conversation order
              <div key={i} className="msg assistant stack">
                {t.reasoning ? (
                  <details>
                    <summary className="small muted">Reasoning</summary>
                    <div className="reasoning">{t.reasoning}</div>
                  </details>
                ) : null}
                {t.display ? <Markdown text={t.display} /> : !t.error ? <span className="muted">{busy ?? "…"}</span> : null}
                {t.error ? <ErrorText error={t.error} /> : null}
                {t.stop && t.stop !== "end" && !t.error ? (
                  <span className="small t-warn">Stopped: {t.stop === "length" ? "output limit reached" : t.stop}</span>
                ) : null}
                {t.display && t.stop ? (
                  <div className="row small muted">
                    <CopyButton text={t.display} />
                    {t.usage?.inputTokens !== undefined ? (
                      <span>
                        {t.usage.inputTokens} in · {t.usage.outputTokens} out ·{" "}
                        {formatUsd(estimateCost(cost, t.usage.inputTokens ?? 0, t.usage.outputTokens ?? 0))}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      )}
      <Section title={turns.length ? "Follow up" : "Or ask anything about the page"}>
        <div className="row small" hidden={history.length > 0}>
          {(Object.keys(PART_LABELS) as ContextPart[])
            .filter((p) => p !== "screenshot" || capabilities?.vision)
            .map((p) => (
              <label key={p} className="check">
                <input
                  type="checkbox"
                  checked={parts.includes(p)}
                  onChange={(e) => setParts(e.target.checked ? [...parts, p] : parts.filter((x) => x !== p))}
                />
                {PART_LABELS[p]}
              </label>
            ))}
        </div>
        <textarea
          rows={3}
          placeholder="Why is this page slow? What does this API return? Write a scraper for this table… (Ctrl+Enter)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && input.trim() && !busy) {
              send(input, input, history.length ? [] : parts);
              setInput("");
            }
          }}
          style={{ fontFamily: "var(--sans)", fontSize: 13 }}
        />
        <div className="row">
          {abort.current ? (
            <Button onClick={() => abort.current?.abort()}>Stop</Button>
          ) : (
            <Button
              variant="primary"
              disabled={!input.trim() || Boolean(busy)}
              onClick={() => {
                send(input, input, history.length ? [] : parts);
                setInput("");
              }}
            >
              Send
            </Button>
          )}
          <span className="muted small">
            {history.length ? "Follow-ups reuse the page data already sent." : estimate(parts.includes("text") ? budget : 6000)}
          </span>
        </div>
      </Section>
    </>
  );
}

/* Model browser */

type SortKey = "name" | "input" | "output" | "context";

export function Models() {
  const models = useAsync(unifiedModels, []);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("input");
  const [filters, setFilters] = useState({ vision: false, reasoning: false, tools: false, priced: true, open: false });
  const rows = useMemo(() => {
    const all = models.data ?? [];
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = all.filter((m: UnifiedModel) => {
      const hay = `${m.id} ${m.name} ${m.provider} ${m.family ?? ""}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
      if (filters.vision && !m.modalities.input.includes("image")) return false;
      if (filters.reasoning && !m.capabilities.reasoning) return false;
      if (filters.tools && !m.capabilities.tool_call) return false;
      if (filters.priced && !m.cost) return false;
      if (filters.open && !m.capabilities.open_weights) return false;
      return true;
    });
    const key = (m: UnifiedModel) =>
      sort === "input"
        ? (m.cost?.input ?? Infinity)
        : sort === "output"
          ? (m.cost?.output ?? Infinity)
          : sort === "context"
            ? -m.context_length
            : 0;
    return out.sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : key(a) - key(b))).slice(0, 300);
  }, [models.data, q, sort, filters]);
  return (
    <Section
      title={`Model browser${models.data ? ` (${models.data.length})` : ""}`}
      hint="Live from models.dev and OpenRouter through llm-models. Prices are USD per million tokens."
    >
      <ErrorText error={models.error} />
      <input
        aria-label="Search models"
        type="search"
        placeholder="Search: claude, gemini flash, qwen coder…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="row small">
        {(Object.keys(filters) as (keyof typeof filters)[]).map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={filters[k]} onChange={(e) => setFilters({ ...filters, [k]: e.target.checked })} />
            {k === "priced" ? "has price" : k === "open" ? "open weights" : k}
          </label>
        ))}
        <span className="grow" />
        <select aria-label="Sort models" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: "auto" }}>
          <option value="input">cheapest input</option>
          <option value="output">cheapest output</option>
          <option value="context">largest context</option>
          <option value="name">name</option>
        </select>
      </div>
      {models.loading ? <Empty>Loading the catalog (a few MB, cached for an hour)…</Empty> : null}
      {models.data && !rows.length ? <Empty>No model matches these filters.</Empty> : null}
      <ul className="list models">
        {rows.map((m) => (
          <li key={`${m.provider}/${m.id}`}>
            <div className="row">
              <b className="grow ellipsis" title={m.name}>
                {m.name}
              </b>
              <span className="mono price" title="USD per million tokens, input / output">
                {m.cost ? `$${m.cost.input} / $${m.cost.output}` : "–"}
              </span>
            </div>
            <div className="mono small muted ellipsis" title={`${m.provider}/${m.id}`}>
              {m.provider}/{m.id}
            </div>
            <div className="small muted">
              {Math.round(m.context_length / 1000)}k context{m.output_limit ? ` · ${Math.round(m.output_limit / 1000)}k out` : ""}
              {m.modalities.input.includes("image") ? " · vision" : ""}
              {m.capabilities.reasoning ? " · reasoning" : ""}
              {m.knowledge_cutoff ? ` · cutoff ${m.knowledge_cutoff}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export type { Capabilities };
