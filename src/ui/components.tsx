import { Component, createContext, type ReactNode, useCallback, useContext, useState } from "react";
import type { Level } from "../lib/headers";

export function Button({
  variant,
  size,
  busy,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost"; size?: "small"; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={["btn", variant, size, props.className].filter(Boolean).join(" ")}
      aria-busy={busy || undefined}
    >
      {busy ? "…" : null}
      {children}
    </button>
  );
}

export function Section({
  title,
  actions,
  children,
  hint,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <section className="section">
      <header>
        <h2>{title}</h2>
        {actions ? <div className="row">{actions}</div> : null}
      </header>
      {hint ? (
        <p className="muted small" style={{ margin: 0 }}>
          {hint}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "bad" | "good"; children: ReactNode }) {
  return (
    <div className={`notice ${kind}`} role={kind === "bad" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Dot({ level }: { level: Level | "error" }) {
  return <span className={`dot ${level}`} role="img" aria-label={level} />;
}

export function Checks({ checks }: { checks: { id: string; label: string; level: Level; detail: string }[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id}>
          <Dot level={c.level} />
          <span className="label">{c.label}</span>
          <span className="detail">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <table className="kv">
      <tbody>
        {rows.map(([k, v], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static rows
          <tr key={i}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Metric({ label, value, level }: { label: string; value: ReactNode; level?: Level }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b className={level ? `t-${level}` : undefined}>{value}</b>
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="small"
      className={className}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

export function Code({ text, maxHeight, empty = "Nothing yet." }: { text: string; maxHeight?: number; empty?: string }) {
  if (!text) return <p className="code-empty">{empty}</p>;
  return (
    <div className="code-wrap">
      <pre className="code" style={maxHeight ? { maxHeight } : undefined}>
        {text}
      </pre>
      <CopyButton text={text} className="copy" />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="muted" style={{ margin: "4px 0" }}>
      {children}
    </p>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <Notice kind="bad">{error instanceof Error ? error.message : String(error)}</Notice>;
}

export function download(filename: string, content: string | Blob, type = "application/json") {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function bytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function msText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

/* JSON tree */
export function JsonTree({ value, name, depth = 0, open = 2 }: { value: unknown; name?: string; depth?: number; open?: number }) {
  const key = name !== undefined ? <span className="k">{name}: </span> : null;
  if (value === null || typeof value !== "object") {
    const cls = typeof value === "string" ? "s" : typeof value === "number" ? "n" : "b";
    return (
      <div>
        {key}
        <span className={cls}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const label = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  const type =
    !Array.isArray(value) && typeof (value as Record<string, unknown>)["@type"] === "string"
      ? ` ${(value as Record<string, unknown>)["@type"]}`
      : "";
  return (
    <details open={depth < open}>
      <summary>
        {key}
        <span className="muted">
          {label}
          {type}
        </span>
      </summary>
      <div className="children">
        {entries.map(([k, v]) => (
          <JsonTree key={k} name={k} value={v} depth={depth + 1} open={open} />
        ))}
      </div>
    </details>
  );
}

/* Toasts */
interface Toast {
  id: number;
  text: string;
  error?: boolean;
}
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 2800);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Keeps one broken tool from blanking the whole panel: shows its error and a way back. */
export class PanelBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Notice kind="bad">
        <div className="stack">
          <strong>This tool crashed.</strong>
          <span className="small mono">{this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}</span>
          <div className="row">
            <Button size="small" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </div>
        </div>
      </Notice>
    );
  }
}
