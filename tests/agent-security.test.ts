import { describe, expect, it } from "vitest";
import {
  assetsMarkdown,
  cookiesMarkdown,
  cspMarkdown,
  exposedMarkdown,
  secretsMarkdown,
  thirdPartiesMarkdown,
} from "../src/lib/agent/security";
import { buildAssets } from "../src/lib/assets";
import type { RawAsset } from "../src/lib/page/assets";
import type { SurfaceSnapshot } from "../src/lib/page/security";
import type { CookieLike } from "../src/lib/security/cookies";
import { parseCsp, starterCsp } from "../src/lib/security/csp";
import { judgeProbe, type MapCheck, PROBES, type ProbeResponse } from "../src/lib/security/exposed";
import { scanSecrets, type SecretSource } from "../src/lib/security/secrets";

// Fake values, assembled at runtime so no file holds a string a secret scanner would take for a real key.
const j = (...parts: string[]) => parts.join("");
const STRIPE = j("sk_", "live_", "51DevkitFake9Qw3Er7Ty2Ui8Op4As");
const AWS_ID = j("AKIA", "DEVKITFAKE7Q2W4E");
const AWS_SECRET = j("devkitFAKE/9s8d7f6g5h4", "j3k2l1Zx+Cv8Bn7Mq0");
const PAGE = "https://shop.example.com/cart";

const snapshot = (over: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot => ({
  url: PAGE,
  resources: [],
  scripts: [],
  styles: [],
  preloads: [],
  iframes: [],
  images: [],
  media: [],
  forms: [],
  inlineScripts: 0,
  inlineHandlers: 0,
  inlineStyles: 0,
  styleAttributes: 0,
  dataImages: false,
  metaCsp: [],
  insecure: [],
  ...over,
});

describe("secretsMarkdown", () => {
  const sources: SecretSource[] = [
    { kind: "inline-script", label: "inline script #2", text: `window.cfg = {\n  stripe: "${STRIPE}",\n};` },
    {
      kind: "script",
      label: "/static/app.js",
      url: "https://shop.example.com/static/app.js",
      text: `const s3 = { accessKeyId: "${AWS_ID}", secretAccessKey: "${AWS_SECRET}" };`,
    },
  ];
  const findings = scanSecrets(sources);
  const md = secretsMarkdown(findings, { url: PAGE, scan: { sources: 1, scripts: 1, skipped: 2 } });

  it("names the secret, where it is, and says to rotate it and move it server-side", () => {
    expect(md).toMatch(/^## Secrets\nPage: https:\/\/shop\.example\.com\/cart\nResult: 3 likely leaked credentials\./);
    expect(md).toContain("### To fix");
    expect(md).toContain("**Stripe live secret key** `sk_l…p4As`");
    expect(md).toContain('Found in `inline script #2`, line 2, column 12: `window.cfg = { stripe: "sk_l…p4As", };`');
    expect(md).toContain("Found in script `https://shop.example.com/static/app.js`, line 1");
    expect(md).toContain("revoke or rotate the Stripe live secret key at its provider");
    expect(md).toContain("move the code that needs it to the server");
    expect(md).toContain("2 third-party scripts not fetched");
    expect(md).toContain("To check the fix:");
  });
  it("never contains a raw secret value, even one sitting next to another match", () => {
    for (const raw of [STRIPE, AWS_ID, AWS_SECRET]) {
      expect(md).not.toContain(raw);
      // No 12-character run of the value either.
      for (let i = 0; i + 12 <= raw.length; i++) expect(md).not.toContain(raw.slice(i, i + 12));
    }
  });
  it("says so plainly when nothing is found, and nests under the page report", () => {
    const none = secretsMarkdown([], { url: PAGE, heading: "###" });
    expect(none).toContain("### Secrets");
    expect(none).toContain("Result: No problem found");
    expect(none).not.toContain("To fix");
  });
});

describe("exposedMarkdown", () => {
  const res = (status: number, text: string): ProbeResponse => ({
    status,
    text,
    bytes: new TextEncoder().encode(text),
    type: "text/plain",
    url: "https://shop.example.com/x",
  });
  const probes = PROBES.map((p) =>
    judgeProbe(p, p.path === "/.git/HEAD" ? res(200, "ref: refs/heads/main\n") : res(404, "not found"), res(404, "not found")),
  );
  const maps: MapCheck[] = [
    {
      file: "https://shop.example.com/app.js",
      kind: "script",
      map: "https://shop.example.com/app.js.map",
      via: "comment",
      state: "reachable",
      status: 200,
      size: 52_000,
      sources: true,
    },
    { file: "https://shop.example.com/site.css", kind: "stylesheet", map: null, via: null, state: "none" },
  ];

  it("lists exposed files with the server fix and readable maps with the build fix", () => {
    const md = exposedMarkdown({ maps, probes }, { url: PAGE });
    expect(md).toContain("Result: 1 exposed file, 1 readable source map.");
    expect(md).toContain("`https://shop.example.com/.git/HEAD` is served (HTTP 200 and the content matches)");
    expect(md).toContain("deny it at the server");
    expect(md).toContain("### Worth checking");
    expect(md).toContain("`https://shop.example.com/app.js.map` (50.8 KB), original sources included");
    expect(md).toContain("hidden-source-map");
    expect(md).toContain("/.well-known/security.txt");
  });
  it("says when the probe was not run, and when nothing is exposed", () => {
    const md = exposedMarkdown({ maps: [maps[1]!], probes: null }, { url: PAGE });
    expect(md).toContain("Result: No readable source map; exposed files were not probed.");
    expect(md).toContain("not probed (the panel's \"Probe");
    const clean = exposedMarkdown(
      { maps: [maps[1]!], probes: PROBES.map(() => judgeProbe(PROBES[0]!, res(404, ""), null)) },
      { url: PAGE },
    );
    expect(clean).toContain("Result: No problem found");
  });
});

describe("thirdPartiesMarkdown", () => {
  const snap = snapshot({
    scripts: [
      { src: "https://cdn.vendor.net/lib@1.2.3/lib.min.js", integrity: "", crossorigin: null, type: "" },
      { src: "https://cdn.other.org/pinned.js", integrity: "sha384-abc", crossorigin: null, type: "" },
      { src: "https://shop.example.com/own.js", integrity: "", crossorigin: null, type: "" },
    ],
    resources: [
      { name: "https://cdn.vendor.net/lib@1.2.3/lib.min.js", type: "script", transfer: 30_000, encoded: 29_000, decoded: 90_000 },
      { name: "https://www.analytics.io/collect", type: "beacon", transfer: 0, encoded: 0, decoded: 0 },
    ],
  });
  const md = thirdPartiesMarkdown(snap, { url: PAGE });

  it("gives the integrity and crossorigin attributes to add, and how to get the hash", () => {
    expect(md).toContain("Result: 2 problems to fix");
    expect(md).toContain(
      '`<script src="https://cdn.vendor.net/lib@1.2.3/lib.min.js" integrity="sha384-<hash>" crossorigin="anonymous"></script>`',
    );
    expect(md).toContain("openssl dgst -sha384 -binary | openssl base64 -A");
    expect(md).toContain('add `crossorigin="anonymous"` to the tag');
    // The missing crossorigin (blocked load) comes before the missing integrity.
    expect(md.indexOf("integrity without crossorigin")).toBeLessThan(md.indexOf("Cross-origin script without integrity"));
    expect(md).not.toContain("own.js");
  });
  it("lists the third-party sites", () => {
    expect(md).toContain("### Third-party sites");
    expect(md).toContain("`vendor.net`: 1 request, 29.3 KB");
    expect(md).toContain("`analytics.io`: 1 request (1 unsized)");
  });
  it("reports a clean page plainly", () => {
    expect(thirdPartiesMarkdown(snapshot(), { url: PAGE })).toContain("Result: No problem found");
  });
});

describe("cspMarkdown", () => {
  it("suggests a script-src without the unsafe sources and a nonce for inline scripts", () => {
    const policies = parseCsp("default-src 'self'; script-src 'self' 'unsafe-inline' https: cdn.jsdelivr.net");
    const md = cspMarkdown({ policies, https: true, starter: starterCsp(snapshot({ inlineScripts: 1 })) }, { url: PAGE });
    expect(md).toContain("## Content-Security-Policy");
    expect(md).toMatch(/Result: 2 problems and \d+ warnings in 1 policy\./);
    expect(md).toContain("Policy 1 (header, enforced): `default-src 'self'; script-src");
    expect(md).toContain("`script-src`: 'unsafe-inline' without a nonce or hash");
    expect(md).toContain("Suggested: `script-src 'self' 'nonce-{RANDOM}'`");
    expect(md).toContain("Suggested: `object-src 'none'`");
    expect(md).toContain("Suggested: `base-uri 'self'`");
    expect(md).toContain("Suggested: `frame-ancestors 'self'`");
    expect(md).toContain("### Worth checking");
    expect(md).toContain("### Starter policy");
    expect(md.indexOf("'unsafe-inline' without")).toBeLessThan(md.indexOf("`object-src`"));
  });
  it("hands over the starter policy when there is none", () => {
    const md = cspMarkdown({ policies: [], https: true, starter: starterCsp(snapshot()) }, { url: PAGE });
    expect(md).toContain("Result: No Content-Security-Policy: injected scripts run unrestricted.");
    expect(md).toContain("Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'");
  });
  it("says so when the policy is sound", () => {
    const policies = parseCsp(
      "default-src 'self'; script-src 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'; report-to csp",
    );
    const md = cspMarkdown({ policies, https: true }, { url: PAGE });
    expect(md).toContain("Result: No problem found in the policy.");
    expect(md).not.toContain("### To fix");
  });
});

describe("cookiesMarkdown", () => {
  const now = 1_800_000_000;
  const cookie = (over: Partial<CookieLike>): CookieLike => ({
    name: "pref",
    value: "1",
    domain: "shop.example.com",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax",
    session: true,
    hostOnly: true,
    ...over,
  });
  const VALUE = "s3cr3t-session-value-0123456789";
  const cookies = [
    cookie({ name: "session_id", value: VALUE, secure: false, domain: ".example.com", hostOnly: false }),
    cookie({ name: "theme", value: "dark-mode-cookie-value", secure: false }),
    cookie({ name: "pref" }),
  ];
  const md = cookiesMarkdown(cookies, { url: PAGE, now });

  it("names the cookie and gives the exact Set-Cookie attributes to add", () => {
    expect(md).toContain("Result: 2 cookies to fix out of 3 (1 with a risky flag).");
    expect(md).toContain("`session_id` (Domain=example.com, Path=/): no Secure, readable by JS, shared with *.example.com");
    expect(md).toContain("`Set-Cookie: session_id=<value>; Path=/; Secure; HttpOnly; SameSite=Lax`");
    expect(md).toContain("adds no Domain (host-only), Secure, HttpOnly");
    expect(md).toContain("`__Host-`");
    expect(md).toContain("`Set-Cookie: theme=<value>; Path=/; Secure; SameSite=Lax`");
    expect(md.indexOf("session_id")).toBeLessThan(md.indexOf("`theme`"));
    expect(md).not.toContain("`pref`");
  });
  it("never contains a cookie value", () => {
    expect(md).not.toContain(VALUE);
    expect(md).not.toContain("dark-mode-cookie-value");
    expect(md).toContain("Cookie values are left out of this report");
  });
  it("reports clean cookies plainly", () => {
    expect(cookiesMarkdown([cookie({})], { url: PAGE, now })).toContain("Result: No problem found in the flags of 1 cookie.");
    expect(cookiesMarkdown([], { url: PAGE, now })).toContain("Result: No problem found: the page has no cookie.");
  });
});

describe("assetsMarkdown", () => {
  const raw = (r: Partial<RawAsset> & Pick<RawAsset, "source">): RawAsset => ({ label: "img", status: "ok", ...r });
  const assets = buildAssets({
    origin: "https://shop.example.com",
    dpr: 1,
    assets: [
      raw({
        source: "img",
        label: "img#hero.banner",
        url: "https://shop.example.com/img/hero.jpg",
        natural: { width: 3200, height: 1600 },
        rendered: { width: 800, height: 400 },
        alt: "Summer sale",
        mime: "image/jpeg",
        bytes: { transfer: 0, encoded: 1_200_000, decoded: 1_200_000 },
      }),
      raw({
        source: "img",
        label: "img.logo",
        url: "https://shop.example.com/img/logo.png",
        natural: { width: 120, height: 40 },
        rendered: { width: 120, height: 40 },
        alt: null,
      }),
      raw({ source: "img", label: "img.gone", url: "https://shop.example.com/img/gone.webp", natural: null, status: "broken", alt: "" }),
      raw({ source: "svg", label: "svg.icon-cart", markup: "<svg></svg>", roleImg: true }),
    ],
  });
  const md = assetsMarkdown(assets, { url: PAGE, dpr: 1 });

  it("gives displayed vs natural size, bytes, a target size and format", () => {
    expect(md).toMatch(
      /Result: 1 broken, 1 oversized \(about [\d.]+ KB more than needed\), 2 without alt or accessible name, out of 4 assets\./,
    );
    expect(md).toContain(
      "Oversized JPEG `hero.jpg`: 3200 × 1600 px served for 800 × 400 CSS px on screen, 4× what a 1× screen needs (1.14 MB",
    );
    expect(md).toContain("serve it at about 1600 × 800 px (2× the displayed size) in AVIF or WebP");
    expect(md).toContain("Element: `img#hero.banner`");
  });
  it("points at images without alt and broken files, broken first", () => {
    expect(md).toContain("Image `logo.png` has no alt attribute.");
    expect(md).toContain("Source: `https://shop.example.com/img/logo.png`");
    expect(md).toContain("Inline SVG `svg.icon-cart` has no accessible name.");
    expect(md).toContain("Broken image `gone.webp`");
    expect(md.indexOf("Broken image")).toBeLessThan(md.indexOf("Oversized JPEG"));
  });
  it("caps long lists", () => {
    const many = buildAssets({
      origin: "https://shop.example.com",
      dpr: 1,
      assets: Array.from({ length: 30 }, (_, i) => raw({ source: "img", url: `https://shop.example.com/${i}.png`, alt: null })),
    });
    const out = assetsMarkdown(many, { url: PAGE });
    expect(out).toContain("20. Image");
    expect(out).not.toContain("21. Image");
    expect(out).toContain("… and 10 more assets.");
  });
  it("reports a clean page plainly", () => {
    expect(assetsMarkdown([], { url: PAGE })).toContain("Result: No problem found");
  });
});
