// dataLayer inspector: turns what `readDataLayer` copied from the page into events, gtag commands and Consent Mode
// steps, and checks them against what GA4 and Consent Mode v2 expect. PII (e-mails, phone numbers, IBANs, card
// numbers) is found by path and masked before anything is shown, copied or stored: no value leaves this module
// unmasked. Pure: no browser API, unit-tested.
import type { Level } from "./headers";
import { analyzeJsonLd } from "./jsonld";
import type { DataLayerSnapshot, RawContainer, RawDataLayer, RawLayerEntry } from "./page/datalayer";

/* ISO 4217 */

/** Active ISO 4217 codes (list of the ISO 4217 maintenance agency, funds and metals included). */
export const ISO_4217 = new Set(
  (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF " +
    "CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD " +
    "HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA " +
    "MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB " +
    "RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN " +
    "UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW " +
    "ZWG ZWL"
  ).split(" "),
);

/* Events */

export type EventKind = "event" | "consent" | "config" | "js" | "set" | "get" | "command" | "data";

export interface LayerEvent {
  /** Position across every layer, in reading order. */
  seq: number;
  layer: string;
  /** Position in its dataLayer array. */
  index: number;
  kind: EventKind;
  /** Event name, or the gtag command: "consent default", "config G-XXXX", "js", "set"; "(data)" for a push without event. */
  name: string;
  /** Pushed through `gtag()`. */
  gtag: boolean;
  /** Second gtag argument of a command: "default" / "update" for consent, the tag id for config. */
  arg?: string;
  /** The event's parameters: gtag's third argument, or the pushed object without its `event` key. */
  params: Record<string, unknown>;
  /** The entry as read (masked). */
  value: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** Path of an entry: `dataLayer[3]`. */
export const entryPath = (layer: string, index: number) => `${layer}[${index}]`;

function pathJoin(base: string, key: string | number, gtagArgs = false): string {
  if (typeof key === "number" || gtagArgs) return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/** Where the event's parameters live: `dataLayer[3][2]` for gtag, `dataLayer[3]` for a push. */
export const paramsPath = (e: Pick<LayerEvent, "layer" | "index" | "gtag" | "kind">) =>
  e.gtag ? `${entryPath(e.layer, e.index)}[${e.kind === "set" ? 1 : 2}]` : entryPath(e.layer, e.index);

function normalizeEntry(layer: string, entry: RawLayerEntry, seq: number): LayerEvent {
  const base = { seq, layer, index: entry.index, gtag: entry.gtag, value: entry.value };
  const v = entry.value;
  if (entry.gtag && isObj(v)) {
    const cmd = str(v["0"]);
    const a1 = v["1"];
    const a2 = isObj(v["2"]) ? v["2"] : {};
    switch (cmd) {
      case "event":
        return { ...base, kind: "event", name: str(a1) || "(unnamed)", params: a2 };
      case "consent":
        return { ...base, kind: "consent", name: `consent ${str(a1)}`.trim(), arg: str(a1), params: a2 };
      case "config":
        return { ...base, kind: "config", name: `config ${str(a1)}`.trim(), arg: str(a1), params: a2 };
      case "js":
        return { ...base, kind: "js", name: "js", params: {} };
      case "set":
        return { ...base, kind: "set", name: "set", params: isObj(a1) ? a1 : a1 !== undefined ? { [str(a1)]: v["2"] } : {} };
      case "get":
        return { ...base, kind: "get", name: `get ${str(a1)}`.trim(), arg: str(a1), params: {} };
      default:
        return { ...base, kind: "command", name: cmd || "(gtag)", params: a2 };
    }
  }
  if (isObj(v)) {
    if (typeof v.event === "string" && v.event) {
      const { event, ...params } = v;
      return { ...base, kind: "event", name: event, params };
    }
    return { ...base, kind: "data", name: "(data)", params: v };
  }
  return { ...base, kind: "data", name: "(value)", params: {} };
}

/** Every entry of every layer as an event or a command, in reading order. */
export function normalizeEvents(layers: RawDataLayer[]): LayerEvent[] {
  const out: LayerEvent[] = [];
  for (const l of layers) for (const e of l.entries) out.push(normalizeEntry(l.name, e, out.length));
  return out;
}

const isGtmInternal = (name: string) => name.startsWith("gtm.");

/** Keys GTM adds or that never reach GA4, left out when comparing events. */
const VOLATILE = (k: string) => k.startsWith("gtm.") || k === "eventCallback" || k === "eventTimeout" || k === "event_callback";

/** JSON with sorted keys and volatile keys dropped, to compare two values. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => !VOLATILE(k))
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The GA4 ecommerce parameters of an event: under `ecommerce` for GTM pushes, the parameters themselves for gtag. */
export function ecommerceOf(e: LayerEvent): { params: Record<string, unknown>; path: string } {
  const ec = e.params.ecommerce;
  if (!e.gtag && isObj(ec)) return { params: ec, path: `${paramsPath(e)}.ecommerce` };
  return { params: e.params, path: paramsPath(e) };
}

/** "transaction_id: T1 · value: 129 · items: [2]", for a one-line preview. */
export function paramsPreview(e: LayerEvent, max = 4): string {
  const src = e.kind === "event" ? ecommerceOf(e).params : e.params;
  const keys = Object.keys(src).filter((k) => !VOLATILE(k));
  const show = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.length}]`;
    if (isObj(v)) return `{${Object.keys(v).length}}`;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 28 ? `${s.slice(0, 27)}…` : s;
  };
  const parts = keys.slice(0, max).map((k) => `${k}: ${show(src[k])}`);
  if (keys.length > max) parts.push(`+${keys.length - max}`);
  return parts.join(" · ");
}

/** Whether an event's name or parameters contain `query` (case-insensitive). */
export function eventMatches(e: LayerEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return e.name.toLowerCase().includes(q) || JSON.stringify(e.params).toLowerCase().includes(q) || e.layer.toLowerCase() === q;
}

/* Issues */

export type IssueArea = "ga4" | "consent" | "pii" | "jsonld" | "duplicates" | "setup";

export interface DataLayerIssue {
  id: string;
  area: IssueArea;
  level: Level;
  label: string;
  detail: string;
  /** Path of the entry or the value concerned, e.g. `dataLayer[3].ecommerce.value`. */
  path?: string;
  /** `seq` of the event concerned. */
  seq?: number;
}

const ECOMMERCE_EVENTS = new Set([
  "add_payment_info",
  "add_shipping_info",
  "add_to_cart",
  "add_to_wishlist",
  "begin_checkout",
  "purchase",
  "refund",
  "remove_from_cart",
  "select_item",
  "select_promotion",
  "view_cart",
  "view_item",
  "view_item_list",
  "view_promotion",
]);
/** Events GA4 documents with a required `items` array (refunds and promotions may leave it out). */
const ITEMS_REQUIRED = new Set([
  "add_payment_info",
  "add_shipping_info",
  "add_to_cart",
  "add_to_wishlist",
  "begin_checkout",
  "purchase",
  "remove_from_cart",
  "select_item",
  "view_cart",
  "view_item",
  "view_item_list",
]);
const TRANSACTION_REQUIRED = new Set(["purchase", "refund"]);
const RESERVED_NAMES = new Set(
  (
    "ad_activeview ad_click ad_exposure ad_query ad_reward adunit_exposure app_clear_data app_exception app_install app_remove " +
    "app_store_refund app_update app_upgrade dynamic_link_app_open dynamic_link_app_update dynamic_link_first_open error first_open " +
    "first_visit in_app_purchase notification_dismiss notification_foreground notification_open notification_receive notification_send " +
    "os_update screen_view session_start user_engagement"
  ).split(" "),
);
/** Universal Analytics enhanced ecommerce actions. */
const UA_KEYS = [
  "impressions",
  "detail",
  "add",
  "remove",
  "checkout",
  "checkout_option",
  "click",
  "promoView",
  "promoClick",
  "currencyCode",
];

const NUMERIC = /^-?\d+(\.\d+)?$/;
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

/** A number, or a string that holds a plain number; null otherwise. */
export function numberOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && NUMERIC.test(v.trim())) return Number(v.trim());
  return null;
}

function numericIssue(
  e: LayerEvent,
  key: string,
  v: unknown,
  path: string,
  what: string,
): Pick<DataLayerIssue, "level" | "label" | "detail"> | null {
  if (typeof v === "number")
    return Number.isFinite(v) ? null : { level: "bad", label: `${what} is not a number`, detail: `${key} is ${v}.` };
  if (typeof v === "string") {
    if (NUMERIC.test(v.trim()))
      return {
        level: "warn",
        label: `${what} sent as a string`,
        detail: `${key} is "${v}" in ${e.name}: send the number ${Number(v.trim())}, without quotes.`,
      };
    return {
      level: "bad",
      label: `${what} is not numeric`,
      detail: `${key} is "${clipText(v, 40)}" in ${e.name}: GA4 needs a number with "." as decimal separator and no currency sign (e.g. 129.00).`,
    };
  }
  return {
    level: "bad",
    label: `${what} is not a number`,
    detail: `${key} is ${Array.isArray(v) ? "an array" : typeof v} in ${e.name} (${path}).`,
  };
}

const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function ga4Issues(e: LayerEvent): DataLayerIssue[] {
  const out: DataLayerIssue[] = [];
  const add = (i: Omit<DataLayerIssue, "seq" | "area"> & { area?: IssueArea }) => out.push({ area: "ga4", seq: e.seq, ...i });
  const name = e.name;

  if (!isGtmInternal(name)) {
    const valid = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name);
    const reserved = RESERVED_NAMES.has(name) || /^(google_|ga_|firebase_)/.test(name);
    if (!valid || reserved)
      add({
        id: "event-name",
        level: e.gtag ? "warn" : "info",
        label: reserved ? `Reserved event name "${clipText(name, 40)}"` : `"${clipText(name, 40)}" is not a valid GA4 event name`,
        detail: reserved
          ? "GA4 reserves this name (or its google_ / ga_ / firebase_ prefix) and drops events sent with it."
          : `GA4 event names start with a letter and hold only letters, digits and "_", 40 characters at most${e.gtag ? "" : " (fine as a GTM trigger if the tag sends another name)"}.`,
        path: entryPath(e.layer, e.index),
      });
  }

  // Universal Analytics enhanced ecommerce.
  const ec = e.params.ecommerce;
  if (isObj(ec)) {
    const ua = UA_KEYS.filter((k) => k in ec);
    for (const k of ["purchase", "refund"])
      if (isObj(ec[k]) && ("actionField" in (ec[k] as object) || "products" in (ec[k] as object))) ua.push(`${k}.actionField`);
    for (const k of ["add", "remove", "detail", "click", "checkout"])
      if (isObj(ec[k]) && "products" in (ec[k] as object) && !ua.includes(k)) ua.push(k);
    if (ua.length)
      add({
        id: "legacy-ua",
        level: "warn",
        label: "Legacy Universal Analytics structure",
        detail: `ecommerce.${ua[0]}${ua.length > 1 ? ` (and ${ua.slice(1).join(", ")})` : ""} is the Universal Analytics enhanced-ecommerce format. GA4 reads ecommerce.transaction_id, value, currency and items[]; Universal Analytics stopped processing data in 2023.`,
        path: `${paramsPath(e)}.ecommerce`,
      });
  }

  if (!ECOMMERCE_EVENTS.has(name)) return out;
  const { params: p, path } = ecommerceOf(e);

  if (TRANSACTION_REQUIRED.has(name) && !present(p.transaction_id))
    add({
      id: "transaction-id",
      level: "bad",
      label: `${name} without transaction_id`,
      detail: `GA4 needs transaction_id on ${name} to tell orders apart and drop duplicates.`,
      path,
    });

  const value = p.value;
  if (present(value)) {
    const bad = numericIssue(e, "value", value, `${path}.value`, "value");
    if (bad) add({ id: "value-type", ...bad, path: `${path}.value` });
    else if (numberOf(value) === 0)
      add({
        id: "value-zero",
        level: "warn",
        label: `${name} with value 0`,
        detail: "A value of 0 reports no revenue: check that the order total is filled in when the event fires.",
        path: `${path}.value`,
      });
    if (!present(p.currency))
      add({
        id: "currency-missing",
        level: "bad",
        label: `${name} has a value but no currency`,
        detail: "GA4 requires currency (an ISO 4217 code such as EUR) whenever value is set, or it drops the revenue.",
        path,
      });
  } else if (name === "purchase")
    add({
      id: "value-missing",
      level: "warn",
      label: "purchase without value",
      detail: "Without value (and currency) the purchase reports no revenue.",
      path,
    });

  if (present(p.currency)) {
    const c = str(p.currency);
    if (!ISO_4217.has(c))
      add({
        id: "currency-code",
        level: ISO_4217.has(c.trim().toUpperCase()) ? "warn" : "bad",
        label: `Currency "${clipText(c, 20)}" is not an ISO 4217 code`,
        detail: ISO_4217.has(c.trim().toUpperCase())
          ? `Write it ${c.trim().toUpperCase()}: ISO 4217 codes are three upper-case letters.`
          : "Use the three-letter ISO 4217 code of the currency (EUR, USD, GBP…), not a symbol or a name.",
        path: `${path}.currency`,
      });
  }

  const items = p.items;
  if (items === undefined || items === null) {
    if (ITEMS_REQUIRED.has(name))
      add({ id: "items-missing", level: "bad", label: `${name} without items[]`, detail: `GA4 needs an items array on ${name}.`, path });
  } else if (!Array.isArray(items))
    add({
      id: "items-type",
      level: "bad",
      label: "items is not an array",
      detail: `items is ${isObj(items) ? "an object" : typeof items} in ${name}: GA4 reads an array of items.`,
      path: `${path}.items`,
    });
  else if (!items.length) {
    if (ITEMS_REQUIRED.has(name))
      add({
        id: "items-empty",
        level: "warn",
        label: `${name} with an empty items[]`,
        detail: "No product is attached to this event.",
        path: `${path}.items`,
      });
  } else {
    const unnamed: number[] = [];
    for (const [i, it] of items.entries()) {
      const ip = `${path}.items[${i}]`;
      if (!isObj(it)) {
        unnamed.push(i);
        continue;
      }
      if (!present(it.item_id) && !present(it.item_name)) unnamed.push(i);
      if (present(it.price)) {
        const bad = numericIssue(e, `items[${i}].price`, it.price, `${ip}.price`, "Item price");
        if (bad) add({ id: "item-price", ...bad, path: `${ip}.price` });
      }
      if (present(it.quantity)) {
        const q = it.quantity;
        if (typeof q !== "number" || !Number.isInteger(q) || q < 1)
          add({
            id: "item-quantity",
            level: "warn",
            label: "Item quantity is not a whole number",
            detail: `items[${i}].quantity is ${JSON.stringify(q)} in ${name}: send a positive integer.`,
            path: `${ip}.quantity`,
          });
      }
    }
    if (unnamed.length)
      add({
        id: "item-id",
        level: "bad",
        label: `${unnamed.length === 1 ? "An item" : `${unnamed.length} items`} without item_id or item_name`,
        detail: `${unnamed
          .slice(0, 5)
          .map((i) => `items[${i}]`)
          .join(", ")}${unnamed.length > 5 ? "…" : ""} in ${name}: GA4 needs item_id or item_name on every item.`,
        path: `${path}.items[${unnamed[0]}]`,
      });
  }
  return out;
}

/** UA- tag ids in gtag config, and ecommerce pushed over a previous one without `{ ecommerce: null }`. */
function setupIssues(events: LayerEvent[]): DataLayerIssue[] {
  const out: DataLayerIssue[] = [];
  const pending = new Map<string, LayerEvent>();
  for (const e of events) {
    if (e.kind === "config" && /^UA-/i.test(e.arg ?? ""))
      out.push({
        id: "ua-config",
        area: "setup",
        level: "warn",
        label: `Universal Analytics tag ${e.arg}`,
        detail: "Universal Analytics stopped processing data in 2023: this config sends nothing. Remove it or replace it with a GA4 G- id.",
        path: entryPath(e.layer, e.index),
        seq: e.seq,
      });
    if (e.gtag) continue;
    if ("ecommerce" in e.params) {
      if (e.params.ecommerce === null) pending.delete(e.layer);
      else if (isObj(e.params.ecommerce)) {
        const prev = pending.get(e.layer);
        if (prev)
          out.push({
            id: "ecommerce-not-cleared",
            area: "ga4",
            level: "warn",
            label: "ecommerce not cleared before a new push",
            detail: `GTM merges this ecommerce object into the one of ${prev.name} (${entryPath(prev.layer, prev.index)}), so stale items or values can leak in. Push { ecommerce: null } first.`,
            path: entryPath(e.layer, e.index),
            seq: e.seq,
          });
        pending.set(e.layer, e);
      }
    }
  }
  return out;
}

function duplicateIssues(events: LayerEvent[]): DataLayerIssue[] {
  const out: DataLayerIssue[] = [];
  const named = events.filter((e) => e.kind === "event" && !isGtmInternal(e.name));
  const transactions = new Map<string, LayerEvent[]>();
  for (const e of named)
    if (e.name === "purchase") {
      const id = str(ecommerceOf(e).params.transaction_id);
      if (id) transactions.set(id, [...(transactions.get(id) ?? []), e]);
    }
  const coveredSeq = new Set<number>();
  for (const [id, list] of transactions)
    if (list.length > 1) {
      for (const e of list) coveredSeq.add(e.seq);
      out.push({
        id: "duplicate-transaction",
        area: "duplicates",
        level: "bad",
        label: `purchase ${clipText(id, 30)} sent ${list.length} times`,
        detail: `The same transaction_id at ${list.map((e) => entryPath(e.layer, e.index)).join(", ")}: the order is double-counted wherever it is not deduplicated (Ads conversions, other tags).`,
        path: entryPath(list[1]!.layer, list[1]!.index),
        seq: list[1]!.seq,
      });
    }
  const groups = new Map<string, LayerEvent[]>();
  for (const e of named) {
    if (coveredSeq.has(e.seq)) continue;
    const key = `${e.name}\u0000${stableJson(e.params)}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const list of groups.values())
    if (list.length > 1)
      out.push({
        id: "duplicate-event",
        area: "duplicates",
        level: "warn",
        label: `${clipText(list[0]!.name, 40)} fired ${list.length} times`,
        detail: `Identical parameters at ${list
          .slice(0, 6)
          .map((e) => entryPath(e.layer, e.index))
          .join(", ")}${list.length > 6 ? "…" : ""}: a tag or a listener may run twice.`,
        path: entryPath(list[1]!.layer, list[1]!.index),
        seq: list[1]!.seq,
      });
  return out;
}

/* Consent Mode */

export const CONSENT_TYPES = [
  "ad_storage",
  "analytics_storage",
  "ad_user_data",
  "ad_personalization",
  "functionality_storage",
  "personalization_storage",
  "security_storage",
];
const CONSENT_V2 = ["ad_user_data", "ad_personalization"];

export interface ConsentStep {
  seq: number;
  layer: string;
  index: number;
  /** "default", "update", or whatever the page passed. */
  command: string;
  /** Consent type → value as given (granted / denied, or something else). */
  states: Record<string, string>;
  waitForUpdate?: number;
  region?: string[];
}

export function consentSteps(events: LayerEvent[]): ConsentStep[] {
  return events
    .filter((e) => e.kind === "consent")
    .map((e) => {
      const states: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.params)) if (k !== "wait_for_update" && k !== "region") states[k] = str(v);
      const w = e.params.wait_for_update;
      const r = e.params.region;
      return {
        seq: e.seq,
        layer: e.layer,
        index: e.index,
        command: e.arg ?? "",
        states,
        waitForUpdate: typeof w === "number" ? w : (numberOf(w) ?? undefined),
        region: Array.isArray(r) ? r.map(str) : typeof r === "string" ? [r] : undefined,
      };
    });
}

function consentIssues(events: LayerEvent[], steps: ConsentStep[], hasTags: boolean): DataLayerIssue[] {
  const out: DataLayerIssue[] = [];
  const add = (i: Omit<DataLayerIssue, "area">) => out.push({ area: "consent", ...i });
  if (!steps.length) {
    if (hasTags)
      add({
        id: "consent-none",
        level: "info",
        label: "No Consent Mode command",
        detail:
          "No gtag('consent', …) in the dataLayer. Consent Mode v2 is required to use Google Ads audiences and measurement for visitors in the EEA; a CMP may also set it outside the dataLayer.",
      });
    return out;
  }
  const defaults = steps.filter((s) => s.command === "default");
  const updates = steps.filter((s) => s.command === "update");
  const firstDefault = defaults[0];
  for (const s of steps)
    if (s.command !== "default" && s.command !== "update")
      add({
        id: "consent-command",
        level: "bad",
        label: `Unknown consent command "${clipText(s.command, 20)}"`,
        detail: "gtag('consent', …) takes 'default' or 'update'.",
        path: entryPath(s.layer, s.index),
        seq: s.seq,
      });
  if (!firstDefault && updates.length)
    add({
      id: "consent-no-default",
      level: "bad",
      label: "Consent update without default",
      detail:
        "The page sends gtag('consent', 'update') but never a default: until the update, tags run as if everything were granted. Set the default (usually denied) before any tag loads.",
      path: entryPath(updates[0]!.layer, updates[0]!.index),
      seq: updates[0]!.seq,
    });
  if (firstDefault) {
    const early = updates.find((u) => u.seq < firstDefault.seq);
    if (early)
      add({
        id: "consent-update-first",
        level: "bad",
        label: "Consent update before the default",
        detail: `The update at ${entryPath(early.layer, early.index)} comes before the default at ${entryPath(firstDefault.layer, firstDefault.index)}: the default then overwrites the visitor's choice.`,
        path: entryPath(early.layer, early.index),
        seq: early.seq,
      });
    const firstTag = events.find(
      (e) => (e.kind === "config" || (e.kind === "event" && !isGtmInternal(e.name))) && e.seq < firstDefault.seq,
    );
    if (firstTag)
      add({
        id: "consent-default-late",
        level: "warn",
        label: "Consent default set after tags",
        detail: `${firstTag.name} (${entryPath(firstTag.layer, firstTag.index)}) comes before the default (${entryPath(firstDefault.layer, firstDefault.index)}): hits sent in between ignore consent. Put the default first.`,
        path: entryPath(firstDefault.layer, firstDefault.index),
        seq: firstDefault.seq,
      });
    const v2Missing = CONSENT_V2.filter((k) => !defaults.some((d) => k in d.states));
    if (v2Missing.length)
      add({
        id: "consent-v2",
        level: "warn",
        label: `Consent Mode v2: ${v2Missing.join(" and ")} missing`,
        detail: `The default does not set ${v2Missing.join(" or ")}. Since March 2024 Google Ads needs both for audiences and personalized ads in the EEA.`,
        path: entryPath(firstDefault.layer, firstDefault.index),
        seq: firstDefault.seq,
      });
    const baseMissing = ["ad_storage", "analytics_storage"].filter((k) => !defaults.some((d) => k in d.states));
    if (baseMissing.length)
      add({
        id: "consent-base",
        level: "info",
        label: `Default leaves ${baseMissing.join(" and ")} out`,
        detail: "A consent type the default leaves out counts as granted.",
        path: entryPath(firstDefault.layer, firstDefault.index),
        seq: firstDefault.seq,
      });
  }
  for (const s of steps) {
    for (const [k, v] of Object.entries(s.states)) {
      if (v !== "granted" && v !== "denied")
        add({
          id: "consent-value",
          level: "bad",
          label: `Invalid consent value for ${clipText(k, 30)}`,
          detail: `${k} is "${clipText(v, 30)}" in the ${s.command}: Consent Mode only takes "granted" or "denied".`,
          path: `${entryPath(s.layer, s.index)}[2].${k}`,
          seq: s.seq,
        });
      else if (!CONSENT_TYPES.includes(k))
        add({
          id: "consent-type",
          level: "info",
          label: `Unknown consent type ${clipText(k, 30)}`,
          detail: `Google tags ignore ${k}: the types are ${CONSENT_TYPES.join(", ")}. A custom type can still drive your own GTM triggers.`,
          path: `${entryPath(s.layer, s.index)}[2].${k}`,
          seq: s.seq,
        });
    }
    if (s.command === "default" && s.waitForUpdate !== undefined)
      add({
        id: "consent-wait",
        level: "info",
        label: `Default waits ${s.waitForUpdate} ms for an update`,
        detail: "wait_for_update holds tags this long for the CMP's update before they fire with the default.",
        path: `${entryPath(s.layer, s.index)}[2].wait_for_update`,
        seq: s.seq,
      });
  }
  return out;
}

/* PII */

export type PiiKind = "email" | "phone" | "iban" | "card";

export const PII_LABEL: Record<PiiKind, string> = { email: "E-mail address", phone: "Phone number", iban: "IBAN", card: "Card number" };
const GOOGLE_PII =
  "Google's terms forbid sending personal data to Analytics and Ads; hash it (SHA-256) or leave it out. Values are masked in devkit.";
const PII_PLURAL: Record<PiiKind, string> = { email: "E-mail addresses", phone: "Phone numbers", iban: "IBANs", card: "Card numbers" };

export interface PiiFinding {
  kind: PiiKind;
  /** Where the value is, e.g. `dataLayer[4].user.email`: never the value itself. */
  path: string;
  layer: string;
  index: number;
}

interface PiiMatch {
  kind: PiiKind;
  start: number;
  end: number;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.([A-Z]{2,})/gi;
const FILE_EXT = /^(png|jpe?g|gif|svg|webp|avif|ico|js|mjs|css|map|json|html?)$/i;
const PHONE_INTL = /(?<![\w+])\+[1-9][\d\s().-]{7,18}\d(?![\w])/g;
const PHONE_FR = /(?<![\d\w])0[1-9](?:[ .-]\d{2}){4}(?![\d\w])/g;
const PHONE_US = /(?<![\d\w])\(\d{3}\)\s?\d{3}[-.\s]\d{4}(?![\d\w])/g;
const IBAN_CANDIDATE = /(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}/g;
const CARD_CANDIDATE = /(?<![\d\w])\d(?:[ -]?\d){12,18}(?![\d\w])/g;
const PHONE_KEY = /phone|mobile|msisdn|whatsapp|(^|[_\-.])(tel|fax|gsm)($|[_\-.])|^tel/i;
const CARD_KEY = /card|credit|(^|[_\-.])(cc|pan)($|[_\-.])/i;
const ID_KEY = /(^|[_\-.])(id|ids|sku|ean|gtin|upc|isbn|ts)$|Id$|transaction|order|timestamp|time|date|number$/i;

/** Country → IBAN length (ISO 13616 registry). */
const IBAN_LENGTH: Record<string, number> = Object.fromEntries(
  (
    "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DK18 DO28 EE20 EG29 ES24 FI18 " +
    "FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 " +
    "LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 SC31 SE24 SI19 " +
    "SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20"
  )
    .split(" ")
    .map((c) => [c.slice(0, 2), Number(c.slice(2))]),
);

/** ISO 13616 check: the rearranged IBAN, letters as numbers, mod 97 is 1. */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s) || IBAN_LENGTH[s.slice(0, 2)] !== s.length) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Issuer prefix and length of the major card networks: digits that pass Luhn but match no network are not cards. */
function cardNetwork(d: string): boolean {
  const n = d.length;
  if (/^4/.test(d)) return n === 13 || n === 16 || n === 19;
  if (/^(5[1-5]|2[2-7])/.test(d)) return n === 16;
  if (/^3[47]/.test(d)) return n === 15;
  if (/^3(0[0-5]|[68])/.test(d)) return n === 14;
  if (/^(6011|65|64[4-9]|35|62)/.test(d)) return n >= 16 && n <= 19;
  return false;
}

/** PII in one string value; `key` is the property name it sits under, which tells numbers apart (phone vs order id). */
function piiIn(s: string, key: string): PiiMatch[] {
  const found: PiiMatch[] = [];
  const free = (start: number, end: number) => !found.some((m) => start < m.end && end > m.start);
  const push = (kind: PiiKind, start: number, end: number) => {
    if (free(start, end)) found.push({ kind, start, end });
  };
  for (const m of s.matchAll(EMAIL)) if (!FILE_EXT.test(m[1] ?? "")) push("email", m.index, m.index + m[0].length);
  for (const m of s.matchAll(IBAN_CANDIDATE)) {
    const want = IBAN_LENGTH[m[0].slice(0, 2)];
    if (!want) continue;
    // Take characters (spaces skipped) up to the country's IBAN length.
    let count = 0;
    let end = m.index;
    for (const ch of m[0]) {
      end++;
      if (ch !== " ") count++;
      if (count === want) break;
    }
    if (count === want && ibanValid(s.slice(m.index, end))) push("iban", m.index, end);
  }
  const cardKey = CARD_KEY.test(key);
  const idKey = !cardKey && ID_KEY.test(key);
  for (const m of s.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, "");
    const separated = digits.length !== m[0].length;
    if ((cardKey || separated || !idKey) && luhnValid(digits) && cardNetwork(digits)) push("card", m.index, m.index + m[0].length);
  }
  if (PHONE_KEY.test(key)) {
    const digits = s.replace(/\D/g, "");
    if (/^[+\d\s().\-/]+$/.test(s.trim()) && digits.length >= 9 && digits.length <= 15) push("phone", 0, s.length);
  }
  for (const re of [PHONE_INTL, PHONE_FR, PHONE_US])
    for (const m of s.matchAll(re)) {
      const digits = m[0].replace(/\D/g, "").length;
      if (digits >= 9 && digits <= 15) push("phone", m.index, m.index + m[0].length);
    }
  return found.sort((a, b) => a.start - b.start);
}

/** PII in a number value: only under a key that names a phone or a card (an order id is a number too). */
function piiInNumber(n: number, key: string): PiiKind | null {
  if (!Number.isInteger(n) || n < 0) return null;
  const d = String(n);
  if (CARD_KEY.test(key) && luhnValid(d) && cardNetwork(d)) return "card";
  if (PHONE_KEY.test(key) && d.length >= 9 && d.length <= 15) return "phone";
  return null;
}

function maskOne(kind: PiiKind, s: string): string {
  switch (kind) {
    case "email": {
      const at = s.indexOf("@");
      const tld = s.slice(s.lastIndexOf(".") + 1);
      return `${s.slice(0, Math.min(1, at))}•••@•••.${tld}`;
    }
    case "phone": {
      const digits = s.replace(/\D/g, "");
      return `${s.trim().startsWith("+") ? "+" : ""}•••${digits.slice(-2)}`;
    }
    case "iban": {
      const c = s.replace(/\s+/g, "");
      return `${c.slice(0, 2)}••••${c.slice(-2)}`;
    }
    case "card":
      return `••••${s.replace(/\D/g, "").slice(-4)}`;
  }
}

function maskString(s: string, key: string): string {
  const found = piiIn(s, key);
  if (!found.length) return s;
  let out = "";
  let at = 0;
  for (const m of found) {
    out += s.slice(at, m.start) + maskOne(m.kind, s.slice(m.start, m.end));
    at = m.end;
  }
  return out + s.slice(at);
}

/** A copy of `value` with every e-mail, phone number, IBAN and card number masked (`j•••@•••.com`, `••••1111`). */
export function maskPii<T>(value: T, key = ""): T {
  if (typeof value === "string") return maskString(value, key) as T;
  if (typeof value === "number") {
    const kind = piiInNumber(value, key);
    return (kind ? maskOne(kind, String(value)) : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => maskPii(v, key)) as T;
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskPii(v, k);
    return out as T;
  }
  return value;
}

/** Every layer with its entries masked. */
export const maskLayers = (layers: RawDataLayer[]): RawDataLayer[] =>
  layers.map((l) => ({ ...l, entries: l.entries.map((e) => ({ ...e, value: maskPii(e.value) })) }));

/** Where PII sits in the layers, by path. Never returns a value. */
export function findPii(layers: RawDataLayer[]): PiiFinding[] {
  const out: PiiFinding[] = [];
  for (const l of layers)
    for (const e of l.entries) {
      const walk = (v: unknown, path: string, key: string, depth: number) => {
        if (depth > 12) return;
        if (typeof v === "string") {
          for (const kind of new Set(piiIn(v, key).map((m) => m.kind))) out.push({ kind, path, layer: l.name, index: e.index });
        } else if (typeof v === "number") {
          const kind = piiInNumber(v, key);
          if (kind) out.push({ kind, path, layer: l.name, index: e.index });
        } else if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(x, pathJoin(path, i), key, depth + 1);
        else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, pathJoin(path, k, e.gtag && depth === 0), k, depth + 1);
      };
      walk(e.value, entryPath(l.name, e.index), "", 0);
    }
  return out;
}

function piiIssues(pii: PiiFinding[]): DataLayerIssue[] {
  const byKind = new Map<PiiKind, PiiFinding[]>();
  for (const f of pii) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f]);
  return [...byKind].map(([kind, list]) => ({
    id: `pii-${kind}`,
    area: "pii" as const,
    level: "bad" as const,
    label: `${list.length > 1 ? `${PII_PLURAL[kind]} (${list.length})` : PII_LABEL[kind]} in the dataLayer`,
    detail: `${
      list.length > 1
        ? `Also at ${list
            .slice(1, 6)
            .map((f) => f.path)
            .join(", ")}${list.length > 6 ? "…" : ""}. `
        : ""
    }${GOOGLE_PII}`,
    path: list[0]!.path,
  }));
}

/* JSON-LD cross-check */

interface ProductMarkup {
  name: string;
  sku: string;
  prices: number[];
  range?: [number, number];
  currencies: string[];
}

export function productsFromJsonLd(jsonLd: { raw: string; index: number }[]): ProductMarkup[] {
  if (!jsonLd.length) return [];
  const out: ProductMarkup[] = [];
  for (const b of analyzeJsonLd(jsonLd).blocks)
    for (const n of b.nodes) {
      if (!n.types.includes("Product")) continue;
      const d = n.data;
      const offers = (Array.isArray(d.offers) ? d.offers : d.offers ? [d.offers] : []).filter(isObj);
      const prices: number[] = [];
      const currencies: string[] = [];
      let range: [number, number] | undefined;
      for (const o of offers) {
        const p = numberOf(o.price);
        if (p !== null) prices.push(p);
        const lo = numberOf(o.lowPrice);
        const hi = numberOf(o.highPrice);
        if (lo !== null) range = [lo, hi ?? lo];
        if (typeof o.priceCurrency === "string") currencies.push(o.priceCurrency);
      }
      out.push({ name: str(d.name).trim(), sku: str(d.sku ?? d.productID ?? d.mpn).trim(), prices, range, currencies });
    }
  return out;
}

function jsonLdIssues(events: LayerEvent[], products: ProductMarkup[]): DataLayerIssue[] {
  if (!products.length) return [];
  const out: DataLayerIssue[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== "event" || !ECOMMERCE_EVENTS.has(e.name)) continue;
    const { params, path } = ecommerceOf(e);
    if (!Array.isArray(params.items)) continue;
    const items = params.items.filter(isObj);
    for (const [i, it] of items.entries()) {
      const id = str(it.item_id).trim();
      const nm = str(it.item_name).trim();
      let product = products.find((p) => p.sku && p.sku === id);
      const bySku = Boolean(product);
      if (!product) product = products.find((p) => p.name && p.name === nm);
      // A product page with one Product and a view_item of one item: they are the same product.
      if (!product && e.name === "view_item" && items.length === 1 && products.length === 1) product = products[0];
      if (!product) continue;
      const ip = `${path}.items[${i}]`;
      const add = (field: string, label: string, detail: string, at: string) => {
        const key = `${e.name}|${product!.sku}|${product!.name}|${field}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ id: `jsonld-${field}`, area: "jsonld", level: "warn", label, detail, path: at, seq: e.seq });
      };
      if (!bySku && product.sku && id && id !== product.sku)
        add(
          "sku",
          "SKU differs from the Product markup",
          `items[${i}].item_id is "${clipText(id, 40)}" in ${e.name}, the JSON-LD Product "${clipText(product.name, 40)}" has sku "${clipText(product.sku, 40)}".`,
          `${ip}.item_id`,
        );
      const price = numberOf(it.price);
      if (price !== null && (product.prices.length || product.range)) {
        const close = (x: number) => Math.abs(x - price) < 0.005;
        const inRange = product.range ? price >= product.range[0] - 0.005 && price <= product.range[1] + 0.005 : false;
        if (!product.prices.some(close) && !inRange)
          add(
            "price",
            "Price differs from the Product markup",
            `items[${i}].price is ${price} in ${e.name}, the JSON-LD offer says ${product.prices.length ? product.prices.join(" / ") : `${product.range![0]}–${product.range![1]}`}.`,
            `${ip}.price`,
          );
      }
      const currency = str(it.currency || params.currency).trim();
      if (currency && product.currencies.length && !product.currencies.includes(currency))
        add(
          "currency",
          "Currency differs from the Product markup",
          `${e.name} uses ${clipText(currency, 10)}, the JSON-LD offer's priceCurrency is ${product.currencies.join(" / ")}.`,
          it.currency ? `${ip}.currency` : `${path}.currency`,
        );
    }
  }
  return out;
}

/* Containers */

export interface Container {
  id: string;
  kind: string;
  /** google_tag_manager, script, config. */
  sources: string[];
  layer?: string;
}

const CONTAINER_KIND: Record<string, string> = {
  GTM: "Tag Manager container",
  G: "GA4 measurement ID",
  AW: "Google Ads",
  DC: "Floodlight",
  GT: "Google tag",
  UA: "Universal Analytics (retired)",
  MC: "Merchant Center",
  HA: "Google Analytics 360",
};
const TAG_ID = /^(GTM|G|AW|DC|GT|UA|HA|MC)-[A-Z0-9-]+$/i;

export function containersOf(raw: RawContainer[], events: LayerEvent[]): Container[] {
  const out = new Map<string, Container>();
  const add = (id: string, source: string, layer?: string) => {
    const key = id.toUpperCase();
    const c = out.get(key) ?? { id: key, kind: CONTAINER_KIND[key.split("-")[0]!] ?? "Google tag", sources: [], layer };
    if (!c.sources.includes(source)) c.sources.push(source);
    c.layer ??= layer;
    out.set(key, c);
  };
  for (const c of raw) add(c.id, c.source, c.layer);
  for (const e of events) if (e.kind === "config" && e.arg && TAG_ID.test(e.arg)) add(e.arg, "config", e.layer);
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/* Analysis */

export interface DataLayerCounts {
  /** Problems and warnings (notes left out). */
  issues: number;
  problems: number;
  warnings: number;
  events: number;
  unique: number;
  /** Entries across every dataLayer. */
  layers: number;
  consent: number;
  containers: number;
  pii: number;
}

export interface DataLayerAnalysis {
  url: string;
  /** The layers with PII masked: what devkit shows, copies and stores. */
  layers: RawDataLayer[];
  events: LayerEvent[];
  containers: Container[];
  consent: ConsentStep[];
  pii: PiiFinding[];
  issues: DataLayerIssue[];
  counts: DataLayerCounts;
  truncated: boolean;
}

const RANK: Record<Level, number> = { bad: 0, warn: 1, info: 2, good: 3 };

/** Issues of masked layers: GA4, duplicates, Consent Mode, JSON-LD (PII is found before masking). */
export function dataLayerIssues(events: LayerEvent[], products: ProductMarkup[], pii: PiiFinding[], hasTags: boolean): DataLayerIssue[] {
  const steps = consentSteps(events);
  const all = [
    ...piiIssues(pii),
    ...events.flatMap((e) => (e.kind === "event" ? ga4Issues(e) : [])),
    ...setupIssues(events),
    ...duplicateIssues(events),
    ...consentIssues(events, steps, hasTags),
    ...jsonLdIssues(events, products),
  ];
  return all
    .map((i, n) => ({ i, n }))
    .sort((a, b) => RANK[a.i.level] - RANK[b.i.level] || (a.i.seq ?? -1) - (b.i.seq ?? -1) || a.n - b.n)
    .map((x) => x.i);
}

export function analyzeDataLayer(snap: DataLayerSnapshot): DataLayerAnalysis {
  const pii = findPii(snap.layers);
  const layers = maskLayers(snap.layers);
  const events = normalizeEvents(layers);
  const containers = containersOf(snap.containers, events);
  const consent = consentSteps(events);
  const products = productsFromJsonLd(snap.jsonLd);
  const issues = dataLayerIssues(events, products, pii, containers.length > 0 || events.some((e) => e.gtag));
  const named = events.filter((e) => e.kind === "event");
  const problems = issues.filter((i) => i.level === "bad").length;
  const warnings = issues.filter((i) => i.level === "warn").length;
  return {
    url: snap.url,
    layers,
    events,
    containers,
    consent,
    pii,
    issues,
    truncated: snap.truncated,
    counts: {
      issues: problems + warnings,
      problems,
      warnings,
      events: named.length,
      unique: new Set(named.map((e) => e.name)).size,
      layers: layers.reduce((s, l) => s + l.entries.length, 0),
      consent: consent.length,
      containers: containers.length,
      pii: pii.length,
    },
  };
}

/** Issues of one event, by `seq`. */
export function issuesByEvent(issues: DataLayerIssue[]): Map<number, DataLayerIssue[]> {
  const out = new Map<number, DataLayerIssue[]>();
  for (const i of issues) if (i.seq !== undefined) out.set(i.seq, [...(out.get(i.seq) ?? []), i]);
  return out;
}

/* Snapshots */

export interface DataLayerSavedSnapshot {
  id: string;
  /** Epoch ms. */
  at: number;
  url: string;
  title: string;
  /** Masked layers. */
  layers: RawDataLayer[];
  containers: RawContainer[];
  events: number;
  issues: number;
  /** Entries left out to keep the snapshot small. */
  truncated: boolean;
}

/** Snapshots kept, all sites together (newest first). */
export const SNAPSHOT_LIMIT = 50;
/**
 * Largest snapshot kept, in characters of JSON: 50 of them stay under browser.storage.local's 10 MB quota.
 */
export const SNAPSHOT_MAX_SIZE = 150_000;
/** browser.storage.local key of the snapshot list. */
export const SNAPSHOTS_KEY = "datalayerSnapshots";

/** A snapshot of the current read, masked, trimmed under SNAPSHOT_MAX_SIZE. */
export function makeSnapshot(
  snap: Pick<DataLayerSnapshot, "url" | "title" | "containers" | "truncated">,
  analysis: DataLayerAnalysis,
  now = Date.now(),
): DataLayerSavedSnapshot {
  let truncated = snap.truncated;
  let budget = SNAPSHOT_MAX_SIZE;
  const layers = analysis.layers.map((l) => {
    const entries: RawLayerEntry[] = [];
    for (const e of l.entries) {
      const size = JSON.stringify(e).length;
      if (size > budget) {
        truncated = true;
        break;
      }
      budget -= size;
      entries.push(e);
    }
    return { ...l, entries };
  });
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: now,
    url: snap.url,
    title: snap.title,
    layers,
    containers: snap.containers,
    events: analysis.counts.events,
    issues: analysis.counts.issues,
    truncated,
  };
}

/** Newest first, at most SNAPSHOT_LIMIT. */
export const addSnapshot = (list: DataLayerSavedSnapshot[], s: DataLayerSavedSnapshot) => [s, ...list].slice(0, SNAPSHOT_LIMIT);

export interface EventChange {
  before: LayerEvent;
  after: LayerEvent;
  /** Leaf paths whose value differs, relative to the parameters. */
  changes: { path: string; before?: string; after?: string }[];
}

export interface SnapshotDiff {
  added: LayerEvent[];
  removed: LayerEvent[];
  /** Events of `b` identical to another event of `b`, beyond what `a` had. */
  duplicated: LayerEvent[];
  changed: EventChange[];
  unchanged: number;
}

function leaves(v: unknown, path: string, out: Map<string, string>) {
  if (Array.isArray(v)) {
    if (!v.length) out.set(path, "[]");
    for (const [i, x] of v.entries()) leaves(x, `${path}[${i}]`, out);
  } else if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => !VOLATILE(k));
    if (!keys.length) out.set(path, "{}");
    for (const k of keys) leaves(v[k], path ? pathJoin(path, k) : k, out);
  } else out.set(path, JSON.stringify(v) ?? "undefined");
}

function paramChanges(a: LayerEvent, b: LayerEvent): EventChange["changes"] {
  const la = new Map<string, string>();
  const lb = new Map<string, string>();
  leaves(a.params, "", la);
  leaves(b.params, "", lb);
  const out: EventChange["changes"] = [];
  for (const k of new Set([...la.keys(), ...lb.keys()]))
    if (la.get(k) !== lb.get(k)) out.push({ path: k || "(value)", before: la.get(k), after: lb.get(k) });
  return out;
}

/** Ids that say which event this is, beyond its name: transaction, items, consent command, tag id. */
function keyParams(e: LayerEvent): string {
  const { params } = ecommerceOf(e);
  const items = Array.isArray(params.items) ? params.items.map((it) => (isObj(it) ? str(it.item_id || it.item_name) : "")).join(",") : "";
  return [e.kind, e.arg ?? "", str(params.transaction_id), items].join("|");
}

/**
 * What changed from snapshot `a` to `b`: events are paired by position and name first, then by name and key
 * parameters (transaction_id, item ids); paired events whose parameters differ are "changed".
 */
export function compareSnapshots(a: LayerEvent[], b: LayerEvent[]): SnapshotDiff {
  const usedA = new Set<number>();
  const pairOf = new Map<number, LayerEvent>();
  const byPos = new Map<string, LayerEvent>();
  for (const e of a) byPos.set(`${e.layer}|${e.index}|${e.name}`, e);
  for (const e of b) {
    const m = byPos.get(`${e.layer}|${e.index}|${e.name}`);
    if (m && !usedA.has(m.seq)) {
      usedA.add(m.seq);
      pairOf.set(e.seq, m);
    }
  }
  for (const e of b) {
    if (pairOf.has(e.seq)) continue;
    const k = keyParams(e);
    const m = a.find((x) => !usedA.has(x.seq) && x.name === e.name && keyParams(x) === k);
    if (m) {
      usedA.add(m.seq);
      pairOf.set(e.seq, m);
    }
  }
  const sig = (e: LayerEvent) => `${e.name}\u0000${stableJson(e.params)}`;
  const seen = new Set<string>();
  for (const e of b) if (pairOf.has(e.seq)) seen.add(sig(e));
  const diff: SnapshotDiff = { added: [], removed: [], duplicated: [], changed: [], unchanged: 0 };
  for (const e of b) {
    const m = pairOf.get(e.seq);
    if (m) {
      if (stableJson(m.params) === stableJson(e.params)) diff.unchanged++;
      else diff.changed.push({ before: m, after: e, changes: paramChanges(m, e).slice(0, 30) });
      continue;
    }
    const s = sig(e);
    if (seen.has(s) && e.kind === "event") diff.duplicated.push(e);
    else diff.added.push(e);
    seen.add(s);
  }
  diff.removed = a.filter((e) => !usedA.has(e.seq));
  return diff;
}

/* Report */

const LEVEL_TAG: Record<Level, string> = { bad: "problem", warn: "warning", info: "note", good: "ok" };

/** Plain-text report for "Copy report": counts, containers, issues, consent and events. PII is masked or left out. */
export function dataLayerReport(a: DataLayerAnalysis): string {
  const c = a.counts;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const lines = [
    `dataLayer report — ${a.url}`,
    `Issues: ${c.issues} (${n(c.problems, "problem")}, ${n(c.warnings, "warning")}) · Events: ${c.events} (${c.unique} unique) · Layers: ${c.layers} entries · Consent: ${c.consent} · Containers: ${c.containers}`,
  ];
  if (a.truncated) lines.push("The dataLayer was too large: part of it was left out.");
  lines.push("", "Containers & layers");
  for (const k of a.containers) lines.push(`- ${k.id}: ${k.kind}${k.layer ? `, reads ${k.layer}` : ""} (${k.sources.join(", ")})`);
  for (const l of a.layers) lines.push(`- ${l.name}: ${l.length} entries`);
  if (!a.containers.length && !a.layers.length) lines.push("- none");
  lines.push("", "Issues");
  if (!a.issues.length) lines.push("- none");
  for (const i of a.issues) lines.push(`- [${LEVEL_TAG[i.level]}] ${i.label}${i.path ? ` — ${i.path}` : ""}: ${i.detail}`);
  if (a.consent.length) {
    lines.push("", "Consent Mode");
    for (const s of a.consent)
      lines.push(
        `- ${entryPath(s.layer, s.index)} ${s.command}: ${Object.entries(s.states)
          .map(([k, v]) => `${k}=${v}`)
          .join(
            ", ",
          )}${s.waitForUpdate !== undefined ? `, wait_for_update=${s.waitForUpdate}` : ""}${s.region ? `, region=${s.region.join("/")}` : ""}`,
      );
  }
  lines.push("", `Events (${a.events.length} entries)`);
  for (const e of a.events.slice(0, 200)) {
    const preview = paramsPreview(e);
    lines.push(`- ${entryPath(e.layer, e.index)} ${e.name}${e.gtag ? " (gtag)" : ""}${preview ? ` — ${preview}` : ""}`);
  }
  if (a.events.length > 200) lines.push(`… and ${a.events.length - 200} more`);
  lines.push("", "Personal data (e-mails, phone numbers, IBANs, card numbers) is masked; PII findings give paths only.");
  return lines.join("\n");
}
