import { afterEach, describe, expect, it } from "vitest";
import { dataLayerMarkdown } from "../src/lib/agent/inspect";
import {
  addSnapshot,
  analyzeDataLayer,
  compareSnapshots,
  dataLayerReport,
  eventMatches,
  findPii,
  ibanValid,
  ISO_4217,
  type LayerEvent,
  luhnValid,
  makeSnapshot,
  maskPii,
  normalizeEvents,
  paramsPreview,
  SNAPSHOT_LIMIT,
  SNAPSHOT_MAX_SIZE,
} from "../src/lib/datalayer";
import { type DataLayerSnapshot, type RawDataLayer, readDataLayer } from "../src/lib/page/datalayer";
import { PANELS } from "../src/lib/panels";

/** `gtag(...)` as the page pushes it: an `arguments` object. */
function args(..._a: unknown[]): IArguments {
  // biome-ignore lint/complexity/noArguments: gtag pushes the arguments object itself
  return arguments;
}

/** A dataLayer entry as `readDataLayer` copies it: a gtag call becomes `{ "0": …, "1": …, "2": … }`. */
type Entry = Record<string, unknown> | { gtag: unknown[] } | string;
const gtag = (...a: unknown[]): Entry => ({ gtag: a });

function layer(entries: Entry[], name = "dataLayer"): RawDataLayer {
  return {
    name,
    length: entries.length,
    entries: entries.map((e, index) =>
      typeof e === "object" && "gtag" in e && Array.isArray(e.gtag)
        ? { index, gtag: true, value: Object.fromEntries(e.gtag.map((v, i) => [String(i), v])) }
        : { index, gtag: false, value: e },
    ),
  };
}

function snap(entries: Entry[], extra: Partial<DataLayerSnapshot> = {}): DataLayerSnapshot {
  return {
    url: "https://shop.test/product",
    title: "Shop",
    layers: [layer(entries)],
    containers: [{ id: "GTM-ABC123", source: "google_tag_manager", layer: "dataLayer" }],
    jsonLd: [],
    truncated: false,
    size: 0,
    ...extra,
  };
}

const ids = (s: DataLayerSnapshot) => analyzeDataLayer(s).issues.map((i) => i.id);
const issue = (s: DataLayerSnapshot, id: string) => analyzeDataLayer(s).issues.find((i) => i.id === id);

const CONSENT_OK = gtag("consent", "default", {
  ad_storage: "denied",
  analytics_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
});
const item = { item_id: "MUG-1", item_name: "Acme Mug", price: 12.5, quantity: 1 };

describe("readDataLayer (page function)", () => {
  const w = window as unknown as Record<string, unknown>;
  afterEach(() => {
    delete w.dataLayer;
    delete w.myLayer;
    delete w.google_tag_manager;
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("copies gtag arguments, functions, DOM nodes, dates and cycles into plain JSON", () => {
    document.body.innerHTML = '<div id="buy" class="btn primary"></div>';
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const shared = { a: 1 };
    const dl: unknown[] = [];
    w.dataLayer = dl;
    const push = dl.push;
    dl.push(
      args("consent", "default", { ad_storage: "denied" }),
      { event: "click", eventCallback: function eventCallback() {}, element: document.getElementById("buy") },
      { event: "loop", data: cyclic, twice: [shared, shared] },
      { event: "dated", at: new Date("2026-01-02T03:04:05Z"), n: Number.NaN, big: BigInt(5), un: undefined },
    );
    const out = readDataLayer();
    expect(out.layers).toHaveLength(1);
    const [consent, click, loop, dated] = out.layers[0]!.entries;
    expect(consent).toEqual({ index: 0, gtag: true, value: { 0: "consent", 1: "default", 2: { ad_storage: "denied" } } });
    expect(click!.gtag).toBe(false);
    expect(click!.value).toEqual({ event: "click", eventCallback: "[Function eventCallback]", element: "<div#buy.btn.primary>" });
    expect(loop!.value).toEqual({ event: "loop", data: { name: "loop", self: "[Circular]" }, twice: [{ a: 1 }, { a: 1 }] });
    expect(dated!.value).toEqual({ event: "dated", at: "2026-01-02T03:04:05.000Z", n: "NaN", big: "5n" });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    // Read-only: nothing about the array changed.
    expect(dl.push).toBe(push);
    expect(dl).toHaveLength(4);
    expect(out.truncated).toBe(false);
  });

  it("caps depth and size, and says so", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    w.dataLayer = [{ event: "deep", deep }];
    const d = readDataLayer();
    expect(JSON.stringify(d.layers[0]!.entries[0]!.value)).toContain("[Too deep]");
    expect(d.truncated).toBe(true);

    w.dataLayer = Array.from({ length: 400 }, (_, i) => ({ event: `e${i}`, blob: "x".repeat(3900) }));
    const big = readDataLayer();
    expect(big.truncated).toBe(true);
    expect(big.layers[0]!.length).toBe(400);
    expect(big.layers[0]!.entries.length).toBeLessThan(400);
    expect(big.size).toBeLessThan(1_100_000);
  });

  it("finds other dataLayer names and container ids from google_tag_manager and the tag scripts", () => {
    w.dataLayer = [{ event: "gtm.js" }];
    w.myLayer = [{ event: "custom" }];
    w.google_tag_manager = { "GTM-ABC123": { dataLayer: { name: "myLayer" } }, "G-XYZ789": {}, dataLayer: { gtmLoad: true }, mcc: {} };
    document.head.innerHTML =
      '<script type="text/x-template" src="https://www.googletagmanager.com/gtag/js?id=AW-555&l=dataLayer"></script>' +
      '<script type="text/x-template" src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123&l=myLayer"></script>';
    const out = readDataLayer();
    expect(out.layers.map((l) => l.name)).toEqual(["dataLayer", "myLayer"]);
    expect(out.containers).toEqual([
      { id: "GTM-ABC123", source: "google_tag_manager", layer: "myLayer" },
      { id: "G-XYZ789", source: "google_tag_manager", layer: undefined },
      { id: "AW-555", source: "script", layer: "dataLayer" },
    ]);
  });

  it("reads JSON-LD blocks and returns no layer when there is no dataLayer", () => {
    document.head.innerHTML = '<script type="application/ld+json">{"@type":"Product"}</script>';
    const out = readDataLayer();
    expect(out.layers).toEqual([]);
    expect(out.jsonLd).toEqual([{ raw: '{"@type":"Product"}', index: 0 }]);
    expect(analyzeDataLayer(out).counts.layers).toBe(0);
  });
});

describe("events", () => {
  it("normalizes pushes and gtag commands", () => {
    const events = normalizeEvents([
      layer([
        gtag("js", "2026-01-01"),
        gtag("config", "G-ABC"),
        CONSENT_OK,
        gtag("event", "purchase", { transaction_id: "T1" }),
        gtag("set", { user_id: "u1" }),
        { event: "gtm.js", "gtm.start": 1 },
        { ecommerce: null },
        "loose",
      ]),
    ]);
    expect(events.map((e) => [e.kind, e.name])).toEqual([
      ["js", "js"],
      ["config", "config G-ABC"],
      ["consent", "consent default"],
      ["event", "purchase"],
      ["set", "set"],
      ["event", "gtm.js"],
      ["data", "(data)"],
      ["data", "(value)"],
    ]);
    expect(events[3]!.params).toEqual({ transaction_id: "T1" });
    expect(events[5]!.params).toEqual({ "gtm.start": 1 });
  });

  it("counts entries, events, unique events, consent commands and containers", () => {
    const a = analyzeDataLayer(
      snap([CONSENT_OK, gtag("config", "G-ABC"), { event: "gtm.js" }, { event: "page_view" }, { event: "page_view", page: "/b" }]),
    );
    expect(a.counts).toMatchObject({ layers: 5, events: 3, unique: 2, consent: 1, containers: 2 });
    expect(a.containers.map((c) => [c.id, c.kind, c.sources])).toEqual([
      ["G-ABC", "GA4 measurement ID", ["config"]],
      ["GTM-ABC123", "Tag Manager container", ["google_tag_manager"]],
    ]);
  });

  it("previews and filters events", () => {
    const [e] = normalizeEvents([
      layer([{ event: "purchase", ecommerce: { transaction_id: "T1", value: 10, currency: "EUR", items: [item], x: 1 } }]),
    ]);
    expect(paramsPreview(e!)).toBe("transaction_id: T1 · value: 10 · currency: EUR · items: [1] · +1");
    expect(eventMatches(e!, "MUG-1")).toBe(true);
    expect(eventMatches(e!, "refund")).toBe(false);
  });
});

describe("GA4 validation", () => {
  it("flags purchase without transaction_id, non-numeric and zero values, bad currencies", () => {
    expect(ids(snap([CONSENT_OK, { event: "purchase", ecommerce: { value: 10, currency: "EUR", items: [item] } }]))).toEqual([
      "transaction-id",
    ]);
    const comma = issue(
      snap([{ event: "purchase", ecommerce: { transaction_id: "T1", value: "129,00", currency: "EUR", items: [item] } }]),
      "value-type",
    );
    expect(comma).toMatchObject({ level: "bad", path: "dataLayer[0].ecommerce.value" });
    expect(
      issue(snap([gtag("event", "purchase", { transaction_id: "T1", value: "129.00", currency: "EUR", items: [item] })]), "value-type"),
    ).toMatchObject({
      level: "warn",
      path: "dataLayer[0][2].value",
    });
    expect(issue(snap([{ event: "add_to_cart", ecommerce: { value: 0, currency: "EUR", items: [item] } }]), "value-zero")?.level).toBe(
      "warn",
    );
    expect(issue(snap([{ event: "add_to_cart", ecommerce: { value: 5, items: [item] } }]), "currency-missing")?.level).toBe("bad");
    expect(issue(snap([{ event: "add_to_cart", ecommerce: { value: 5, currency: "€", items: [item] } }]), "currency-code")?.level).toBe(
      "bad",
    );
    expect(issue(snap([{ event: "add_to_cart", ecommerce: { value: 5, currency: "eur", items: [item] } }]), "currency-code")?.level).toBe(
      "warn",
    );
    expect(ISO_4217.has("EUR") && ISO_4217.has("JPY") && !ISO_4217.has("EURO")).toBe(true);
  });

  it("needs items[] with item_id or item_name", () => {
    expect(ids(snap([{ event: "view_item", ecommerce: { currency: "EUR" } }]))).toContain("items-missing");
    expect(ids(snap([{ event: "view_item", ecommerce: { items: {} } }]))).toContain("items-type");
    const unnamed = issue(snap([{ event: "view_item_list", ecommerce: { items: [item, { price: 3 }, { item_name: "" }] } }]), "item-id");
    expect(unnamed?.label).toBe("2 items without item_id or item_name");
    expect(unnamed?.path).toBe("dataLayer[0].ecommerce.items[1]");
    expect(ids(snap([{ event: "refund", ecommerce: { transaction_id: "T1" } }]))).not.toContain("items-missing");
    expect(ids(snap([{ event: "view_item", ecommerce: { items: [{ ...item, price: "12,50", quantity: "2" }] } }]))).toEqual(
      expect.arrayContaining(["item-price", "item-quantity"]),
    );
  });

  it("flags legacy Universal Analytics, UA tags and ecommerce not cleared", () => {
    const ua = issue(
      snap([{ event: "purchase", ecommerce: { purchase: { actionField: { id: "T1", revenue: "10" }, products: [] } } }]),
      "legacy-ua",
    );
    expect(ua?.label).toBe("Legacy Universal Analytics structure");
    expect(ua?.detail).toContain("ecommerce.purchase.actionField");
    expect(ids(snap([{ event: "productDetail", ecommerce: { detail: { products: [] } } }]))).toContain("legacy-ua");
    expect(ids(snap([{ event: "impr", ecommerce: { impressions: [] } }]))).toContain("legacy-ua");
    expect(ids(snap([{ event: "add", ecommerce: { add: { products: [] } } }]))).toContain("legacy-ua");
    expect(ids(snap([gtag("config", "UA-1234-1")]))).toContain("ua-config");

    const notCleared = snap([
      { event: "view_item", ecommerce: { items: [item] } },
      { event: "add_to_cart", ecommerce: { value: 12.5, currency: "EUR", items: [item] } },
    ]);
    expect(ids(notCleared)).toContain("ecommerce-not-cleared");
    const cleared = snap([
      { event: "view_item", ecommerce: { items: [item] } },
      { ecommerce: null },
      { event: "add_to_cart", ecommerce: { value: 12.5, currency: "EUR", items: [item] } },
    ]);
    expect(ids(cleared)).not.toContain("ecommerce-not-cleared");
  });

  it("checks GA4 event names on gtag events, as a note on GTM pushes", () => {
    expect(issue(snap([gtag("event", "add to cart")]), "event-name")?.level).toBe("warn");
    expect(issue(snap([{ event: "form-submit" }]), "event-name")?.level).toBe("info");
    expect(issue(snap([gtag("event", "session_start")]), "event-name")?.label).toContain("Reserved");
    expect(ids(snap([{ event: "gtm.dom" }, { event: "sign_up" }]))).not.toContain("event-name");
  });

  it("finds events fired twice and transactions sent twice", () => {
    const twice = snap([
      CONSENT_OK,
      { event: "sign_up", method: "email", "gtm.uniqueEventId": 3 },
      { event: "sign_up", method: "email", "gtm.uniqueEventId": 4 },
      { event: "sign_up", method: "google" },
    ]);
    expect(issue(twice, "duplicate-event")).toMatchObject({ level: "warn", label: "sign_up fired 2 times", path: "dataLayer[2]" });
    const purchase = { transaction_id: "T9", value: 10, currency: "EUR", items: [item] };
    const orders = analyzeDataLayer(
      snap([CONSENT_OK, { event: "purchase", ecommerce: purchase }, { ecommerce: null }, { event: "purchase", ecommerce: purchase }]),
    );
    expect(orders.issues.map((i) => i.id)).toEqual(["duplicate-transaction"]);
    expect(orders.issues[0]!.level).toBe("bad");
  });
});

describe("Consent Mode v2", () => {
  it("accepts a full default followed by an update", () => {
    const a = analyzeDataLayer(
      snap([CONSENT_OK, gtag("config", "G-1"), gtag("consent", "update", { ad_storage: "granted", analytics_storage: "granted" })]),
    );
    expect(a.issues.filter((i) => i.area === "consent")).toEqual([]);
    expect(a.consent.map((s) => s.command)).toEqual(["default", "update"]);
  });

  it("flags update without default, update before default, default after tags", () => {
    expect(issue(snap([gtag("consent", "update", { ad_storage: "granted" })]), "consent-no-default")?.level).toBe("bad");
    const early = snap([gtag("consent", "update", { ad_storage: "granted" }), CONSENT_OK]);
    expect(issue(early, "consent-update-first")).toMatchObject({ level: "bad", path: "dataLayer[0]" });
    const late = snap([gtag("js", "x"), gtag("config", "G-1"), CONSENT_OK]);
    expect(issue(late, "consent-default-late")).toMatchObject({ level: "warn", path: "dataLayer[2]" });
    // GTM's own gtm.js push does not count as a tag firing.
    expect(ids(snap([{ event: "gtm.js" }, CONSENT_OK]))).not.toContain("consent-default-late");
  });

  it("reports the missing v2 types, invalid values and wait_for_update", () => {
    const v1 = analyzeDataLayer(
      snap([gtag("consent", "default", { ad_storage: "denied", analytics_storage: "denied", wait_for_update: 500 })]),
    );
    const v2 = v1.issues.find((i) => i.id === "consent-v2");
    expect(v2?.label).toBe("Consent Mode v2: ad_user_data and ad_personalization missing");
    expect(v1.issues.find((i) => i.id === "consent-wait")?.label).toBe("Default waits 500 ms for an update");
    expect(v1.consent[0]).toMatchObject({
      command: "default",
      waitForUpdate: 500,
      states: { ad_storage: "denied", analytics_storage: "denied" },
    });
    const invalid = issue(
      snap([
        gtag("consent", "default", { ad_storage: "no", analytics_storage: true, ad_user_data: "denied", ad_personalization: "denied" }),
      ]),
      "consent-value",
    );
    expect(invalid).toMatchObject({ level: "bad", path: "dataLayer[0][2].ad_storage" });
    expect(
      ids(snap([gtag("consent", "default", { ad_storage: "no", analytics_storage: true })])).filter((i) => i === "consent-value"),
    ).toHaveLength(2);
  });

  it("notes a page with tags and no consent command", () => {
    expect(issue(snap([{ event: "gtm.js" }]), "consent-none")?.level).toBe("info");
    expect(ids(snap([{ event: "x" }], { containers: [] }))).not.toContain("consent-none");
  });
});

describe("PII", () => {
  const pii = (value: unknown) => findPii([layer([value as Entry])]).map((f) => [f.kind, f.path]);

  it("finds e-mails, phone numbers, IBANs and card numbers by path", () => {
    expect(pii({ event: "login", user: { email: "Jane.Doe@example.com" } })).toEqual([["email", "dataLayer[0].user.email"]]);
    expect(pii({ event: "x", page_location: "https://a.test/?mail=jane%40x.fr&e=jane@x.fr" })).toEqual([
      ["email", "dataLayer[0].page_location"],
    ]);
    expect(pii({ event: "lead", contact: "+33 6 12 34 56 78" })).toEqual([["phone", "dataLayer[0].contact"]]);
    expect(pii({ event: "lead", note: "call 06 12 34 56 78" })).toEqual([["phone", "dataLayer[0].note"]]);
    expect(pii({ event: "lead", phone: 33612345678 })).toEqual([["phone", "dataLayer[0].phone"]]);
    expect(pii({ event: "lead", user_tel: "0612345678" })).toEqual([["phone", "dataLayer[0].user_tel"]]);
    expect(pii({ event: "pay", iban: "FR76 3000 6000 0112 3456 7890 189" })).toEqual([["iban", "dataLayer[0].iban"]]);
    expect(pii({ event: "pay", note: "to GB82WEST12345698765432 please" })).toEqual([["iban", "dataLayer[0].note"]]);
    expect(pii({ event: "pay", card_number: "4111111111111111" })).toEqual([["card", "dataLayer[0].card_number"]]);
    expect(pii({ event: "pay", note: "4242 4242 4242 4242" })).toEqual([["card", "dataLayer[0].note"]]);
    expect(findPii([layer([gtag("event", "login", { items: [{ email: "a@b.io" }] })])]).map((f) => f.path)).toEqual([
      "dataLayer[0][2].items[0].email",
    ]);
  });

  it("leaves order ids, timestamps, dates, hashes and file names alone", () => {
    expect(
      pii({
        event: "purchase",
        transaction_id: "4242424242424242",
        order_id: 4111111111111111,
        timestamp: 1700000000000,
        ts: "1700000000000",
        "gtm.uniqueEventId": 123456789012,
        date: "2026-11-20T10:00:00+01:00",
        ref: "123-456-789",
        sku: "SKU-1234-5678-9012",
        hashed_email: "a5b9d0e7c8f6a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d0",
        image: "https://cdn.test/logo@2x.png",
        price: 1299.99,
        iban_like: "FR7630006000011234567890180",
        count: "1234567890123",
      }),
    ).toEqual([]);
    expect(ibanValid("FR7630006000011234567890189")).toBe(true);
    expect(ibanValid("FR7630006000011234567890180")).toBe(false);
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });

  it("masks PII everywhere and never leaks a value", () => {
    const raw = {
      event: "lead",
      user: { email: "jane.doe@example.com", phone: "+33 6 12 34 56 78" },
      iban: "FR76 3000 6000 0112 3456 7890 189",
      card: 4111111111111111,
      note: "card 4242 4242 4242 4242, mail jane@x.fr",
    };
    const masked = maskPii(raw);
    expect(masked).toEqual({
      event: "lead",
      user: { email: "j•••@•••.com", phone: "+•••78" },
      iban: "FR••••89",
      card: "••••1111",
      note: "card ••••4242, mail j•••@•••.fr",
    });
    expect(maskPii(masked)).toEqual(masked);
    const s = snap([raw]);
    const a = analyzeDataLayer(s);
    const everything = JSON.stringify([a, dataLayerReport(a), dataLayerMarkdown(a, { url: s.url }), makeSnapshot(s, a)]);
    for (const leak of ["jane.doe@example.com", "12 34 56", "3000 6000", "4111111111111111", "4242 4242", "jane@x.fr"])
      expect(everything).not.toContain(leak);
    expect(a.counts.pii).toBe(6);
    expect(a.issues.filter((i) => i.area === "pii").map((i) => i.label)).toEqual([
      "E-mail addresses (2) in the dataLayer",
      "Phone number in the dataLayer",
      "IBAN in the dataLayer",
      "Card numbers (2) in the dataLayer",
    ]);
  });
});

describe("JSON-LD cross-check", () => {
  const productLd = (offers: unknown) => [
    { raw: JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Acme Mug", sku: "MUG-1", offers }), index: 0 },
  ];

  it("flags price, currency and SKU mismatches between items[] and the Product markup", () => {
    const s = snap(
      [{ event: "view_item", ecommerce: { currency: "USD", items: [{ item_id: "MUG-1", item_name: "Acme Mug", price: 15 }] } }],
      {
        jsonLd: productLd({ "@type": "Offer", price: "12.50", priceCurrency: "EUR" }),
      },
    );
    expect(ids(s)).toEqual(expect.arrayContaining(["jsonld-price", "jsonld-currency"]));
    expect(issue(s, "jsonld-price")?.detail).toContain("12.5");
    const sku = snap([{ event: "view_item", ecommerce: { items: [{ item_id: "MUG-2", item_name: "Acme Mug", price: 12.5 }] } }], {
      jsonLd: productLd({ "@type": "Offer", price: 12.5, priceCurrency: "EUR" }),
    });
    expect(ids(sku).filter((i) => i.startsWith("jsonld"))).toEqual(["jsonld-sku"]);
    expect(issue(sku, "jsonld-sku")?.path).toBe("dataLayer[0].ecommerce.items[0].item_id");
  });

  it("agrees when they match, and with an AggregateOffer range", () => {
    const ok = snap([{ event: "view_item", ecommerce: { currency: "EUR", value: 12.5, items: [{ item_id: "MUG-1", price: 12.5 }] } }], {
      jsonLd: productLd({ "@type": "Offer", price: "12.50", priceCurrency: "EUR" }),
    });
    expect(ids(ok).filter((i) => i.startsWith("jsonld"))).toEqual([]);
    const range = snap([{ event: "view_item", ecommerce: { currency: "EUR", items: [{ item_id: "MUG-1", price: 14 }] } }], {
      jsonLd: productLd({ "@type": "AggregateOffer", lowPrice: 10, highPrice: 20, priceCurrency: "EUR" }),
    });
    expect(ids(range).filter((i) => i.startsWith("jsonld"))).toEqual([]);
  });
});

describe("snapshots", () => {
  const events = (entries: Entry[]): LayerEvent[] => normalizeEvents([layer(entries)]);

  it("finds added, removed, duplicated and changed events", () => {
    const before = events([{ event: "gtm.js" }, { event: "view_item", ecommerce: { items: [item] } }, { event: "scroll", percent: 50 }]);
    const after = events([
      { event: "gtm.js" },
      { event: "view_item", ecommerce: { items: [{ ...item, price: 15 }] } },
      { event: "add_to_cart", ecommerce: { items: [item] } },
      { event: "add_to_cart", ecommerce: { items: [item] } },
    ]);
    const d = compareSnapshots(before, after);
    expect(d.unchanged).toBe(1);
    expect(d.changed.map((c) => [c.after.name, c.changes])).toEqual([
      ["view_item", [{ path: "ecommerce.items[0].price", before: "12.5", after: "15" }]],
    ]);
    expect(d.added.map((e) => e.name)).toEqual(["add_to_cart"]);
    expect(d.duplicated.map((e) => [e.name, e.index])).toEqual([["add_to_cart", 3]]);
    expect(d.removed.map((e) => e.name)).toEqual(["scroll"]);
  });

  it("pairs events that moved by name and key parameters", () => {
    const p = { transaction_id: "T1", value: 10, currency: "EUR", items: [item] };
    const before = events([{ event: "purchase", ecommerce: p }]);
    const after = events([{ event: "gtm.js" }, { event: "purchase", ecommerce: { ...p, value: 11 } }]);
    const d = compareSnapshots(before, after);
    expect(d.changed).toHaveLength(1);
    expect(d.added.map((e) => e.name)).toEqual(["gtm.js"]);
    expect(d.removed).toEqual([]);
    expect(compareSnapshots(before, before)).toEqual({ added: [], removed: [], duplicated: [], changed: [], unchanged: 1 });
  });

  it("stores masked, trimmed snapshots, at most 50", () => {
    const s = snap([
      { event: "login", email: "jane@x.fr" },
      ...Array.from({ length: 100 }, (_, i) => ({ event: `e${i}`, blob: "y".repeat(3000) })),
    ]);
    const a = analyzeDataLayer(s);
    const saved = makeSnapshot(s, a, 1_700_000_000_000);
    expect(saved.at).toBe(1_700_000_000_000);
    expect(JSON.stringify(saved)).not.toContain("jane@x.fr");
    expect(JSON.stringify(saved.layers).length).toBeLessThanOrEqual(SNAPSHOT_MAX_SIZE + 1000);
    expect(saved.truncated).toBe(true);
    expect(saved.events).toBe(101);
    let list = [saved];
    for (let i = 0; i < 60; i++) list = addSnapshot(list, { ...saved, id: String(i) });
    expect(list).toHaveLength(SNAPSHOT_LIMIT);
    expect(list[0]!.id).toBe("59");
    expect(compareSnapshots(normalizeEvents(saved.layers), a.events).added.length).toBeGreaterThan(0);
  });
});

describe("reports", () => {
  const s = snap([
    gtag("consent", "default", { ad_storage: "denied", analytics_storage: "denied" }),
    gtag("consent", "update", { ad_storage: "granted" }),
    { event: "purchase", ecommerce: { value: "129,00", currency: "EUR", items: [item] } },
    { event: "login", email: "jane@x.fr" },
  ]);
  const a = analyzeDataLayer(s);

  it("copies a plain-text report with counts, containers, issues, consent and events", () => {
    const r = dataLayerReport(a);
    expect(r).toContain("Issues: 4 (3 problems, 1 warning");
    expect(r).toContain("GTM-ABC123: Tag Manager container");
    expect(r).toContain("[problem] purchase without transaction_id — dataLayer[2].ecommerce");
    expect(r).toContain("dataLayer[0] default: ad_storage=denied, analytics_storage=denied");
    expect(r).toContain("dataLayer[3] login — email: j•••@•••.fr");
  });

  it("gives the agent what to fix and where", () => {
    const md = dataLayerMarkdown(a, { url: s.url });
    expect(md.startsWith("## dataLayer (GA4, Consent Mode, GTM)")).toBe(true);
    expect(md).toContain("Result: 3 problems, 1 warning");
    expect(md).toContain("Where: `dataLayer[2].ecommerce`");
    expect(md).toContain("Fix: Add `transaction_id`");
    expect(md).toContain("### Consent sequence");
    expect(md).not.toContain("jane@x.fr");
    expect(dataLayerMarkdown(analyzeDataLayer(snap([], { layers: [] })), { url: s.url })).toContain(
      "Result: No dataLayer found on this page.",
    );
  });

  it("registers the panel", () => {
    const p = PANELS.find((x) => x.id === "datalayer");
    expect(p?.category).toBe("inspect");
    expect(p?.keywords).toContain("consent mode");
  });
});
