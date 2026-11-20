import { afterEach, describe, expect, it } from "vitest";
import { redirectsMarkdown } from "../src/lib/agent/redirects";
import { pageMetaRefresh } from "../src/lib/page/redirects";
import {
  type Chain,
  canonicalChange,
  chainText,
  findMetaRefresh,
  type Hop,
  headersRecord,
  isInternalRedirect,
  joinClient,
  loopAt,
  parseRefresh,
  pickChain,
  recordComplete,
  recordError,
  recordHeaders,
  recordRedirect,
  redirectCount,
  redirectFindings,
  startRecording,
} from "../src/lib/redirects";

const hop = (url: string, status: number, more: Partial<Hop> = {}): Hop => ({ url, status, headers: {}, ...more });
const chain = (hops: Hop[], more: Partial<Chain> = {}): Chain => ({ id: "1", source: "tab", startedAt: 0, hops, ...more });
const ids = (c: Chain) => redirectFindings(c).map((f) => `${f.id}:${f.level}`);

describe("headersRecord", () => {
  it("lower-cases names and joins repeats", () => {
    expect(
      headersRecord([
        { name: "Location", value: "/a" },
        { name: "Vary", value: "Accept" },
        { name: "vary", value: "Cookie" },
        { name: "Set-Cookie", value: "a=1" },
        { name: "set-cookie", value: "b=2" },
        { name: "X-Empty" },
      ]),
    ).toEqual({ location: "/a", vary: "Accept, Cookie", "set-cookie": "a=1\nb=2", "x-empty": "" });
    expect(headersRecord(undefined)).toEqual({});
  });
});

describe("parseRefresh", () => {
  const base = "https://ex.com/dir/page";
  it("reads the delay and the target in its usual spellings", () => {
    expect(parseRefresh("0; url=https://ex.com/next", base)).toEqual({ delay: 0, url: "https://ex.com/next" });
    expect(parseRefresh("5;URL='/a b'", base)).toEqual({ delay: 5, url: "https://ex.com/a%20b" });
    expect(parseRefresh('3, url="next"', base)).toEqual({ delay: 3, url: "https://ex.com/dir/next" });
    expect(parseRefresh("2.5;  /other", base)).toEqual({ delay: 2, url: "https://ex.com/other" });
  });
  it("refreshes the page itself without a URL, and rejects junk", () => {
    expect(parseRefresh("30", base)).toEqual({ delay: 30, url: base });
    expect(parseRefresh("soon; url=/x", base)).toBeNull();
    expect(parseRefresh("", base)).toBeNull();
  });
});

describe("findMetaRefresh", () => {
  it("finds the tag whatever the attribute order and quoting", () => {
    expect(findMetaRefresh('<head><meta charset=utf-8><meta content="0;url=/a" http-equiv="Refresh"></head>')).toBe("0;url=/a");
    expect(findMetaRefresh("<META HTTP-EQUIV=refresh CONTENT='1; url=/b'>")).toBe("1; url=/b");
  });
  it("skips comments, noscript fallbacks and other http-equiv tags", () => {
    expect(findMetaRefresh('<!-- <meta http-equiv="refresh" content="0;url=/a"> -->')).toBeNull();
    expect(findMetaRefresh('<noscript><meta http-equiv="refresh" content="0;url=/nojs"></noscript>')).toBeNull();
    expect(findMetaRefresh('<meta http-equiv="content-type" content="text/html">')).toBeNull();
  });
});

describe("recording a chain from webRequest events", () => {
  it("builds one hop per response, with Location, timing and headers", () => {
    const rec = startRecording("7", 1000, "tab");
    recordHeaders(rec, { url: "http://ex.com/a", statusCode: 301, timeStamp: 1010 });
    recordRedirect(rec, {
      url: "http://ex.com/a",
      statusCode: 301,
      statusLine: "HTTP/1.1 301 Moved Permanently",
      redirectUrl: "https://ex.com/a",
      responseHeaders: [{ name: "Location", value: "https://ex.com/a" }],
      timeStamp: 1012,
      ip: "1.2.3.4",
    });
    recordRedirect(rec, {
      url: "https://ex.com/a",
      statusCode: 307,
      statusLine: "HTTP/1.1 307 Internal Redirect",
      redirectUrl: "https://ex.com/b",
      responseHeaders: [{ name: "Non-Authoritative-Reason", value: "HSTS" }],
      timeStamp: 1013,
    });
    const c = recordComplete(rec, {
      url: "https://ex.com/b",
      statusCode: 200,
      statusLine: "HTTP/1.1 200 OK",
      responseHeaders: [{ name: "Content-Type", value: "text/html" }],
      timeStamp: 1050,
      fromCache: true,
    });
    expect(c.hops.map((h) => [h.status, h.redirect, h.location, h.ms])).toEqual([
      [301, "http", "https://ex.com/a", 12],
      [307, "internal", "https://ex.com/b", 1],
      [200, undefined, undefined, 37],
    ]);
    expect(c.hops[0]).toMatchObject({ ip: "1.2.3.4", headers: { location: "https://ex.com/a" } });
    expect(c.hops[2]).toMatchObject({ fromCache: true, headers: { "content-type": "text/html" } });
    expect(redirectCount(c)).toBe(2);
  });
  it("stops after 20 redirects", () => {
    const rec = startRecording("1", 0, "trace");
    for (let i = 0; i < 25; i++)
      recordRedirect(rec, { url: `https://ex.com/${i}`, statusCode: 302, redirectUrl: `https://ex.com/${i + 1}`, timeStamp: i });
    const c = recordError(rec, { url: "https://ex.com/25", error: "net::ERR_TOO_MANY_REDIRECTS", timeStamp: 30 });
    expect(c.hops).toHaveLength(21);
    expect(c.stopped).toBe("max-hops");
    expect(c.hops.at(-1)?.error).toBe("net::ERR_TOO_MANY_REDIRECTS");
  });
  it("keeps the response seen before an aborted body, and reports real failures", () => {
    const rec = startRecording("1", 0, "trace");
    recordHeaders(rec, { url: "https://ex.com/", statusCode: 404, responseHeaders: [{ name: "Server", value: "x" }], timeStamp: 5 });
    const c = recordError(rec, { url: "https://ex.com/", error: "net::ERR_ABORTED", timeStamp: 6 });
    expect(c.hops[0]).toMatchObject({ status: 404, headers: { server: "x" } });
    expect(c.hops[0]?.error).toBeUndefined();
    const failed = recordError(startRecording("2", 0, "tab"), {
      url: "https://nope.test/",
      error: "net::ERR_NAME_NOT_RESOLVED",
      timeStamp: 1,
    });
    expect(failed.hops[0]).toMatchObject({ status: 0, error: "net::ERR_NAME_NOT_RESOLVED" });
  });
  it("tells the browser's own redirects apart", () => {
    expect(isInternalRedirect("HTTP/1.1 307 Internal Redirect", {})).toBe(true);
    expect(isInternalRedirect("HTTP/1.1 307 Temporary Redirect", { "non-authoritative-reason": "HSTS" })).toBe(true);
    expect(isInternalRedirect("HTTP/1.1 307 Temporary Redirect", {})).toBe(false);
  });
});

describe("joining client redirects", () => {
  it("adds the next navigation after the previous document, marked with how it moved", () => {
    const prev = chain(
      [hop("https://ex.com/r1", 301, { redirect: "http", location: "https://ex.com/meta" }), hop("https://ex.com/meta", 200)],
      {
        startedAt: 5,
      },
    );
    const next = chain([hop("https://ex.com/final", 200)], { id: "2", startedAt: 9 });
    const joined = joinClient(prev, next, "meta");
    expect(joined.hops.map((h) => [h.url, h.redirect, h.location])).toEqual([
      ["https://ex.com/r1", "http", "https://ex.com/meta"],
      ["https://ex.com/meta", "meta", "https://ex.com/final"],
      ["https://ex.com/final", undefined, undefined],
    ]);
    expect(joined).toMatchObject({ id: "2", startedAt: 5 });
    expect(prev.hops[1]?.redirect).toBeUndefined();
  });
  it("keeps endless client redirects bounded", () => {
    let c = chain([hop("https://ex.com/0", 200)]);
    for (let i = 1; i < 30; i++) c = joinClient(c, chain([hop(`https://ex.com/${i}`, 200)]), "js");
    expect(c.hops).toHaveLength(21);
    expect(c.dropped).toBe(9);
    expect(c.hops[0]?.url).toBe("https://ex.com/9");
  });
  it("picks the chain that ended on the tab's URL", () => {
    const a = chain([hop("https://ex.com/a", 200)], { id: "a" });
    const b = chain([hop("https://ex.com/x", 301, { redirect: "http" }), hop("https://ex.com/b", 200)], { id: "b" });
    expect(pickChain([a, b], "https://ex.com/b#top")?.id).toBe("b");
    expect(pickChain([a, b], "https://ex.com/c")).toBeUndefined();
    expect(pickChain(undefined, "https://ex.com/a")).toBeUndefined();
  });
});

describe("canonicalChange (heuristic)", () => {
  it("names scheme, www, trailing slash and case changes", () => {
    expect(canonicalChange("http://ex.com/a", "https://ex.com/a")).toBe("moves to HTTPS");
    expect(canonicalChange("https://ex.com/a", "https://www.ex.com/a")).toBe("adds www");
    expect(canonicalChange("https://www.ex.com/a/", "https://ex.com/a")).toBe("removes www, removes the trailing slash");
    expect(canonicalChange("https://ex.com/a", "/a/")).toBe("adds a trailing slash");
    expect(canonicalChange("https://ex.com/About", "https://ex.com/about")).toBe("changes the letter case");
  });
  it("leaves real moves alone", () => {
    expect(canonicalChange("https://ex.com/a", "https://ex.com/b")).toBeNull();
    expect(canonicalChange("https://ex.com/a", "https://other.com/a")).toBeNull();
    expect(canonicalChange("https://ex.com/login", "https://ex.com/login?next=1")).toBeNull();
    expect(canonicalChange("https://ex.com/a", "https://ex.com/a")).toBeNull();
  });
});

describe("redirectFindings", () => {
  it("says when there is no redirect", () => {
    expect(ids(chain([hop("https://ex.com/", 200)]))).toEqual(["none:good"]);
  });
  it("flags loops and the 20-redirect stop", () => {
    const hops = [
      hop("https://ex.com/a", 302, { redirect: "http", location: "https://ex.com/b" }),
      hop("https://ex.com/b", 302, { redirect: "http", location: "https://ex.com/a" }),
      hop("https://ex.com/a", 0, { error: "net::ERR_TOO_MANY_REDIRECTS" }),
    ];
    const c = chain(hops, { stopped: "max-hops" });
    expect(loopAt(c)).toBe(2);
    expect(ids(c)).toEqual(["loop:bad", "max-hops:bad", "hops:info", "error:bad"]);
    expect(redirectFindings(c)[0]?.detail).toContain("https://ex.com/a comes back after 2 hops");
  });
  it("warns on long chains, downgrades and temporary canonical moves", () => {
    const c = chain([
      hop("http://ex.com/a", 302, { redirect: "http", location: "https://ex.com/a" }),
      hop("https://ex.com/a", 301, { redirect: "http", location: "https://www.ex.com/a" }),
      hop("https://www.ex.com/a", 307, { redirect: "http", location: "http://www.ex.com/a/" }),
      hop("http://www.ex.com/a/", 200),
    ]);
    expect(ids(c)).toEqual(["hops:warn", "upgrade-0:info", "temporary-0:warn", "downgrade-2:bad", "temporary-2:warn"]);
    expect(redirectFindings(c).find((f) => f.id === "temporary-0")?.detail).toContain("answers 302 but only moves to HTTPS");
  });
  it("credits an HSTS upgrade and does not call it temporary", () => {
    const c = chain([hop("http://ex.com/", 307, { redirect: "internal", location: "https://ex.com/" }), hop("https://ex.com/", 200)]);
    expect(ids(c)).toEqual(["hops:info", "upgrade-0:good"]);
  });
  it("warns on client-side hops, mixed with server ones", () => {
    const c = chain([
      hop("https://ex.com/a", 301, { redirect: "http", location: "https://ex.com/b" }),
      hop("https://ex.com/b", 200, { redirect: "meta", location: "https://ex.com/c" }),
      hop("https://ex.com/c", 200, { redirect: "js", location: "https://ex.com/d" }),
      hop("https://ex.com/d", 404),
    ]);
    const f = redirectFindings(c);
    expect(f.map((x) => `${x.id}:${x.level}`)).toEqual(["hops:warn", "client:warn", "status:bad"]);
    expect(f[1]).toMatchObject({ label: "Server and client redirects mixed" });
    expect(f[1]?.detail).toContain("2 hops by meta refresh, JavaScript redirect");
    expect(
      redirectFindings(chain([hop("https://ex.com/b", 200, { redirect: "meta", location: "/c" }), hop("https://ex.com/c", 200)]))[1]?.label,
    ).toBe("Client-side redirect");
  });
});

describe("text and agent reports", () => {
  const c = chain([
    hop("https://ex.com/r1", 301, {
      statusLine: "HTTP/1.1 301 Moved Permanently",
      redirect: "http",
      location: "https://ex.com/r2",
      ms: 12,
    }),
    hop("https://ex.com/r2", 200, { redirect: "meta", location: "https://ex.com/final", ms: 30 }),
    hop("https://ex.com/final", 404, { ms: 8 }),
  ]);
  it("copies the chain one hop per line", () => {
    expect(chainText(c)).toBe(
      [
        "1. 301 Moved Permanently https://ex.com/r1 · 12 ms",
        "   → https://ex.com/r2",
        "2. 200 (meta refresh) https://ex.com/r2 · 30 ms",
        "   → https://ex.com/final",
        "3. 404 https://ex.com/final · 8 ms",
      ].join("\n"),
    );
  });
  it("writes what to fix for a coding agent", () => {
    const md = redirectsMarkdown(c);
    expect(md).toMatch(
      /^## Redirect path\nPage: https:\/\/ex.com\/r1\nResult: 2 redirects, final HTTP 404 at https:\/\/ex.com\/final: 1 problem, 1 warning\./,
    );
    expect(md).toContain("### To fix\n\n1. Final response: HTTP 404 at https://ex.com/final.");
    expect(md).toContain("### Worth checking\n\n1. Server and client redirects mixed:");
    expect(md).toContain("### Hops\n\n```\n1. 301 Moved Permanently");
    expect(md).toContain("`curl -sIL https://ex.com/r1`");
    expect(redirectsMarkdown(chain([hop("https://ex.com/", 200)]))).toContain("Result: No problem found. 0 redirects, final HTTP 200");
  });
});

describe("pageMetaRefresh (page function)", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });
  it("reads the first refresh tag outside noscript", async () => {
    document.head.innerHTML = '<meta http-equiv="content-type" content="text/html"><meta http-equiv="REFRESH" content="5; url=/next">';
    expect(await pageMetaRefresh()).toEqual({ content: "5; url=/next" });
    document.head.innerHTML = "";
    document.body.innerHTML = '<noscript><meta http-equiv="refresh" content="0;url=/nojs"></noscript>';
    expect(await pageMetaRefresh(true)).toBeNull();
  });
});
