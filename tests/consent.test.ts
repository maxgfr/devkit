import { afterEach, describe, expect, it } from "vitest";
import { consentJson, consentMarkdown } from "../src/lib/agent/consent";
import {
  analyzeCapture,
  buildCapture,
  type CaptureInput,
  CMP_GLOBALS,
  type ConsentCapture,
  type CookieInput,
  classifyName,
  classifyRequest,
  compareCaptures,
  consentModeState,
  cookieBaseline,
  cookieFingerprint,
  detectCmps,
  isDeniedPing,
  parseGcs,
  sanitizeRequest,
  stripUrl,
  thirdPartySites,
} from "../src/lib/consent";
import type { ConsentStep } from "../src/lib/datalayer";
import { collectConsentPage, type ConsentPageSnapshot, probeConsentGlobals } from "../src/lib/page/consent";
import { PANELS } from "../src/lib/panels";

const step = (command: string, states: Record<string, string>, extra: Partial<ConsentStep> = {}): ConsentStep => ({
  seq: 0,
  layer: "dataLayer",
  index: 0,
  command,
  states,
  ...extra,
});

const GRANTED = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };
const DENIED = { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" };

const cookie = (name: string, domain = "shop.example.com", extra: Partial<CookieInput> = {}): CookieInput => ({
  name,
  value: `secret-value-of-${name}`,
  domain,
  path: "/",
  httpOnly: false,
  session: false,
  expirationDate: 2_000_000_000,
  ...extra,
});

const snapshot = (extra: Partial<ConsentPageSnapshot> = {}): ConsentPageSnapshot => ({
  url: "https://shop.example.com/product?utm_source=x",
  title: "Shop",
  documentCookies: [],
  localKeys: [],
  sessionKeys: [],
  resources: [],
  resourceBufferFull: false,
  scripts: [],
  iframes: [],
  ...extra,
});

const capture = (extra: Partial<CaptureInput> = {}, page: Partial<ConsentPageSnapshot> = {}): ConsentCapture =>
  buildCapture({
    phase: "before",
    at: 1_700_000_000_000,
    page: snapshot(page),
    globals: { globals: [], tcf: { present: false, ping: null, hasTcString: null, eventStatus: null } },
    consent: [],
    googleTags: false,
    cookies: [],
    baseline: null,
    thirdPartyCookies: true,
    ...extra,
  });

describe("classifyName", () => {
  it("knows the common analytics and advertising cookies", () => {
    expect(classifyName("_ga")).toMatchObject({ category: "analytics", vendor: "Google Analytics" });
    expect(classifyName("_ga_ABC123")).toMatchObject({ category: "analytics" });
    expect(classifyName("_gid").category).toBe("analytics");
    expect(classifyName("_gcl_au")).toMatchObject({ category: "advertising", vendor: "Google Ads" });
    expect(classifyName("_fbp")).toMatchObject({ category: "advertising", vendor: "Meta Pixel" });
    expect(classifyName("_uetsid").category).toBe("advertising");
    expect(classifyName("_hjSessionUser_123")).toMatchObject({ category: "analytics", vendor: "Hotjar" });
    expect(classifyName("_clck")).toMatchObject({ vendor: "Microsoft Clarity" });
    expect(classifyName("ajs_anonymous_id")).toMatchObject({ vendor: "Segment" });
    expect(classifyName("mp_abc_mixpanel")).toMatchObject({ vendor: "Mixpanel" });
    expect(classifyName("cto_bundle")).toMatchObject({ vendor: "Criteo", category: "advertising" });
  });

  it("needs the vendor's domain for short, ambiguous names", () => {
    expect(classifyName("fr").category).toBe("unknown");
    expect(classifyName("fr", "shop.example.com").category).toBe("unknown");
    expect(classifyName("fr", ".facebook.com")).toMatchObject({ category: "advertising", vendor: "Meta (Facebook)" });
    expect(classifyName("IDE", ".doubleclick.net")).toMatchObject({ category: "advertising" });
    expect(classifyName("IDE", "example.com").category).toBe("unknown");
    expect(classifyName("test_cookie", ".doubleclick.net").category).toBe("advertising");
    expect(classifyName("NID", ".google.com").category).toBe("advertising");
    expect(classifyName("NID", ".google.fr").category).toBe("advertising");
    expect(classifyName("NID").category).toBe("unknown");
  });

  it("falls back to the cookie's domain, without the tag-loader pass", () => {
    const c = classifyName("whatever", ".doubleclick.net");
    expect(c).toMatchObject({ category: "advertising", vendor: "Google Ads (DoubleClick)" });
    expect(classifyName("x", "www.googletagmanager.com").loader).toBeUndefined();
  });

  it("marks the consent banners' own records and necessary cookies as functional", () => {
    expect(classifyName("OptanonConsent")).toMatchObject({ category: "functional", vendor: "OneTrust", cmp: true });
    expect(classifyName("euconsent-v2")).toMatchObject({ category: "functional", cmp: true });
    expect(classifyName("didomi_token").vendor).toBe("Didomi");
    expect(classifyName("PHPSESSID").category).toBe("functional");
    expect(classifyName("__cf_bm").category).toBe("functional");
    expect(classifyName("my_app_pref")).toEqual({ category: "unknown", vendor: "" });
  });
});

describe("requests", () => {
  it("keeps host, path and a few parameters, never identifiers", () => {
    const r = sanitizeRequest("https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=123.456&gcs=G100&en=page_view", "fetch");
    expect(r).toEqual({
      host: "region1.google-analytics.com",
      path: "/g/collect",
      type: "fetch",
      params: { v: "2", tid: "G-ABC", gcs: "G100", en: "page_view" },
    });
    expect(JSON.stringify(r)).not.toContain("123.456");
    expect(sanitizeRequest("data:image/png;base64,xx", "img")).toBeNull();
    expect(sanitizeRequest("not a url", "img")).toBeNull();
    expect(stripUrl("https://a.example/p/q?id=secret#x")).toBe("https://a.example/p/q");
  });

  const cls = (url: string) => classifyRequest(sanitizeRequest(url, "script")!);

  it("classifies by host and path", () => {
    expect(cls("https://www.google-analytics.com/g/collect?v=2")).toMatchObject({ category: "analytics", vendor: "Google Analytics" });
    expect(cls("https://www.googletagmanager.com/gtm.js?id=GTM-X")).toMatchObject({ category: "analytics", loader: true });
    expect(cls("https://connect.facebook.net/en_US/fbevents.js")).toMatchObject({ category: "advertising", vendor: "Meta Pixel" });
    expect(cls("https://www.facebook.com/tr?id=1&ev=PageView")).toMatchObject({ vendor: "Meta Pixel" });
    expect(cls("https://www.facebook.com/somepage").category).toBe("unknown");
    expect(cls("https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1")).toMatchObject({ category: "advertising" });
    expect(cls("https://www.google.com/pagead/1p-user-list/1")).toMatchObject({ vendor: "Google Ads" });
    expect(cls("https://www.google.com/search?q=x").category).toBe("unknown");
    expect(cls("https://bat.bing.com/bat.js")).toMatchObject({ category: "advertising" });
    expect(cls("https://static.hotjar.com/c/hotjar-1.js")).toMatchObject({ vendor: "Hotjar" });
    expect(cls("https://www.clarity.ms/tag/abc")).toMatchObject({ vendor: "Microsoft Clarity" });
    expect(cls("https://snap.licdn.com/li.lms-analytics/insight.min.js")).toMatchObject({ vendor: "LinkedIn Insight" });
    expect(cls("https://analytics.tiktok.com/i18n/pixel/events.js")).toMatchObject({ vendor: "TikTok Pixel" });
    expect(cls("https://cdn.cookielaw.org/scripttemplates/otSDKStub.js")).toMatchObject({ category: "functional", cmp: true });
    expect(cls("https://cdn.example.net/app.js")).toEqual({ category: "unknown", vendor: "" });
  });

  it("recognizes GA4 hits and Meta Pixel events by their shape on any host", () => {
    expect(cls("https://metrics.shop.example.com/g/collect?v=2&tid=G-XYZ")).toMatchObject({
      category: "analytics",
      vendor: "Google Analytics",
      byShape: true,
    });
    expect(cls("http://localhost:3000/collect?tid=G-XYZ")).toMatchObject({ byShape: true });
    expect(cls("http://localhost:3000/collect").category).toBe("unknown");
    expect(cls("https://t.example.com/tr?id=1&ev=PageView")).toMatchObject({ vendor: "Meta Pixel", byShape: true });
  });

  it("reads Google's gcs consent flag", () => {
    expect(parseGcs("G100")).toEqual({ ad: "denied", analytics: "denied" });
    expect(parseGcs("G111")).toEqual({ ad: "granted", analytics: "granted" });
    expect(parseGcs("G1--")).toEqual({ ad: "unset", analytics: "unset" });
    expect(parseGcs("G110")).toEqual({ ad: "granted", analytics: "denied" });
    expect(parseGcs(undefined)).toBeNull();
    expect(parseGcs("x")).toBeNull();
    expect(isDeniedPing({ params: { gcs: "G110" } }, "analytics")).toBe(true);
    expect(isDeniedPing({ params: { gcs: "G110" } }, "advertising")).toBe(false);
    expect(isDeniedPing({ params: {} }, "analytics")).toBe(false);
  });
});

describe("detectCmps", () => {
  it("recognizes banners by globals, scripts and cookies", () => {
    expect(detectCmps({ globals: ["Didomi"], scripts: [], names: [] })).toEqual([
      { id: "didomi", name: "Didomi", evidence: ["global Didomi"] },
    ]);
    expect(detectCmps({ globals: [], scripts: ["https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"], names: [] })[0]).toMatchObject({
      id: "onetrust",
      evidence: ["script cdn.cookielaw.org/scripttemplates/otSDKStub.js"],
    });
    expect(detectCmps({ globals: [], scripts: [], names: ["CookieConsent"] })[0]!.id).toBe("cookiebot");
    expect(
      detectCmps({ globals: ["axeptioSettings"], scripts: ["https://static.axept.io/sdk.js"], names: ["axeptio_cookies"] })[0],
    ).toMatchObject({
      id: "axeptio",
      evidence: ["global axeptioSettings", "script static.axept.io/sdk.js", "cookie or key axeptio_cookies"],
    });
    expect(detectCmps({ globals: ["googlefc"], scripts: [], names: [] })[0]!.name).toBe("Google Funding Choices");
    expect(detectCmps({ globals: [], scripts: [], names: [] })).toEqual([]);
  });

  it("falls back to the TCF API when no named banner matches", () => {
    const tcf = {
      present: true,
      ping: { cmpLoaded: true, gdprApplies: true, cmpStatus: "loaded", displayStatus: "visible", cmpId: 7 },
      hasTcString: false,
      eventStatus: null,
    };
    expect(detectCmps({ globals: ["__tcfapi"], scripts: [], names: [], tcf })).toEqual([
      { id: "tcf", name: "IAB TCF CMP (CMP id 7)", evidence: ["global __tcfapi"] },
    ]);
    expect(detectCmps({ globals: ["__tcfapi", "Didomi"], scripts: [], names: [], tcf }).map((h) => h.id)).toEqual(["didomi"]);
  });

  it("asks the page for every global the rules use", () => {
    expect(CMP_GLOBALS).toEqual(expect.arrayContaining(["__tcfapi", "Didomi", "OneTrust", "Cookiebot", "UC_UI", "_iub", "googlefc"]));
    expect(new Set(CMP_GLOBALS).size).toBe(CMP_GLOBALS.length);
  });
});

describe("consentModeState", () => {
  it("folds defaults and updates per signal", () => {
    const s = consentModeState([step("default", DENIED), step("update", { ad_storage: "granted", analytics_storage: "granted" })]);
    expect(s).toMatchObject({ present: true, hasDefault: true, hasUpdate: true, regional: [] });
    expect(s.signals.find((x) => x.signal === "ad_storage")).toEqual({
      signal: "ad_storage",
      default: "denied",
      update: "granted",
      effective: "granted",
    });
    expect(s.signals.find((x) => x.signal === "ad_user_data")).toEqual({ signal: "ad_user_data", default: "denied", effective: "denied" });
    expect(s.signals.find((x) => x.signal === "security_storage")).toEqual({ signal: "security_storage", effective: "unset" });
  });

  it("notes region-limited defaults", () => {
    expect(consentModeState([step("default", DENIED, { region: ["FR", "DE"] })]).regional).toEqual(["FR", "DE"]);
    expect(consentModeState([]).present).toBe(false);
  });
});

describe("buildCapture", () => {
  it("keeps names only and strips URLs", () => {
    const c = capture(
      { cookies: [cookie("_ga")] },
      {
        resources: [{ url: "https://www.google-analytics.com/g/collect?v=2&cid=999.111&gcs=G111", type: "beacon" }],
        scripts: ["https://x.example/a.js?k=v"],
      },
    );
    expect(c.url).toBe("https://shop.example.com/product");
    expect(c.cookies).toEqual([
      { name: "_ga", domain: "shop.example.com", path: "/", partitioned: false, httpOnly: false, session: false },
    ]);
    expect(c.scripts).toEqual(["https://x.example/a.js"]);
    const json = JSON.stringify(c);
    expect(json).not.toContain("secret-value");
    expect(json).not.toContain("999.111");
    expect(c.cookieSource).toBe("cookies-api");
  });

  it("falls back to document.cookie names without the cookies permission", () => {
    const c = capture({ cookies: null }, { documentCookies: ["_ga", "theme"] });
    expect(c.cookieSource).toBe("document");
    expect(c.cookies.map((k) => k.name)).toEqual(["_ga", "theme"]);
  });

  it("drops partitioned cookies of other top-level sites", () => {
    const c = capture({
      cookies: [
        cookie("embed", "widget.example.net", { partitionKey: { topLevelSite: "https://example.com" } }),
        cookie("other", "widget.example.net", { partitionKey: { topLevelSite: "https://elsewhere.org" } }),
      ],
    });
    expect(c.cookies.map((k) => [k.name, k.partitioned])).toEqual([["embed", true]]);
  });

  it("tells cookies already in the browser from cookies this load set", () => {
    const old = cookie("IDE", ".doubleclick.net");
    const refreshed = cookie("test_cookie", ".doubleclick.net");
    const baseline = cookieBaseline([old, refreshed]);
    const c = capture({ baseline, cookies: [old, { ...refreshed, expirationDate: 2_100_000_000 }, cookie("_ga")] });
    expect(c.cookies.map((k) => [k.name, k.preexisting])).toEqual([
      ["IDE", true],
      ["test_cookie", false],
      ["_ga", false],
    ]);
    expect(cookieFingerprint(old)).toBe(cookieFingerprint({ ...old }));
    expect(cookieFingerprint(old)).not.toBe(cookieFingerprint({ ...old, value: "other" }));
  });

  it("lists the third-party sites of resources and frames", () => {
    expect(
      thirdPartySites({
        url: "https://shop.example.com/",
        resources: [
          { url: "https://cdn.example.com/a.js", type: "script" },
          { url: "https://www.google-analytics.com/g/collect", type: "beacon" },
          { url: "data:x", type: "img" },
        ],
        iframes: ["https://www.youtube.com/embed/x"],
      }),
    ).toEqual(["google-analytics.com", "youtube.com"]);
  });
});

/** The e2e fixture: `_ga` set by the page, a GA hit through another origin, Consent Mode default granted, no banner. */
function fixture(phase: "before" | "current" = "before") {
  return capture(
    {
      phase,
      cookies: [cookie("_ga"), cookie("session_id")],
      consent: [step("default", GRANTED)],
      googleTags: true,
    },
    {
      resources: [
        { url: "https://tracker.example.net/consent/tracker.js", type: "script" },
        { url: "https://tracker.example.net/g/collect?v=2&tid=G-E2E&gcs=G111", type: "img" },
      ],
    },
  );
}

const ids = (findings: { id: string; level: string }[]) => findings.map((f) => `${f.id}:${f.level}`);

describe("analyzeCapture findings", () => {
  it("flags tracking before consent and a granted default", () => {
    const a = analyzeCapture(fixture());
    expect(ids(a.findings)).toEqual(
      expect.arrayContaining([
        "analytics-cookies:bad",
        "analytics-requests:warn",
        "consent-default-granted:bad",
        "no-cmp:warn",
        "unknown-third-parties:info",
      ]),
    );
    expect(a.findings.find((f) => f.id === "analytics-cookies")!.items).toEqual(["_ga (Google Analytics)"]);
    expect(a.findings.find((f) => f.id === "consent-default-granted")!.label).toBe(
      "Consent Mode default grants ad_storage, analytics_storage, ad_user_data, ad_personalization",
    );
    expect(a.counts).toMatchObject({ analytics: 2, advertising: 0, thirdPartyHosts: 1, unknownThirdParties: 1 });
    expect(a.findings.some((f) => f.id === "clean")).toBe(false);
  });

  it("words the current state as warnings, not proof", () => {
    const a = analyzeCapture(fixture("current"));
    expect(ids(a.findings)).toEqual(expect.arrayContaining(["analytics-cookies:warn", "consent-default-granted:warn"]));
    expect(a.findings.find((f) => f.id === "analytics-cookies")!.label).toBe("1 analytics cookie in the current state");
  });

  it("finds nothing on a clean page with a denied default and a banner", () => {
    const a = analyzeCapture(
      capture(
        {
          cookies: [cookie("PHPSESSID"), cookie("didomi_token")],
          consent: [step("default", DENIED)],
          googleTags: true,
          globals: { globals: ["Didomi"], tcf: { present: false, ping: null, hasTcString: null, eventStatus: null } },
        },
        { resources: [{ url: "https://www.googletagmanager.com/gtm.js?id=GTM-1", type: "script" }] },
      ),
    );
    expect(ids(a.findings)).toEqual(["consent-default-denied:good", "clean:good"]);
    expect(a.cmps.map((c) => c.id)).toEqual(["didomi"]);
  });

  it("treats Consent Mode denied pings as notes", () => {
    const a = analyzeCapture(
      capture(
        { consent: [step("default", DENIED)], googleTags: true },
        { resources: [{ url: "https://www.google-analytics.com/g/collect?v=2&gcs=G100", type: "fetch" }] },
      ),
    );
    expect(ids(a.findings)).toContain("denied-pings:info");
    expect(ids(a.findings)).not.toContain("analytics-requests:warn");
  });

  it("flags Google tags without Consent Mode, advertising and the TCF string", () => {
    const a = analyzeCapture(
      capture(
        {
          cookies: [cookie("_fbp"), cookie("IDE", ".doubleclick.net")],
          globals: { globals: ["__tcfapi"], tcf: { present: true, ping: null, hasTcString: false, eventStatus: "cmpuishown" } },
        },
        {
          resources: [
            { url: "https://www.googletagmanager.com/gtag/js?id=G-1", type: "script" },
            { url: "https://connect.facebook.net/en_US/fbevents.js", type: "script" },
          ],
        },
      ),
    );
    expect(ids(a.findings)).toEqual(
      expect.arrayContaining(["ads-cookies:bad", "ads-requests:bad", "consent-mode-missing:bad", "tcf-tracking-before-string:bad"]),
    );
    expect(ids(a.findings)).not.toContain("no-cmp:warn");
  });

  it("lists cookies from earlier browsing apart", () => {
    const old = cookie("IDE", ".doubleclick.net");
    const a = analyzeCapture(capture({ baseline: cookieBaseline([old]), cookies: [old] }));
    expect(ids(a.findings)).toEqual(expect.arrayContaining(["preexisting:info", "clean:good"]));
    expect(a.counts.advertising).toBe(0);
  });

  it("says what it could not see", () => {
    const a = analyzeCapture(capture({ cookies: null, thirdPartyCookies: false }, { resourceBufferFull: true }));
    expect(ids(a.findings)).toEqual(expect.arrayContaining(["cookies-partial:info", "resource-buffer:info"]));
    const b = analyzeCapture(capture({ thirdPartyCookies: false }));
    expect(ids(b.findings)).toContain("third-party-cookies-hidden:info");
  });

  it("flags a consent update that grants before any choice", () => {
    const a = analyzeCapture(capture({ consent: [step("default", DENIED), step("update", GRANTED)], googleTags: true }));
    expect(ids(a.findings)).toContain("consent-update-before:bad");
  });
});

describe("compareCaptures", () => {
  const before = analyzeCapture(capture({ cookies: [cookie("PHPSESSID")], consent: [step("default", DENIED)], googleTags: true }));
  const afterCapture = (choice: "accept" | "reject", extra: Partial<CaptureInput>, page: Partial<ConsentPageSnapshot> = {}) =>
    analyzeCapture(capture({ phase: "after", choice, googleTags: true, ...extra }, page));

  it("flags tracking after rejecting", () => {
    const a = afterCapture(
      "reject",
      { cookies: [cookie("PHPSESSID"), cookie("_fbp")], consent: [step("default", DENIED), step("update", GRANTED)] },
      {
        resources: [{ url: "https://connect.facebook.net/en_US/fbevents.js", type: "script" }],
      },
    );
    const c = compareCaptures(before, a, "reject");
    expect(ids(c.findings)).toEqual(["reject-tracking-storage:bad", "reject-tracking-requests:bad", "reject-granted:bad"]);
    expect(c.cookiesAdded.map((k) => k.name)).toEqual(["_fbp"]);
    expect(c.requestsAdded.map((g) => g.host)).toEqual(["connect.facebook.net"]);
    expect(c.signals).toEqual(expect.arrayContaining([{ signal: "ad_storage", before: "denied", after: "granted" }]));
  });

  it("passes a clean reject", () => {
    const c = compareCaptures(
      before,
      afterCapture("reject", { cookies: [cookie("PHPSESSID")], consent: [step("default", DENIED), step("update", DENIED)] }),
      "reject",
    );
    expect(ids(c.findings)).toEqual(["reject-clean:good"]);
    expect(c.cookiesAdded).toEqual([]);
  });

  it("notes what accepting adds and a missing update", () => {
    const granted = compareCaptures(
      before,
      afterCapture("accept", {
        cookies: [cookie("PHPSESSID"), cookie("_ga")],
        consent: [step("default", DENIED), step("update", GRANTED)],
      }),
      "accept",
    );
    expect(ids(granted.findings)).toEqual(["accept-added:info"]);
    expect(granted.findings[0]!.items).toEqual(["_ga (Google Analytics)"]);
    const stuck = compareCaptures(
      before,
      afterCapture("accept", { cookies: [cookie("PHPSESSID")], consent: [step("default", DENIED)] }),
      "accept",
    );
    expect(ids(stuck.findings)).toEqual(["accept-no-update:warn"]);
  });
});

describe("reports", () => {
  it("writes Markdown for an agent with names, fixes and no values", () => {
    const a = analyzeCapture(fixture());
    const after = analyzeCapture(
      capture({ phase: "after", choice: "reject", cookies: [cookie("_ga"), cookie("session_id"), cookie("_fbp")] }),
    );
    const md = consentMarkdown(a, [compareCaptures(a, after, "reject")]);
    expect(md).toContain("## Consent check (GDPR / ePrivacy)");
    expect(md).toContain("Page: https://shop.example.com/product");
    expect(md).toContain("### To fix");
    expect(md).toContain("`_ga (Google Analytics)`");
    expect(md).toContain("Fix: Set these signals to 'denied'");
    expect(md).toContain("### Comparison 1: after rejecting");
    expect(md).toContain("Heuristic");
    expect(md).not.toContain("secret-value");
  });

  it("exports JSON without values", () => {
    const a = analyzeCapture(fixture());
    const json = JSON.parse(consentJson([a], []));
    expect(json.tool).toBe("devkit consent check");
    expect(json.captures[0].cookies[0]).toMatchObject({ name: "_ga", category: "analytics", firstParty: true });
    expect(
      json.captures[0].requests.find(
        (r: { host: string; category: string }) => r.host === "tracker.example.net" && r.category === "analytics",
      ),
    ).toMatchObject({
      trackingHits: 1,
    });
    expect(JSON.stringify(json)).not.toContain("secret-value");
  });
});

describe("page functions", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // biome-ignore lint/suspicious/noDocumentCookie: the page function reads document.cookie
    document.cookie = "_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    delete (window as unknown as Record<string, unknown>).Didomi;
    delete (window as unknown as Record<string, unknown>).__tcfapi;
  });

  it("collects cookie names and storage keys, never values", () => {
    localStorage.setItem("_hjid", "value-1");
    sessionStorage.setItem("tab", "value-2");
    // biome-ignore lint/suspicious/noDocumentCookie: the page function reads document.cookie
    document.cookie = "_ga=GA1.1.42; path=/";
    const snap = collectConsentPage();
    expect(snap.localKeys).toEqual(["_hjid"]);
    expect(snap.sessionKeys).toEqual(["tab"]);
    expect(snap.documentCookies).toContain("_ga");
    expect(snap.iframes).toEqual([]);
    expect(snap.resourceBufferFull).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("value-1");
    expect(JSON.stringify(snap)).not.toContain("GA1.1.42");
  });

  it("probes CMP globals and the TCF API read-only", async () => {
    const w = window as unknown as Record<string, unknown>;
    w.Didomi = {};
    const calls: string[] = [];
    w.__tcfapi = (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
      calls.push(cmd);
      if (cmd === "ping") cb({ cmpLoaded: true, gdprApplies: true, cmpStatus: "loaded", displayStatus: "visible", cmpId: 7 }, true);
      else cb({ tcString: "", eventStatus: "cmpuishown" }, true);
    };
    const g = await probeConsentGlobals(["Didomi", "OneTrust", "__tcfapi"]);
    expect(g.globals).toEqual(["Didomi", "__tcfapi"]);
    expect(g.tcf).toEqual({
      present: true,
      ping: { cmpLoaded: true, gdprApplies: true, cmpStatus: "loaded", displayStatus: "visible", cmpId: 7 },
      hasTcString: false,
      eventStatus: "cmpuishown",
    });
    expect(calls).toEqual(["ping", "getTCData"]);
  });

  it("does not wait forever on a TCF API that never answers", async () => {
    (window as unknown as Record<string, unknown>).__tcfapi = () => undefined;
    const g = await probeConsentGlobals(["__tcfapi"]);
    expect(g.tcf).toMatchObject({ present: true, ping: null, hasTcString: null });
  });
});

describe("panel", () => {
  it("is registered under Inspect with the GDPR keywords", () => {
    const p = PANELS.find((x) => x.id === "consent")!;
    expect(p).toMatchObject({ category: "inspect", title: "Consent check", short: "Consent" });
    for (const k of ["gdpr", "rgpd", "cookie banner", "cmp", "eprivacy", "consent mode", "cookies before consent"])
      expect(p.keywords).toContain(k);
  });
});
