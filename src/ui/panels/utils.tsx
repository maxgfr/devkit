import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { readBodyText } from "../../lib/page/collect";
import { runInTab } from "../../lib/inject";
import { contrast, parseColor, toHex, toHsl, toRgb } from "../../lib/utils/color";
import { explainCron } from "../../lib/utils/cron";
import { diffLines } from "../../lib/utils/diff";
import { type Codec, decodeWith, encodeWith } from "../../lib/utils/encode";
import { HASH_ALGOS, hash, hmac, sri } from "../../lib/utils/hash";
import { jsonPaths, parseJson, sortKeys, toTypeScript } from "../../lib/utils/json";
import { decodeJwt } from "../../lib/utils/jwt";
import { runRegex } from "../../lib/utils/regex";
import { parseTime } from "../../lib/utils/time";
import { inspectUuid, nanoid, uuidV4, uuidV7 } from "../../lib/utils/uuid";
import { Button, Code, CopyButton, download, Empty, ErrorText, JsonTree, KV, Notice, Section, useToast } from "../components";
import { useStored } from "../hooks";
import { usePage } from "../page";

export function Json() {
  const page = usePage();
  const toast = useToast();
  const [text, setText] = useStored("util.json", "");
  const [view, setView] = useState<"pretty" | "tree" | "ts" | "paths" | "min">("pretty");
  const [sorted, setSorted] = useState(false);
  const parsed = useMemo(() => (text.trim() ? parseJson(text) : null), [text]);
  const value = parsed?.ok ? (sorted ? sortKeys(parsed.value) : parsed.value) : undefined;
  const out = !parsed?.ok
    ? ""
    : view === "pretty"
      ? JSON.stringify(value, null, 2)
      : view === "min"
        ? JSON.stringify(value)
        : view === "ts"
          ? toTypeScript(value)
          : view === "paths"
            ? jsonPaths(value).join("\n")
            : "";
  return (
    <Section
      title="JSON"
      actions={
        <>
          <Button
            size="small"
            disabled={!page.canScript}
            onClick={async () => {
              if (page.tabId === undefined) return;
              try {
                setText(await runInTab(page.tabId, readBodyText));
              } catch (e) {
                toast(String(e), true);
              }
            }}
          >
            From tab
          </Button>
          <Button size="small" onClick={async () => setText(await navigator.clipboard.readText())}>
            Paste
          </Button>
        </>
      }
    >
      <textarea rows={8} value={text} placeholder='{"paste": "JSON here"}' onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {parsed && !parsed.ok ? (
        <Notice kind="bad">
          Invalid JSON{parsed.line ? ` at line ${parsed.line}, column ${parsed.column}` : ""}: {parsed.error}
        </Notice>
      ) : null}
      {parsed?.ok ? (
        <>
          <div className="row">
            {(["pretty", "tree", "min", "ts", "paths"] as const).map((v) => (
              <Button key={v} size="small" variant={view === v ? "primary" : undefined} onClick={() => setView(v)}>
                {v === "ts" ? "TypeScript" : v === "min" ? "Minify" : v[0]!.toUpperCase() + v.slice(1)}
              </Button>
            ))}
            <label className="check small">
              <input type="checkbox" checked={sorted} onChange={(e) => setSorted(e.target.checked)} /> Sort keys
            </label>
            <span className="grow" />
            <Button size="small" onClick={() => setText(JSON.stringify(value, null, 2))}>
              Format input
            </Button>
            <Button size="small" onClick={() => download("data.json", JSON.stringify(value, null, 2))}>
              Download
            </Button>
          </div>
          {view === "tree" ? (
            <div className="tree card">
              <JsonTree value={value} />
            </div>
          ) : (
            <Code text={out} />
          )}
        </>
      ) : null}
    </Section>
  );
}

export function Jwt() {
  const [token, setToken] = useStored("util.jwt", "");
  const decoded = useMemo(() => {
    if (!token.trim()) return null;
    try {
      return { ok: true as const, value: decodeJwt(token) };
    } catch (e) {
      return { ok: false as const, error: e };
    }
  }, [token]);
  return (
    <Section title="JWT decoder" hint="Decoded locally; the signature is not verified (devkit does not know the key).">
      <textarea rows={4} value={token} placeholder="eyJhbGciOi…" onChange={(e) => setToken(e.target.value)} spellCheck={false} />
      {decoded && !decoded.ok ? <ErrorText error={decoded.error} /> : null}
      {decoded?.ok ? (
        <>
          {decoded.value.expired !== null ? (
            <Notice kind={decoded.value.expired ? "bad" : "good"}>{decoded.value.expired ? "Expired." : "Not expired."}</Notice>
          ) : null}
          {decoded.value.claims.length ? <KV rows={decoded.value.claims.map((c) => [c.name, c.value])} /> : null}
          <h3>Header</h3>
          <Code text={JSON.stringify(decoded.value.header, null, 2)} />
          <h3>Payload</h3>
          <Code text={JSON.stringify(decoded.value.payload, null, 2)} />
        </>
      ) : null}
    </Section>
  );
}

const CODECS: [Codec, string][] = [
  ["base64", "Base64"],
  ["base64url", "Base64url"],
  ["url-component", "URL component"],
  ["url", "URL (full)"],
  ["html", "HTML entities"],
  ["hex", "Hex (UTF-8)"],
  ["unicode", "Unicode escapes"],
];

export function Encode() {
  const [text, setText] = useStored("util.encode", "");
  const [codec, setCodec] = useState<Codec>("base64");
  const run = (fn: () => string) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return { ok: false, value: e instanceof Error ? e.message : String(e) };
    }
  };
  const enc = run(() => encodeWith(codec, text));
  const dec = run(() => decodeWith(codec, text));
  return (
    <Section
      title="Encode / decode"
      actions={
        <select value={codec} onChange={(e) => setCodec(e.target.value as Codec)} style={{ width: "auto" }}>
          {CODECS.map(([c, l]) => (
            <option key={c} value={c}>
              {l}
            </option>
          ))}
        </select>
      }
    >
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to encode or decode" />
      <h3>Encoded</h3>
      <Code text={enc.value} />
      <h3>Decoded</h3>
      {dec.ok ? (
        <Code text={dec.value} />
      ) : (
        <span className="small muted">
          Not valid {codec}: {dec.value}
        </span>
      )}
    </Section>
  );
}

export function Hash() {
  const [text, setText] = useStored("util.hash", "");
  const [key, setKey] = useState("");
  const [rows, setRows] = useState<[string, string][]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: [string, string][] = [];
      for (const a of HASH_ALGOS) out.push([a, (await hash(a, text)).hex]);
      out.push(["SRI (sha384)", await sri(text)]);
      if (key) out.push(["HMAC-SHA256", await hmac("SHA-256", key, text)]);
      if (live) setRows(out);
    })();
    return () => {
      live = false;
    };
  }, [text, key]);
  return (
    <Section title="Hash & SRI">
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Text to hash (UTF-8)" />
      <input placeholder="HMAC key (optional)" value={key} onChange={(e) => setKey(e.target.value)} />
      <table className="kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>
                <div className="row">
                  <span className="grow break">{v}</span>
                  <CopyButton text={v} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

export function Ids() {
  const [ids, setIds] = useState<string[]>([]);
  const [kind, setKind] = useState<"v4" | "v7" | "nanoid">("v7");
  const [count, setCount] = useState(5);
  const [inspect, setInspect] = useState("");
  const gen = () =>
    setIds(
      Array.from({ length: Math.min(500, Math.max(1, count)) }, () => (kind === "v4" ? uuidV4() : kind === "v7" ? uuidV7() : nanoid())),
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: regenerate on kind change
  useEffect(gen, [kind]);
  const info = inspect ? inspectUuid(inspect) : null;
  return (
    <Section title="UUID & IDs">
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} style={{ width: "auto" }}>
          <option value="v7">UUID v7 (time-sortable)</option>
          <option value="v4">UUID v4 (random)</option>
          <option value="nanoid">nanoid (21 chars)</option>
        </select>
        <input
          type="number"
          min={1}
          max={500}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          style={{ width: 70 }}
          aria-label="Count"
        />
        <Button variant="primary" onClick={gen}>
          Generate
        </Button>
      </div>
      <Code text={ids.join("\n")} />
      <h3>Inspect a UUID</h3>
      <input className="mono" value={inspect} onChange={(e) => setInspect(e.target.value)} placeholder="0190f1c4-…" />
      {inspect ? (
        info ? (
          <KV
            rows={[
              ["Version", info.version],
              ["Variant", info.variant],
              ...(info.time ? [["Created", info.time] as [string, string]] : []),
            ]}
          />
        ) : (
          <span className="small t-bad">Not a UUID.</span>
        )
      ) : null}
    </Section>
  );
}

export function Time() {
  const [input, setInput] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const v = parseTime(input);
  const now = Date.now();
  return (
    <Section title="Timestamps" hint="Unix seconds, milliseconds, µs or ns, or any date string (ISO 8601, RFC 2822…).">
      <div className="row">
        <input className="grow mono" style={{ width: "auto" }} value={input} onChange={(e) => setInput(e.target.value)} />
        <Button onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>Now</Button>
      </div>
      {v ? (
        <KV
          rows={[
            [
              "ISO 8601",
              <span key="i" className="row">
                <span className="grow">{v.iso}</span>
                <CopyButton text={v.iso} />
              </span>,
            ],
            [
              "Unix (s)",
              <span key="s" className="row">
                <span className="grow">{v.unix}</span>
                <CopyButton text={String(v.unix)} />
              </span>,
            ],
            [
              "Unix (ms)",
              <span key="m" className="row">
                <span className="grow">{v.unixMs}</span>
                <CopyButton text={String(v.unixMs)} />
              </span>,
            ],
            ["UTC", v.utc],
            ["Local", v.local],
            ["Relative", v.relative],
          ]}
        />
      ) : (
        <span className="small t-bad">Not a date.</span>
      )}
      <div className="small muted mono">
        now: {Math.floor(now / 1000)} · {new Date(now).toISOString()}
      </div>
    </Section>
  );
}

export function Regex() {
  const [pattern, setPattern] = useStored("util.regex.pattern", "(\\w+)@(\\w+)\\.com");
  const [flags, setFlags] = useStored("util.regex.flags", "gi");
  const [text, setText] = useStored("util.regex.text", "alice@example.com, bob@test.com");
  const [replace, setReplace] = useState("");
  const result = useMemo(() => runRegex(pattern, flags, text), [pattern, flags, text]);
  const highlighted = useMemo(() => {
    if (result.error || !result.matches.length) return [text];
    const out: (string | React.ReactElement)[] = [];
    let last = 0;
    result.matches.forEach((m, i) => {
      out.push(text.slice(last, m.index));
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: match order
        <mark key={i} className="hl">
          {m.match || "∅"}
        </mark>,
      );
      last = m.index + m.match.length;
    });
    out.push(text.slice(last));
    return out;
  }, [result, text]);
  let replaced = "";
  if (replace && !result.error) {
    try {
      replaced = text.replace(new RegExp(pattern, flags), replace);
    } catch {
      replaced = "";
    }
  }
  return (
    <Section title="Regex tester">
      <div className="row">
        <span className="mono muted">/</span>
        <input
          className="grow mono"
          style={{ width: "auto" }}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          aria-label="Pattern"
        />
        <span className="mono muted">/</span>
        <input
          className="mono"
          style={{ width: 60 }}
          value={flags}
          onChange={(e) => setFlags(e.target.value.replace(/[^dgimsuvy]/g, ""))}
          aria-label="Flags"
        />
      </div>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      {result.error ? (
        <Notice kind="bad">{result.error}</Notice>
      ) : (
        <div className="small">
          {result.matches.length} match{result.matches.length === 1 ? "" : "es"}
        </div>
      )}
      <pre className="code">{highlighted}</pre>
      {result.matches.length ? (
        <KV
          rows={result.matches
            .slice(0, 50)
            .map((m, i) => [
              `#${i + 1} @${m.index}`,
              [
                m.match,
                ...m.groups.map((g, j) => `$${j + 1}: ${g ?? "undefined"}`),
                ...Object.entries(m.named).map(([k, v]) => `${k}: ${v}`),
              ].join("\n"),
            ])}
        />
      ) : null}
      <input className="mono" placeholder="Replacement ($1, $<name>)" value={replace} onChange={(e) => setReplace(e.target.value)} />
      {replace ? <Code text={replaced} /> : null}
    </Section>
  );
}

export function Diff() {
  const [a, setA] = useStored("util.diff.a", "");
  const [b, setB] = useStored("util.diff.b", "");
  const result = useMemo(() => {
    try {
      return { lines: diffLines(a, b) };
    } catch (e) {
      return { error: e };
    }
  }, [a, b]);
  const adds = result.lines?.filter((l) => l.kind === "add").length ?? 0;
  const dels = result.lines?.filter((l) => l.kind === "del").length ?? 0;
  return (
    <Section title="Text diff">
      <div className="row" style={{ alignItems: "stretch" }}>
        <textarea
          className="grow"
          style={{ width: "auto" }}
          rows={7}
          value={a}
          placeholder="Original"
          onChange={(e) => setA(e.target.value)}
        />
        <textarea
          className="grow"
          style={{ width: "auto" }}
          rows={7}
          value={b}
          placeholder="Changed"
          onChange={(e) => setB(e.target.value)}
        />
      </div>
      <ErrorText error={result.error} />
      {a || b ? (
        <>
          <div className="small">
            <span className="t-good">+{adds}</span> <span className="t-bad">−{dels}</span>
          </div>
          <div className="diff card" style={{ padding: 0, maxHeight: 420, overflow: "auto" }}>
            {result.lines?.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: line order
              <div key={i} className={l.kind}>
                {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
                {l.text}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Section>
  );
}

export function Color() {
  const [input, setInput] = useStored("util.color", "#0e7490");
  const [against, setAgainst] = useState("#ffffff");
  const c = parseColor(input);
  const bg = parseColor(against);
  return (
    <Section title="Color converter">
      <div className="row">
        <span className="swatch" style={{ background: c ? toRgb(c) : "transparent", width: 32, height: 32 }} />
        <input className="grow mono" style={{ width: "auto" }} value={input} onChange={(e) => setInput(e.target.value)} />
        <input type="color" value={c ? toHex({ ...c, a: 1 }) : "#000000"} onChange={(e) => setInput(e.target.value)} aria-label="Pick" />
      </div>
      {c ? (
        <>
          <KV
            rows={[
              [
                "HEX",
                <span key="h" className="row">
                  <span className="grow">{toHex(c)}</span>
                  <CopyButton text={toHex(c)} />
                </span>,
              ],
              [
                "RGB",
                <span key="r" className="row">
                  <span className="grow">{toRgb(c)}</span>
                  <CopyButton text={toRgb(c)} />
                </span>,
              ],
              [
                "HSL",
                <span key="s" className="row">
                  <span className="grow">{toHsl(c)}</span>
                  <CopyButton text={toHsl(c)} />
                </span>,
              ],
            ]}
          />
          <div className="row">
            <span className="small">Contrast against</span>
            <input className="mono" style={{ width: 110 }} value={against} onChange={(e) => setAgainst(e.target.value)} />
            {bg ? <b>{contrast(c, bg)}:1</b> : null}
          </div>
        </>
      ) : (
        <Empty>Enter a color: #hex, rgb(), hsl().</Empty>
      )}
    </Section>
  );
}

export function Cron() {
  const [expr, setExpr] = useStored("util.cron", "*/15 9-18 * * 1-5");
  const result = useMemo(() => {
    try {
      return { value: explainCron(expr) };
    } catch (e) {
      return { error: e };
    }
  }, [expr]);
  return (
    <Section
      title="Cron explainer"
      hint="Five fields: minute hour day-of-month month day-of-week. Aliases like @daily work too. Times are local."
    >
      <input className="mono" value={expr} onChange={(e) => setExpr(e.target.value)} />
      <ErrorText error={result.error} />
      {result.value ? (
        <>
          <Notice kind="good">{result.value.text}</Notice>
          <h3>Next runs</h3>
          <ul className="list mono small">
            {result.value.next.map((d) => (
              <li key={d.getTime()}>{d.toLocaleString(undefined, { weekday: "short", dateStyle: "medium", timeStyle: "short" })}</li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

export function UrlTool() {
  const page = usePage();
  const [url, setUrl] = useState(page.url);
  useEffect(() => setUrl(page.url), [page.url]);
  let parsed: URL | null = null;
  try {
    parsed = url ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  const params = parsed ? Array.from(parsed.searchParams.entries()) : [];
  const setParams = (next: [string, string][]) => {
    if (!parsed) return;
    const u = new URL(parsed.href);
    u.search = new URLSearchParams(next).toString();
    setUrl(u.href);
  };
  const tracking = params.filter(([k]) => /^(utm_|fbclid|gclid|dclid|msclkid|mc_|_hs|igshid|yclid|ref$|ref_src)/i.test(k));
  return (
    <Section
      title="URL & query params"
      actions={
        <>
          <Button
            size="small"
            disabled={!parsed || page.tabId === undefined}
            onClick={() => page.tabId !== undefined && browser.tabs.update(page.tabId, { url })}
          >
            Open in tab
          </Button>
          <CopyButton text={url} />
        </>
      }
    >
      <textarea rows={3} value={url} onChange={(e) => setUrl(e.target.value)} />
      {parsed ? (
        <>
          <KV
            rows={[
              ["Origin", parsed.origin],
              ["Path", decodeURIComponent(parsed.pathname)],
              ["Hash", parsed.hash || "–"],
            ]}
          />
          <div className="row">
            <h3 className="grow">Parameters ({params.length})</h3>
            {tracking.length ? (
              <Button size="small" onClick={() => setParams(params.filter((p) => !tracking.includes(p)))}>
                Strip {tracking.length} tracking
              </Button>
            ) : null}
            <Button size="small" onClick={() => setParams([...params, ["", ""]])}>
              + Param
            </Button>
          </div>
          {params.map(([k, v], i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: params edited in place
            <div key={i} className="row">
              <input
                className="mono"
                style={{ width: "35%" }}
                value={k}
                onChange={(e) => setParams(params.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))}
              />
              <input
                className="mono grow"
                style={{ width: "auto" }}
                value={v}
                onChange={(e) => setParams(params.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}
              />
              <Button size="small" variant="ghost" onClick={() => setParams(params.filter((_, j) => j !== i))} aria-label="Remove">
                ✕
              </Button>
            </div>
          ))}
        </>
      ) : url ? (
        <span className="small t-bad">Not a valid URL.</span>
      ) : null}
    </Section>
  );
}

export function Qr() {
  const page = usePage();
  const [text, setText] = useState(page.url);
  const [svg, setSvg] = useState("");
  const [png, setPng] = useState("");
  useEffect(() => setText(page.url), [page.url]);
  useEffect(() => {
    if (!text) return setSvg("");
    QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg, () => setSvg(""));
    QRCode.toDataURL(text, { margin: 2, width: 512 }).then(setPng, () => setPng(""));
  }, [text]);
  return (
    <Section title="QR code" hint="Scan to open the page on your phone. For localhost, use your machine's LAN address instead.">
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      {svg ? (
        <>
          <img
            src={png}
            alt={`QR code for ${text}`}
            style={{ background: "#fff", padding: 8, borderRadius: 8, width: 220, alignSelf: "center" }}
          />
          <div className="row" style={{ justifyContent: "center" }}>
            <Button size="small" onClick={() => download("qr.svg", svg, "image/svg+xml")}>
              SVG
            </Button>
            <a className="btn small" href={png} download="qr.png">
              PNG
            </a>
          </div>
        </>
      ) : null}
    </Section>
  );
}
