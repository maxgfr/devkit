// Consent check: what a site sets and loads before the visitor answers its consent banner. Classifies cookies,
// storage keys and requests with a built-in table of well-known trackers (a heuristic: names and domains only),
// recognizes the consent banner (CMP), reads the Consent Mode state from the dataLayer, and turns all that into
// GDPR / ePrivacy findings. Pure: the panel captures, this module judges. Cookie and storage values never get here.
import { CONSENT_TYPES, type ConsentStep } from "./datalayer";
import type { Level } from "./headers";
import type { ConsentGlobals, ConsentPageSnapshot, TcfState } from "./page/consent";
import { siteOf } from "./security/third-party";

export type TrackerCategory = "analytics" | "advertising" | "functional" | "unknown";

export const CATEGORY_LABEL: Record<TrackerCategory, string> = {
  analytics: "Analytics",
  advertising: "Advertising",
  functional: "Functional",
  unknown: "Unknown",
};

export interface Classification {
  category: TrackerCategory;
  /** Who it belongs to, e.g. "Google Analytics"; empty when unknown. */
  vendor: string;
  note?: string;
  /** A tag loader (Google Tag Manager, gtag.js): loading it sends nothing by itself. */
  loader?: boolean;
  /** Recognized by the URL's shape rather than its host: maybe a first-party proxy (server-side tagging). */
  byShape?: boolean;
  /** Belongs to the consent banner itself. */
  cmp?: boolean;
}

const UNKNOWN: Classification = { category: "unknown", vendor: "" };

/* Names of cookies and storage keys */

interface NameRule {
  test: RegExp;
  vendor: string;
  category: TrackerCategory;
  /** Only when the cookie's domain matches: short names ("fr", "IDE") are too common elsewhere. */
  domain?: RegExp;
  note?: string;
  cmp?: boolean;
}

const CONSENT_NOTE = "Stores the visitor's consent choice: strictly necessary.";
const NECESSARY_NOTE = "Session, security or load balancing: usually strictly necessary.";

const NAME_RULES: NameRule[] = [
  // The consent banners' own records.
  { test: /^(OptanonConsent|OptanonAlertBoxClosed)$/, vendor: "OneTrust", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^CookieConsent(BulkSetting.*)?$/, vendor: "Cookiebot", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^didomi_token$/, vendor: "Didomi", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^(euconsent-v2|euconsent)$/, vendor: "IAB TCF consent string", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^addtl_consent$/, vendor: "Google Additional Consent", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^(__gpp|__gpp_sid|usprivacy)$/, vendor: "IAB privacy string", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^axeptio_/, vendor: "Axeptio", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^cookieyes-consent$/, vendor: "CookieYes", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^cmplz_/, vendor: "Complianz", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^_iub_cs-/, vendor: "iubenda", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^(FCCDCF|FCNEC)$/, vendor: "Google Funding Choices", category: "functional", note: CONSENT_NOTE, cmp: true },
  {
    test: /^(notice_preferences|notice_gdpr_prefs|notice_behavior|TAconsentID|cmapi_cookie_privacy|cmapi_gtm_bl)$/,
    vendor: "TrustArc",
    category: "functional",
    note: CONSENT_NOTE,
    cmp: true,
  },
  { test: /^osano_consentmanager/, vendor: "Osano", category: "functional", note: CONSENT_NOTE, cmp: true },
  {
    test: /^(uc_settings|uc_user_interaction|uc_gcm|ucData)$/,
    vendor: "Usercentrics",
    category: "functional",
    note: CONSENT_NOTE,
    cmp: true,
  },
  { test: /^tarteaucitron$/, vendor: "tarteaucitron", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^borlabs-cookie$/, vendor: "Borlabs Cookie", category: "functional", note: CONSENT_NOTE, cmp: true },
  { test: /^(SOCS|CONSENT)$/, vendor: "Google", category: "functional", note: CONSENT_NOTE, domain: /(^|\.)(google|youtube)\.[a-z.]+$/ },

  // Google Analytics.
  { test: /^_ga(_[A-Z0-9]+)?$/, vendor: "Google Analytics", category: "analytics" },
  { test: /^(_gid|_gat(_.*)?|_dc_gtm_.*)$/, vendor: "Google Analytics", category: "analytics" },
  { test: /^__utm[abcztv]$/, vendor: "Google Analytics (Universal)", category: "analytics" },
  // Google Ads, DoubleClick and Google's own domains.
  { test: /^(_gcl_.*|_gac_.*)$/, vendor: "Google Ads", category: "advertising" },
  { test: /^(__gads|__gpi|__eoi|__gsas)$/, vendor: "Google AdSense / Ad Manager", category: "advertising" },
  {
    test: /^(IDE|DSID|test_cookie|FLC|RUL|AID|TAID|FPAU|FPGCLAW|FPGCLDC)$/,
    vendor: "Google Ads (DoubleClick)",
    category: "advertising",
    domain: /(^|\.)doubleclick\.net$/,
  },
  { test: /^(NID|ANID|1P_JAR|__Secure-ENID)$/, vendor: "Google", category: "advertising", domain: /(^|\.)google\.[a-z.]+$/ },
  {
    test: /^(AEC|__Secure-.*PSID.*|SID|HSID|SSID|APISID|SAPISID)$/,
    vendor: "Google",
    category: "functional",
    note: "Google sign-in and security.",
    domain: /(^|\.)google\.[a-z.]+$/,
  },
  {
    test: /^(YSC|VISITOR_INFO1_LIVE|VISITOR_PRIVACY_METADATA|__Secure-YEC)$/,
    vendor: "YouTube",
    category: "advertising",
    domain: /(^|\.)youtube\.com$/,
  },
  // Meta.
  { test: /^_fb[pc]$/, vendor: "Meta Pixel", category: "advertising" },
  { test: /^(fr|tr)$/, vendor: "Meta (Facebook)", category: "advertising", domain: /(^|\.)facebook\.com$/ },
  // Microsoft.
  { test: /^_uet(sid|vid|msclkid)(_exp)?$/, vendor: "Microsoft Advertising (UET)", category: "advertising" },
  { test: /^MUID$/, vendor: "Microsoft", category: "advertising", domain: /(^|\.)(bing\.com|clarity\.ms|microsoft\.com)$/ },
  { test: /^_cl(ck|sk)$/, vendor: "Microsoft Clarity", category: "analytics" },
  { test: /^(CLID|ANONCHK|SM|MR)$/, vendor: "Microsoft Clarity", category: "analytics", domain: /(^|\.)clarity\.ms$/ },
  // Session replay and product analytics.
  { test: /^_hj/, vendor: "Hotjar", category: "analytics" },
  { test: /^ajs_/, vendor: "Segment", category: "analytics" },
  { test: /^mp_/, vendor: "Mixpanel", category: "analytics" },
  { test: /^(amp_|AMP_|amplitude_id)/, vendor: "Amplitude", category: "analytics" },
  { test: /^_hp2_/, vendor: "Heap", category: "analytics" },
  { test: /^ph_.*_posthog$/, vendor: "PostHog", category: "analytics" },
  { test: /^(_pk_(id|ses|ref|cvar|hsr)|mtm_|MATOMO_)/, vendor: "Matomo", category: "analytics" },
  { test: /^(__hstc|__hssc|__hssrc|hubspotutk)$/, vendor: "HubSpot", category: "analytics" },
  { test: /^_ym_/, vendor: "Yandex Metrica", category: "analytics" },
  { test: /^_shopify_(y|s|sa_t|sa_p)$/, vendor: "Shopify analytics", category: "analytics" },
  { test: /^(s_cc|s_sq|s_vi|s_fid|AMCV_.*|AMCVS_.*)$/, vendor: "Adobe Analytics", category: "analytics" },
  // Advertising networks.
  { test: /^(_ttp|_tt_enable_cookie|tt_appInfo|tt_sessionId|tt_pixel_session_index)$/, vendor: "TikTok Pixel", category: "advertising" },
  { test: /^li_fat_id$/, vendor: "LinkedIn Insight", category: "advertising" },
  {
    test: /^(li_sugr|bcookie|bscookie|lidc|UserMatchHistory|AnalyticsSyncHistory|li_gc)$/,
    vendor: "LinkedIn",
    category: "advertising",
    domain: /(^|\.)linkedin\.com$/,
  },
  { test: /^cto_/, vendor: "Criteo", category: "advertising" },
  { test: /^(t_gid|t_pt_gid|taboola_.*)$/, vendor: "Taboola", category: "advertising" },
  { test: /^(obuid|outbrain_cid)$/, vendor: "Outbrain", category: "advertising" },
  { test: /^(_pin_unauth|_pinterest_.*|_derived_epik)$/, vendor: "Pinterest", category: "advertising" },
  { test: /^(_scid|_scid_r|_sctr)$/, vendor: "Snapchat", category: "advertising" },
  { test: /^_rdt_uuid$/, vendor: "Reddit", category: "advertising" },
  { test: /^__qca$/, vendor: "Quantcast", category: "advertising" },
  { test: /^(uuid2|anj)$/, vendor: "Xandr (AppNexus)", category: "advertising", domain: /(^|\.)adnxs\.com$/ },
  { test: /^(demdex|dpm|dextp)$/, vendor: "Adobe Audience Manager", category: "advertising" },

  // Strictly necessary, by name.
  {
    test: /^(PHPSESSID|JSESSIONID|ASP\.NET_SessionId|connect\.sid|laravel_session|csrftoken|XSRF-TOKEN|_csrf|__cf_bm|cf_clearance|__cfruid|_cfuvid|AWSALB|AWSALBCORS|AWSALBTG|__stripe_mid|__stripe_sid)$/,
    vendor: "",
    category: "functional",
    note: NECESSARY_NOTE,
  },
];

/* Hosts and URL shapes of requests */

interface HostRule {
  /** Matches this host and its subdomains. */
  host: string;
  /** Only these paths of the host. */
  path?: RegExp;
  vendor: string;
  category: TrackerCategory;
  note?: string;
  loader?: boolean;
  cmp?: boolean;
}

const CMP_HOST_NOTE = "The consent banner's own files.";

const HOST_RULES: HostRule[] = [
  // Google.
  {
    host: "googletagmanager.com",
    vendor: "Google Tag Manager / gtag.js",
    category: "analytics",
    loader: true,
    note: "Tag loader: sends nothing by itself; what its tags do depends on Consent Mode.",
  },
  { host: "google-analytics.com", vendor: "Google Analytics", category: "analytics" },
  { host: "analytics.google.com", vendor: "Google Analytics", category: "analytics" },
  { host: "doubleclick.net", vendor: "Google Ads (DoubleClick)", category: "advertising" },
  { host: "googleadservices.com", vendor: "Google Ads", category: "advertising" },
  { host: "googlesyndication.com", vendor: "Google AdSense", category: "advertising" },
  { host: "adservice.google.com", vendor: "Google Ads", category: "advertising" },
  { host: "fundingchoicesmessages.google.com", vendor: "Google Funding Choices", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "google.com", path: /^\/(pagead|ads|ccm\/collect)/, vendor: "Google Ads", category: "advertising" },
  {
    host: "youtube.com",
    vendor: "YouTube",
    category: "advertising",
    note: "YouTube embeds set advertising cookies; youtube-nocookie.com avoids most of them.",
  },
  { host: "youtube-nocookie.com", vendor: "YouTube (privacy-enhanced)", category: "functional" },
  {
    host: "fonts.googleapis.com",
    vendor: "Google Fonts",
    category: "functional",
    note: "Sends the visitor's IP to Google: some EU rulings ask to self-host the fonts.",
  },
  {
    host: "fonts.gstatic.com",
    vendor: "Google Fonts",
    category: "functional",
    note: "Sends the visitor's IP to Google: some EU rulings ask to self-host the fonts.",
  },
  // Meta.
  { host: "facebook.net", vendor: "Meta Pixel", category: "advertising" },
  { host: "facebook.com", path: /^\/tr\/?$/, vendor: "Meta Pixel", category: "advertising" },
  // Microsoft.
  { host: "bat.bing.com", vendor: "Microsoft Advertising (UET)", category: "advertising" },
  { host: "bing.com", path: /^\/(bat|action)/, vendor: "Microsoft Advertising (UET)", category: "advertising" },
  { host: "clarity.ms", vendor: "Microsoft Clarity", category: "analytics" },
  // Analytics and session replay.
  { host: "hotjar.com", vendor: "Hotjar", category: "analytics" },
  { host: "hotjar.io", vendor: "Hotjar", category: "analytics" },
  { host: "segment.com", vendor: "Segment", category: "analytics" },
  { host: "segment.io", vendor: "Segment", category: "analytics" },
  { host: "mixpanel.com", vendor: "Mixpanel", category: "analytics" },
  { host: "amplitude.com", vendor: "Amplitude", category: "analytics" },
  { host: "heapanalytics.com", vendor: "Heap", category: "analytics" },
  { host: "heap.io", vendor: "Heap", category: "analytics" },
  { host: "posthog.com", vendor: "PostHog", category: "analytics" },
  { host: "matomo.cloud", vendor: "Matomo", category: "analytics" },
  { host: "plausible.io", vendor: "Plausible", category: "analytics", note: "Cookieless by design: often run without consent." },
  { host: "hs-analytics.net", vendor: "HubSpot", category: "analytics" },
  { host: "hs-scripts.com", vendor: "HubSpot", category: "analytics", loader: true, note: "Loads HubSpot's tracking code." },
  { host: "track.hubspot.com", vendor: "HubSpot", category: "analytics" },
  { host: "mc.yandex.ru", vendor: "Yandex Metrica", category: "analytics" },
  { host: "mc.yandex.com", vendor: "Yandex Metrica", category: "analytics" },
  { host: "scorecardresearch.com", vendor: "Comscore", category: "analytics" },
  { host: "omtrdc.net", vendor: "Adobe Analytics", category: "analytics" },
  { host: "fullstory.com", vendor: "FullStory", category: "analytics" },
  { host: "mouseflow.com", vendor: "Mouseflow", category: "analytics" },
  { host: "contentsquare.net", vendor: "Contentsquare", category: "analytics" },
  // Advertising.
  { host: "analytics.tiktok.com", vendor: "TikTok Pixel", category: "advertising" },
  { host: "business-api.tiktok.com", vendor: "TikTok Pixel", category: "advertising" },
  { host: "snap.licdn.com", vendor: "LinkedIn Insight", category: "advertising" },
  { host: "px.ads.linkedin.com", vendor: "LinkedIn Insight", category: "advertising" },
  { host: "linkedin.com", path: /^\/(px|collect)/, vendor: "LinkedIn Insight", category: "advertising" },
  { host: "criteo.com", vendor: "Criteo", category: "advertising" },
  { host: "criteo.net", vendor: "Criteo", category: "advertising" },
  { host: "taboola.com", vendor: "Taboola", category: "advertising" },
  { host: "outbrain.com", vendor: "Outbrain", category: "advertising" },
  { host: "ct.pinterest.com", vendor: "Pinterest", category: "advertising" },
  { host: "sc-static.net", vendor: "Snapchat", category: "advertising" },
  { host: "tr.snapchat.com", vendor: "Snapchat", category: "advertising" },
  { host: "alb.reddit.com", vendor: "Reddit", category: "advertising" },
  { host: "redditstatic.com", path: /^\/ads/, vendor: "Reddit", category: "advertising" },
  { host: "quantserve.com", vendor: "Quantcast", category: "advertising" },
  { host: "quantcount.com", vendor: "Quantcast", category: "advertising" },
  { host: "adnxs.com", vendor: "Xandr (AppNexus)", category: "advertising" },
  { host: "amazon-adsystem.com", vendor: "Amazon Ads", category: "advertising" },
  { host: "adsrvr.org", vendor: "The Trade Desk", category: "advertising" },
  { host: "rubiconproject.com", vendor: "Magnite (Rubicon)", category: "advertising" },
  { host: "pubmatic.com", vendor: "PubMatic", category: "advertising" },
  { host: "casalemedia.com", vendor: "Index Exchange", category: "advertising" },
  { host: "openx.net", vendor: "OpenX", category: "advertising" },
  { host: "smartadserver.com", vendor: "Equativ (Smart)", category: "advertising" },
  { host: "teads.tv", vendor: "Teads", category: "advertising" },
  { host: "adform.net", vendor: "Adform", category: "advertising" },
  { host: "demdex.net", vendor: "Adobe Audience Manager", category: "advertising" },
  { host: "everesttech.net", vendor: "Adobe Advertising", category: "advertising" },
  // Consent banners.
  { host: "cookielaw.org", vendor: "OneTrust", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "onetrust.com", vendor: "OneTrust", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "cookiebot.com", vendor: "Cookiebot", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "cookiebot.eu", vendor: "Cookiebot", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "privacy-center.org", vendor: "Didomi", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "axept.io", vendor: "Axeptio", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "consensu.org", vendor: "IAB TCF CMP", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "cmp.inmobi.com", vendor: "InMobi (Quantcast) Choice", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "usercentrics.eu", vendor: "Usercentrics", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "trustarc.com", vendor: "TrustArc", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "consentframework.com", vendor: "Sirdata", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "cdn-cookieyes.com", vendor: "CookieYes", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "osano.com", vendor: "Osano", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "iubenda.com", vendor: "iubenda", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  { host: "consentmanager.net", vendor: "consentmanager", category: "functional", cmp: true, note: CMP_HOST_NOTE },
  // Monitoring: functional, but what they collect decides whether they need consent.
  { host: "sentry.io", vendor: "Sentry", category: "functional", note: "Error monitoring." },
  { host: "nr-data.net", vendor: "New Relic", category: "functional", note: "Performance monitoring." },
  { host: "browser-intake-datadoghq.com", vendor: "Datadog RUM", category: "functional", note: "Real-user monitoring." },
];

export const hostMatches = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

const fromNameRule = (r: NameRule): Classification => ({
  category: r.category,
  vendor: r.vendor,
  ...(r.note ? { note: r.note } : {}),
  ...(r.cmp ? { cmp: true } : {}),
});

const fromHostRule = (r: HostRule, asRequest = true): Classification => ({
  category: r.category,
  vendor: r.vendor,
  ...(r.note ? { note: r.note } : {}),
  ...(r.loader && asRequest ? { loader: true } : {}),
  ...(r.cmp ? { cmp: true } : {}),
});

/**
 * What a cookie or storage key is, from its name (and the cookie's domain when given). A heuristic: a site can
 * name anything `_ga`. Rules that need a domain ("fr" on facebook.com) never match storage keys.
 */
export function classifyName(name: string, domain?: string): Classification {
  const host = domain?.replace(/^\./, "").toLowerCase();
  for (const r of NAME_RULES) {
    if (!r.test.test(name)) continue;
    if (r.domain && !(host && r.domain.test(host))) continue;
    return fromNameRule(r);
  }
  if (host) {
    const byHost = HOST_RULES.find((r) => !r.path && hostMatches(host, r.host));
    // A cookie on a tag loader's domain is the vendor's own: no "loader" pass for it.
    if (byHost) return fromHostRule(byHost, false);
  }
  return UNKNOWN;
}

/* Requests */

export interface CapturedRequest {
  host: string;
  path: string;
  /** initiatorType of the resource entry: script, img, xmlhttprequest, fetch, beacon… */
  type: string;
  /** The few query parameters the check reads (v, tid, gcs, en, ev); the rest, identifiers included, is dropped. */
  params: Record<string, string>;
}

const KEEP_PARAMS = ["v", "tid", "gcs", "en", "ev"];

/** Host, path and a few known parameters of a request URL; null for non-web URLs. Identifiers are dropped. */
export function sanitizeRequest(url: string, type: string): CapturedRequest | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const params: Record<string, string> = {};
  for (const k of KEEP_PARAMS) {
    const v = u.searchParams.get(k);
    if (v !== null) params[k] = v.slice(0, 60);
  }
  return { host: u.hostname.toLowerCase(), path: u.pathname.slice(0, 200), type, params };
}

/** Origin and path of a URL, without its query and fragment (they can carry identifiers). */
export function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return "";
  }
}

/** What a request is: its host first, else the shape of its URL (GA4 hits and Meta Pixel events through a proxy). */
export function classifyRequest(r: Pick<CapturedRequest, "host" | "path" | "params">): Classification {
  const byHost = HOST_RULES.find((h) => hostMatches(r.host, h.host) && (!h.path || h.path.test(r.path)));
  if (byHost) return fromHostRule(byHost);
  const tid = r.params.tid ?? "";
  if (/\/g\/collect$/.test(r.path) || (/\/collect$/.test(r.path) && /^(G|UA)-/i.test(tid)))
    return {
      category: "analytics",
      vendor: "Google Analytics",
      byShape: true,
      note: "Recognized by its URL (a GA hit): maybe sent through a first-party proxy or server-side tagging.",
    };
  if (/\/tr\/?$/.test(r.path) && r.params.ev)
    return {
      category: "advertising",
      vendor: "Meta Pixel",
      byShape: true,
      note: "Recognized by its URL (a Meta Pixel event): maybe sent through a proxy.",
    };
  return UNKNOWN;
}

export type SignalValue = "granted" | "denied" | "unset";

/**
 * Google's `gcs` parameter (`G1` then one character for ad_storage and one for analytics_storage: 1 granted,
 * 0 denied, - not set), sent on GA and Ads hits. Null when absent or unreadable.
 */
export function parseGcs(gcs: string | undefined): { ad: SignalValue; analytics: SignalValue } | null {
  const m = /^G1([01-])([01-])$/.exec(gcs ?? "");
  if (!m) return null;
  const v = (c: string): SignalValue => (c === "1" ? "granted" : c === "0" ? "denied" : "unset");
  return { ad: v(m[1]!), analytics: v(m[2]!) };
}

/** A hit that says its consent is denied for what it does: Consent Mode's cookieless ping. */
export function isDeniedPing(r: Pick<CapturedRequest, "params">, category: TrackerCategory): boolean {
  const g = parseGcs(r.params.gcs);
  if (!g) return false;
  if (category === "advertising") return g.ad === "denied";
  if (category === "analytics") return g.analytics === "denied";
  return false;
}

/* Consent banners (CMP) */

interface CmpRule {
  id: string;
  name: string;
  globals?: string[];
  scripts?: RegExp;
  /** Cookie names or storage keys it keeps. */
  names?: RegExp;
}

export const CMP_RULES: CmpRule[] = [
  {
    id: "onetrust",
    name: "OneTrust",
    globals: ["OneTrust", "OnetrustActiveGroups", "OptanonWrapper", "Optanon"],
    scripts: /cdn\.cookielaw\.org|onetrust|optanon/i,
    names: /^(OptanonConsent|OptanonAlertBoxClosed)$/,
  },
  { id: "cookiebot", name: "Cookiebot", globals: ["Cookiebot"], scripts: /consent\.cookiebot\.(com|eu)/i, names: /^CookieConsent$/ },
  {
    id: "didomi",
    name: "Didomi",
    globals: ["Didomi", "didomiOnReady", "didomiConfig"],
    scripts: /sdk\.privacy-center\.org|didomi/i,
    names: /^didomi_token$/,
  },
  {
    id: "axeptio",
    name: "Axeptio",
    globals: ["axeptioSettings", "_axcb", "__axeptioSDK", "axeptioSDK"],
    scripts: /axept\.io|axeptio/i,
    names: /^axeptio_/,
  },
  { id: "quantcast", name: "Quantcast / InMobi Choice", scripts: /quantcast\.mgr\.consensu\.org|cmp\.quantcast\.com|cmp\.inmobi\.com/i },
  {
    id: "usercentrics",
    name: "Usercentrics",
    globals: ["UC_UI", "usercentrics", "__ucCmp", "UC_UI_IS_RENDERED"],
    scripts: /usercentrics\.eu|usercentrics/i,
    names: /^(uc_settings|uc_user_interaction|ucData)$/,
  },
  {
    id: "trustarc",
    name: "TrustArc",
    globals: ["truste", "PrivacyManagerAPI"],
    scripts: /consent\.trustarc\.com|consent\.truste\.com|trustarc/i,
    names: /^(notice_preferences|notice_gdpr_prefs|TAconsentID)$/,
  },
  { id: "sirdata", name: "Sirdata", globals: ["Sddan", "__sdcmpapi"], scripts: /consentframework\.com|sirdata/i },
  {
    id: "cookieyes",
    name: "CookieYes",
    globals: ["getCkyConsent", "cookieyes"],
    scripts: /cdn-cookieyes\.com|cookieyes/i,
    names: /^cookieyes-consent$/,
  },
  { id: "complianz", name: "Complianz", globals: ["complianz", "cmplz_set_cookie"], scripts: /complianz/i, names: /^cmplz_/ },
  { id: "osano", name: "Osano", globals: ["Osano"], scripts: /cmp\.osano\.com/i, names: /^osano_consentmanager/ },
  { id: "iubenda", name: "iubenda", globals: ["_iub"], scripts: /iubenda\.com/i, names: /^_iub_cs-/ },
  {
    id: "funding-choices",
    name: "Google Funding Choices",
    globals: ["googlefc"],
    scripts: /fundingchoicesmessages\.google\.com/i,
    names: /^(FCCDCF|FCNEC)$/,
  },
  { id: "consentmanager", name: "consentmanager", globals: ["cmpmngr", "__cmp"], scripts: /consentmanager\.net/i },
  { id: "tarteaucitron", name: "tarteaucitron", globals: ["tarteaucitron"], scripts: /tarteaucitron/i, names: /^tarteaucitron$/ },
  { id: "borlabs", name: "Borlabs Cookie", globals: ["BorlabsCookie"], scripts: /borlabs-cookie/i, names: /^borlabs-cookie$/ },
  { id: "klaro", name: "Klaro", globals: ["klaro"], scripts: /klaro/i },
];

/** Every global name the CMP rules look for, plus the IAB APIs: the argument of `probeConsentGlobals`. */
export const CMP_GLOBALS: string[] = [...new Set([...CMP_RULES.flatMap((r) => r.globals ?? []), "__tcfapi", "__gpp", "__uspapi"])];

export interface CmpHit {
  id: string;
  name: string;
  /** What gave it away: "global Didomi", "script sdk.privacy-center.org/…", "cookie didomi_token". */
  evidence: string[];
}

export interface CmpSignals {
  globals: string[];
  /** Script and resource URLs (stripped). */
  scripts: string[];
  /** Cookie names and storage keys. */
  names: string[];
  tcf?: TcfState | null;
}

/** Consent banners recognized from their globals, scripts and cookies (a heuristic: custom banners are not). */
export function detectCmps(s: CmpSignals): CmpHit[] {
  const out: CmpHit[] = [];
  const globals = new Set(s.globals);
  for (const r of CMP_RULES) {
    const evidence: string[] = [];
    for (const g of r.globals ?? []) if (globals.has(g)) evidence.push(`global ${g}`);
    if (r.scripts) {
      const src = s.scripts.find((u) => r.scripts!.test(u));
      if (src) evidence.push(`script ${src.replace(/^https?:\/\//, "").slice(0, 80)}`);
    }
    if (r.names) {
      const name = s.names.find((n) => r.names!.test(n));
      if (name) evidence.push(`cookie or key ${name}`);
    }
    if (evidence.length) out.push({ id: r.id, name: r.name, evidence });
  }
  const tcf = s.tcf?.present || globals.has("__tcfapi");
  if (tcf && !out.length) {
    const id = s.tcf?.ping?.cmpId;
    out.push({ id: "tcf", name: `IAB TCF CMP${id ? ` (CMP id ${id})` : ""}`, evidence: ["global __tcfapi"] });
  }
  return out;
}

/* Consent Mode */

/** The four signals Consent Mode v2 needs before any tag sends data. */
export const KEY_SIGNALS = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"] as const;

export interface SignalState {
  signal: string;
  /** Value of the default command(s), when one sets it. */
  default?: string;
  /** Value of the last update, when one sets it. */
  update?: string;
  /** What tags see now: the last update, else the default, else "unset" (which tags treat as granted). */
  effective: string;
}

export interface ConsentModeState {
  /** At least one gtag('consent', …) command. */
  present: boolean;
  hasDefault: boolean;
  hasUpdate: boolean;
  /** A default limited to some regions: visitors elsewhere get no default from it. */
  regional: string[];
  signals: SignalState[];
}

export function consentModeState(steps: ConsentStep[]): ConsentModeState {
  const defaults: Record<string, string> = {};
  const updates: Record<string, string> = {};
  const regional = new Set<string>();
  for (const s of steps) {
    const target = s.command === "default" ? defaults : s.command === "update" ? updates : null;
    if (!target) continue;
    if (s.command === "default" && s.region?.length) for (const r of s.region) regional.add(r);
    for (const [k, v] of Object.entries(s.states)) target[k] = v;
  }
  const names = [...new Set([...CONSENT_TYPES, ...Object.keys(defaults), ...Object.keys(updates)])];
  return {
    present: steps.length > 0,
    hasDefault: steps.some((s) => s.command === "default"),
    hasUpdate: steps.some((s) => s.command === "update"),
    regional: [...regional],
    signals: names.map((signal) => ({
      signal,
      ...(signal in defaults ? { default: defaults[signal] } : {}),
      ...(signal in updates ? { update: updates[signal] } : {}),
      effective: updates[signal] ?? defaults[signal] ?? "unset",
    })),
  };
}

/* Captures */

export type CapturePhase = "before" | "current" | "after";
export type Choice = "accept" | "reject" | "other";

export const CHOICE_LABEL: Record<Choice, string> = {
  accept: "after accepting",
  reject: "after rejecting",
  other: "after another choice",
};

export interface CapturedCookie {
  name: string;
  domain: string;
  path: string;
  partitioned: boolean;
  httpOnly: boolean;
  session: boolean;
  /** Already in the browser before this load (third-party cookies from earlier browsing). Undefined: unknown. */
  preexisting?: boolean;
}

export interface ConsentCapture {
  id: string;
  phase: CapturePhase;
  choice?: Choice;
  at: number;
  url: string;
  title: string;
  /** Where the cookie names come from: Chrome's cookie store, or `document.cookie` (no HttpOnly, no third party). */
  cookieSource: "cookies-api" | "document";
  /** devkit could list third-party cookies (it has access to all sites). */
  thirdPartyCookies: boolean;
  cookies: CapturedCookie[];
  localKeys: string[] | null;
  sessionKeys: string[] | null;
  requests: CapturedRequest[];
  resourceBufferFull: boolean;
  /** Script and frame URLs, without query strings. */
  scripts: string[];
  iframes: string[];
  globals: string[];
  tcf: TcfState | null;
  consent: ConsentStep[];
  /** The dataLayer shows Google tags (containers or gtag calls). */
  googleTags: boolean;
  errors: string[];
}

/** The fields of a Chrome cookie the check uses. The value is only fingerprinted, never kept. */
export interface CookieInput {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  partitionKey?: { topLevelSite?: string };
}

/** Short FNV-1a hash of a cookie's value and expiry: tells "set again during this load" without keeping the value. */
export function cookieFingerprint(c: Pick<CookieInput, "value" | "expirationDate">): string {
  const s = `${c.value}\u0000${c.expirationDate ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const cookieId = (c: Pick<CookieInput, "domain" | "path" | "name"> & { partitionKey?: unknown; partitioned?: boolean }) =>
  `${c.domain}|${c.path}|${c.name}|${c.partitionKey || c.partitioned ? "p" : ""}`;

/** Fingerprints of the cookies in the browser right before the reload. */
export function cookieBaseline(cookies: CookieInput[]): Map<string, string> {
  return new Map(cookies.map((c) => [cookieId(c), cookieFingerprint(c)]));
}

/** Whether a partitioned cookie belongs to the page's top-level site (other partitions are other sites' business). */
function inPartitionOf(c: CookieInput, pageSite: string): boolean {
  const top = c.partitionKey?.topLevelSite;
  if (!c.partitionKey) return true;
  if (!top) return true;
  try {
    return siteOf(new URL(top).hostname) === pageSite;
  } catch {
    return true;
  }
}

export interface CaptureInput {
  phase: CapturePhase;
  choice?: Choice;
  at: number;
  page: ConsentPageSnapshot;
  globals: ConsentGlobals | null;
  consent: ConsentStep[];
  googleTags: boolean;
  /** Chrome cookies of the site and its third parties; null without the cookies permission. */
  cookies: CookieInput[] | null;
  /** Fingerprints taken right before the reload, to tell cookies already there from cookies set by this load. */
  baseline?: Map<string, string> | null;
  thirdPartyCookies: boolean;
  errors?: string[];
}

/** Turns what the panel read into a capture: names only, URLs stripped, cookies outside the page's partition dropped. */
export function buildCapture(input: CaptureInput): ConsentCapture {
  const { page } = input;
  const pageSite = siteOf(new URL(page.url).hostname);
  const cookies: CapturedCookie[] = input.cookies
    ? input.cookies
        .filter((c) => inPartitionOf(c, pageSite))
        .map((c) => {
          const id = cookieId(c);
          const preexisting = input.baseline ? input.baseline.get(id) === cookieFingerprint(c) : undefined;
          return {
            name: c.name,
            domain: c.domain,
            path: c.path,
            partitioned: Boolean(c.partitionKey),
            httpOnly: c.httpOnly,
            session: c.session,
            ...(preexisting === undefined ? {} : { preexisting }),
          };
        })
    : page.documentCookies.map((name) => ({
        name,
        domain: new URL(page.url).hostname,
        path: "/",
        partitioned: false,
        httpOnly: false,
        session: false,
      }));
  const seen = new Set<string>();
  const unique = cookies.filter((c) => {
    const k = cookieId(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    id: `${input.phase}-${input.at}`,
    phase: input.phase,
    ...(input.choice ? { choice: input.choice } : {}),
    at: input.at,
    url: stripUrl(page.url),
    title: page.title.slice(0, 200),
    cookieSource: input.cookies ? "cookies-api" : "document",
    thirdPartyCookies: input.thirdPartyCookies,
    cookies: unique,
    localKeys: page.localKeys,
    sessionKeys: page.sessionKeys,
    requests: page.resources.map((r) => sanitizeRequest(r.url, r.type)).filter((r): r is CapturedRequest => r !== null),
    resourceBufferFull: page.resourceBufferFull,
    scripts: [...new Set(page.scripts.map(stripUrl).filter(Boolean))],
    iframes: [...new Set(page.iframes.map(stripUrl).filter(Boolean))],
    globals: input.globals?.globals ?? [],
    tcf: input.globals?.tcf ?? null,
    consent: input.consent,
    googleTags: input.googleTags,
    errors: input.errors ?? [],
  };
}

/** Third-party sites a capture's page talks to, whose cookies the panel reads. */
export function thirdPartySites(page: Pick<ConsentPageSnapshot, "url" | "resources" | "iframes">): string[] {
  const pageSite = siteOf(new URL(page.url).hostname);
  const sites = new Set<string>();
  for (const u of [...page.resources.map((r) => r.url), ...page.iframes]) {
    try {
      const url = new URL(u);
      if (!/^https?:$/.test(url.protocol)) continue;
      const site = siteOf(url.hostname);
      if (site !== pageSite) sites.add(site);
    } catch {
      // Not a URL.
    }
  }
  return [...sites].slice(0, 100);
}

/* Analysis */

export type ClassifiedCookie = CapturedCookie & Classification & { firstParty: boolean };
export type ClassifiedKey = Classification & { area: "local" | "session"; key: string };

export interface RequestGroup extends Classification {
  host: string;
  site: string;
  firstParty: boolean;
  count: number;
  /** Hits that carry gcs with this category denied: Consent Mode's cookieless pings. */
  deniedPings: number;
  types: string[];
  paths: string[];
  gcs: string[];
}

export interface ConsentFinding {
  id: string;
  level: Level;
  label: string;
  detail: string;
  /** Cookie names, keys or hosts it is about (never values). */
  items?: string[];
}

export interface ConsentAnalysis {
  capture: ConsentCapture;
  pageSite: string;
  cookies: ClassifiedCookie[];
  storage: ClassifiedKey[];
  requests: RequestGroup[];
  cmps: CmpHit[];
  consentMode: ConsentModeState;
  /** Google tags seen in the dataLayer, the scripts or the requests. */
  googleTags: boolean;
  findings: ConsentFinding[];
  counts: {
    cookies: number;
    tracking: number;
    advertising: number;
    analytics: number;
    thirdPartyHosts: number;
    unknownThirdParties: number;
    problems: number;
    warnings: number;
  };
}

export const isTracking = (c: Classification) => (c.category === "advertising" || c.category === "analytics") && !c.loader;

/** Tracking requests of a group, Consent Mode's denied pings left out. */
export const trackingHits = (g: RequestGroup) => (isTracking(g) ? g.count - g.deniedPings : 0);

const cookieLabel = (c: ClassifiedCookie) =>
  `${c.name} (${[c.vendor, c.firstParty ? "" : c.domain.replace(/^\./, "")].filter(Boolean).join(", ") || c.domain.replace(/^\./, "")})`;
const keyLabel = (k: ClassifiedKey) => `${k.key} (${k.area}Storage${k.vendor ? `, ${k.vendor}` : ""})`;
const groupLabel = (g: RequestGroup) => `${g.host}${g.vendor ? ` (${g.vendor})` : ""}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function groupRequests(requests: CapturedRequest[], pageSite: string): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const r of requests) {
    const cls = classifyRequest(r);
    const key = `${r.host}|${cls.vendor}|${cls.category}`;
    let g = groups.get(key);
    if (!g) {
      const site = siteOf(r.host);
      g = { ...cls, host: r.host, site, firstParty: site === pageSite, count: 0, deniedPings: 0, types: [], paths: [], gcs: [] };
      groups.set(key, g);
    }
    g.count++;
    if (isDeniedPing(r, cls.category)) g.deniedPings++;
    if (r.type && !g.types.includes(r.type)) g.types.push(r.type);
    if (g.paths.length < 5 && !g.paths.includes(r.path)) g.paths.push(r.path);
    if (r.params.gcs && !g.gcs.includes(r.params.gcs)) g.gcs.push(r.params.gcs);
  }
  const rank: Record<TrackerCategory, number> = { advertising: 0, analytics: 1, unknown: 2, functional: 3 };
  return [...groups.values()].sort(
    (a, b) => Number(a.firstParty) - Number(b.firstParty) || rank[a.category] - rank[b.category] || b.count - a.count,
  );
}

const GOOGLE_VENDOR = /^Google (Analytics|Ads|Tag Manager|AdSense)/;

export function analyzeCapture(capture: ConsentCapture): ConsentAnalysis {
  const pageSite = siteOf(new URL(capture.url).hostname);
  const cookies: ClassifiedCookie[] = capture.cookies.map((c) => ({
    ...c,
    ...classifyName(c.name, c.domain),
    firstParty: siteOf(c.domain.replace(/^\./, "")) === pageSite,
  }));
  const storage: ClassifiedKey[] = [
    ...(capture.localKeys ?? []).map((key) => ({ ...classifyName(key), area: "local" as const, key })),
    ...(capture.sessionKeys ?? []).map((key) => ({ ...classifyName(key), area: "session" as const, key })),
  ];
  const requests = groupRequests(capture.requests, pageSite);
  const scriptUrls = [...capture.scripts, ...capture.iframes, ...capture.requests.map((r) => `https://${r.host}${r.path}`)];
  const cmps = detectCmps({
    globals: capture.globals,
    scripts: scriptUrls,
    names: [...capture.cookies.map((c) => c.name), ...storage.map((k) => k.key)],
    tcf: capture.tcf,
  });
  const consentMode = consentModeState(capture.consent);
  const googleTags =
    capture.googleTags ||
    consentMode.present ||
    requests.some((g) => GOOGLE_VENDOR.test(g.vendor)) ||
    capture.scripts.some((s) => /googletagmanager\.com|google-analytics\.com/.test(s));
  const findings = consentFindings({ capture, cookies, storage, requests, cmps, consentMode, googleTags });
  const live = cookies.filter((c) => !c.preexisting);
  const trackingCookies = live.filter(isTracking);
  const thirdHosts = requests.filter((g) => !g.firstParty);
  return {
    capture,
    pageSite,
    cookies,
    storage,
    requests,
    cmps,
    consentMode,
    googleTags,
    findings,
    counts: {
      cookies: cookies.length,
      tracking: trackingCookies.length + storage.filter(isTracking).length + requests.filter((g) => trackingHits(g) > 0).length,
      advertising:
        trackingCookies.filter((c) => c.category === "advertising").length +
        storage.filter((k) => k.category === "advertising").length +
        requests.filter((g) => g.category === "advertising" && trackingHits(g) > 0).length,
      analytics:
        trackingCookies.filter((c) => c.category === "analytics").length +
        storage.filter((k) => k.category === "analytics").length +
        requests.filter((g) => g.category === "analytics" && trackingHits(g) > 0).length,
      thirdPartyHosts: new Set(thirdHosts.map((g) => g.host)).size,
      unknownThirdParties: new Set(thirdHosts.filter((g) => g.category === "unknown").map((g) => g.host)).size,
      problems: findings.filter((f) => f.level === "bad").length,
      warnings: findings.filter((f) => f.level === "warn").length,
    },
  };
}

interface FindingInput {
  capture: ConsentCapture;
  cookies: ClassifiedCookie[];
  storage: ClassifiedKey[];
  requests: RequestGroup[];
  cmps: CmpHit[];
  consentMode: ConsentModeState;
  googleTags: boolean;
}

const ANALYTICS_NOTE =
  "Analytics cookies need consent under the ePrivacy rules in most of the EU; only strictly limited first-party audience measurement is exempt in some countries (CNIL).";

/** GDPR / ePrivacy findings for one capture. Labels say "before consent": the panel words them for the current state. */
export function consentFindings(a: FindingInput): ConsentFinding[] {
  const out: ConsentFinding[] = [];
  const before = a.capture.phase !== "after";
  // The current state did not start from cleared data: what it shows may follow an earlier choice.
  const current = a.capture.phase === "current";
  const when = current ? "in the current state" : before ? "before consent" : "after your choice";
  const bad: Level = current ? "warn" : "bad";
  const live = a.cookies.filter((c) => !c.preexisting);
  const adCookies = live.filter((c) => c.category === "advertising");
  const anCookies = live.filter((c) => c.category === "analytics");
  const adKeys = a.storage.filter((k) => k.category === "advertising");
  const anKeys = a.storage.filter((k) => k.category === "analytics");
  const adReqs = a.requests.filter((g) => g.category === "advertising" && trackingHits(g) > 0);
  const anReqs = a.requests.filter((g) => g.category === "analytics" && trackingHits(g) > 0);
  const pings = a.requests.filter((g) => g.deniedPings > 0);

  if (before) {
    if (adCookies.length)
      out.push({
        id: "ads-cookies",
        level: bad,
        label: `${plural(adCookies.length, "advertising cookie")} ${when}`,
        detail: "Advertising cookies need the visitor's prior consent (ePrivacy Directive art. 5(3), GDPR): set them only after Accept.",
        items: adCookies.map(cookieLabel),
      });
    if (anCookies.length)
      out.push({
        id: "analytics-cookies",
        level: bad,
        label: `${plural(anCookies.length, "analytics cookie")} ${when}`,
        detail: ANALYTICS_NOTE,
        items: anCookies.map(cookieLabel),
      });
    if (adKeys.length || anKeys.length)
      out.push({
        id: "tracking-storage",
        level: bad,
        label: `${plural(adKeys.length + anKeys.length, "tracking storage key")} ${when}`,
        detail: "localStorage and sessionStorage fall under the same consent rule as cookies.",
        items: [...adKeys, ...anKeys].map(keyLabel),
      });
    if (adReqs.length)
      out.push({
        id: "ads-requests",
        level: bad,
        label: `${plural(adReqs.length, "advertising host")} contacted ${when}`,
        detail: "Advertising tags ran before the visitor chose: block them until consent (or let Consent Mode hold them).",
        items: adReqs.map((g) => `${groupLabel(g)}: ${plural(trackingHits(g), "request")}`),
      });
    if (anReqs.length)
      out.push({
        id: "analytics-requests",
        level: "warn",
        label: `${plural(anReqs.length, "analytics host")} contacted ${when}`,
        detail: "Analytics tags sent data before the visitor chose. Without consent they may only run cookieless and strictly limited.",
        items: anReqs.map((g) => `${groupLabel(g)}: ${plural(trackingHits(g), "request")}`),
      });
  }
  if (pings.length)
    out.push({
      id: "denied-pings",
      level: "info",
      label: `${plural(
        pings.reduce((n, g) => n + g.deniedPings, 0),
        "Google hit",
      )} with consent denied (gcs)`,
      detail:
        "Consent Mode's cookieless pings (advanced mode): they carry no cookie, but some regulators still see them as tracking; basic mode sends nothing until consent.",
      items: pings.map((g) => `${g.host}: gcs ${g.gcs.join(", ")}`),
    });

  // Consent Mode.
  const cm = a.consentMode;
  if (a.googleTags) {
    if (!cm.hasDefault)
      out.push({
        id: "consent-mode-missing",
        level: "bad",
        label: cm.hasUpdate ? "Consent Mode update without a default" : "Google tags without Consent Mode",
        detail:
          "No gtag('consent', 'default', …) in the dataLayer: Google tags run as if everything were granted until told otherwise. Set every signal to denied before any tag loads. (A CMP may set it outside the dataLayer: check the dataLayer panel.)",
      });
    else {
      const defaultGranted = KEY_SIGNALS.filter((s) => {
        const st = cm.signals.find((x) => x.signal === s);
        return !st?.default || st.default === "granted";
      });
      if (defaultGranted.length)
        out.push({
          id: "consent-default-granted",
          level: cm.regional.length ? "warn" : bad,
          label: `Consent Mode default grants ${defaultGranted.join(", ")}`,
          detail: `Before any interaction the default must deny ${KEY_SIGNALS.join(", ")} (a signal the default leaves out counts as granted).${
            cm.regional.length ? ` The default is limited to ${cm.regional.join(", ")}: visitors elsewhere get another one.` : ""
          }`,
          items: defaultGranted.map((s) => {
            const st = cm.signals.find((x) => x.signal === s);
            return `${s}: ${st?.default ?? "not set"}`;
          }),
        });
      else
        out.push({
          id: "consent-default-denied",
          level: "good",
          label: "Consent Mode default denies the four v2 signals",
          detail: `${KEY_SIGNALS.join(", ")} start denied.`,
        });
      if (before) {
        const granted = cm.signals.filter((s) => s.update === "granted" && (KEY_SIGNALS as readonly string[]).includes(s.signal));
        if (granted.length)
          out.push({
            id: "consent-update-before",
            level: a.capture.phase === "before" ? "bad" : "warn",
            label: `Consent update grants ${granted.map((s) => s.signal).join(", ")} without a choice`,
            detail:
              a.capture.phase === "before"
                ? "devkit cleared the site's data, yet a consent update grants signals before you answered: the CMP may grant by default."
                : "This capture did not clear the site's data: the update may replay a choice made earlier.",
          });
      }
    }
  }

  // The consent banner.
  if (!a.cmps.length)
    out.push({
      id: "no-cmp",
      level: live.some(isTracking) || adReqs.length || anReqs.length || a.storage.some(isTracking) ? "warn" : "info",
      label: "No known consent banner found",
      detail: `devkit looks for ${CMP_RULES.length} consent platforms and the IAB TCF API by their globals, scripts and cookies (a heuristic): a custom banner is not recognized.`,
    });
  const tcf = a.capture.tcf;
  if (tcf?.present && before) {
    if (tcf.hasTcString === false && (adCookies.length || adReqs.length))
      out.push({
        id: "tcf-tracking-before-string",
        level: bad,
        label: "Advertising before the TCF consent string",
        detail:
          "The IAB TCF API has no consent string yet, but advertising cookies or requests already ran: TCF vendors must wait for the TC string (getTCData / addEventListener).",
      });
    if (tcf.ping?.gdprApplies === false)
      out.push({
        id: "tcf-gdpr-not-applies",
        level: "info",
        label: "The CMP says GDPR does not apply",
        detail: "__tcfapi('ping') answers gdprApplies: false, usually from the visitor's location: the banner may not show here.",
      });
  }

  // What the capture could not see.
  const pre = a.cookies.filter((c) => c.preexisting);
  if (pre.length)
    out.push({
      id: "preexisting",
      level: "info",
      label: `${plural(pre.length, "third-party cookie")} already in the browser`,
      detail:
        "They were there before the reload (earlier browsing) and this load did not set them again: listed apart and not counted. Clearing them would sign you out of those sites.",
      items: pre.slice(0, 30).map(cookieLabel),
    });
  if (a.capture.cookieSource === "document")
    out.push({
      id: "cookies-partial",
      level: "info",
      label: "Cookies read from the page only",
      detail: "Without the cookies permission devkit sees document.cookie: HttpOnly and third-party cookies are missing.",
    });
  else if (!a.capture.thirdPartyCookies)
    out.push({
      id: "third-party-cookies-hidden",
      level: "info",
      label: "Third-party cookies not listed",
      detail: "Chrome only shows devkit the cookies of sites it can access: allow all sites to see what third parties set.",
    });
  if (a.capture.resourceBufferFull)
    out.push({
      id: "resource-buffer",
      level: "info",
      label: "Resource timing buffer full",
      detail: "Chrome keeps the first 250 resource entries by default: later requests are missing from this capture.",
    });
  const unknown = [...new Set(a.requests.filter((g) => !g.firstParty && g.category === "unknown").map((g) => g.host))];
  if (unknown.length)
    out.push({
      id: "unknown-third-parties",
      level: "info",
      label: `${plural(unknown.length, "third-party host")} not in devkit's list`,
      detail: "Not recognized as trackers: check what they are and whether they set identifiers.",
      items: unknown.slice(0, 30),
    });

  if (before && !out.some((f) => f.level === "bad" || f.level === "warn"))
    out.push({
      id: "clean",
      level: "good",
      label: current ? "Nothing tracking found in the current state" : "Nothing tracking found before consent",
      detail: "No known analytics or advertising cookie, storage key or request (heuristic: unknown names are listed below).",
    });
  return out;
}

/* Before / after */

export interface SignalChange {
  signal: string;
  before: string;
  after: string;
}

export interface ConsentComparison {
  choice: Choice;
  before: ConsentAnalysis;
  after: ConsentAnalysis;
  cookiesAdded: ClassifiedCookie[];
  cookiesRemoved: ClassifiedCookie[];
  storageAdded: ClassifiedKey[];
  /** Hosts that started sending tracking hits (or appeared at all). */
  requestsAdded: RequestGroup[];
  signals: SignalChange[];
  findings: ConsentFinding[];
}

const groupKey = (g: RequestGroup) => `${g.host}|${g.vendor}|${g.category}`;
const storageKey = (k: ClassifiedKey) => `${k.area}|${k.key}`;

export function compareCaptures(before: ConsentAnalysis, after: ConsentAnalysis, choice: Choice): ConsentComparison {
  const beforeCookies = new Set(before.cookies.map(cookieId));
  const afterCookies = new Set(after.cookies.map(cookieId));
  const cookiesAdded = after.cookies.filter((c) => !beforeCookies.has(cookieId(c)) && !c.preexisting);
  const cookiesRemoved = before.cookies.filter((c) => !afterCookies.has(cookieId(c)));
  const beforeKeys = new Set(before.storage.map(storageKey));
  const storageAdded = after.storage.filter((k) => !beforeKeys.has(storageKey(k)));
  const beforeGroups = new Map(before.requests.map((g) => [groupKey(g), g]));
  const requestsAdded = after.requests.filter((g) => {
    const b = beforeGroups.get(groupKey(g));
    if (!b) return true;
    return trackingHits(g) > 0 && trackingHits(b) === 0;
  });
  const signalNames = [...new Set([...before.consentMode.signals, ...after.consentMode.signals].map((s) => s.signal))];
  const eff = (a: ConsentAnalysis, s: string) => a.consentMode.signals.find((x) => x.signal === s)?.effective ?? "unset";
  const signals = signalNames
    .map((signal) => ({ signal, before: eff(before, signal), after: eff(after, signal) }))
    .filter((s) => s.before !== s.after);

  const out: ConsentFinding[] = [];
  const newTracking = [...cookiesAdded.filter(isTracking).map(cookieLabel), ...storageAdded.filter(isTracking).map(keyLabel)];
  const newRequests = requestsAdded.filter((g) => trackingHits(g) > 0);
  const grantedNow = (KEY_SIGNALS as readonly string[]).filter((s) => eff(after, s) === "granted");
  if (choice === "reject") {
    if (newTracking.length)
      out.push({
        id: "reject-tracking-storage",
        level: "bad",
        label: `${plural(newTracking.length, "tracking cookie or key", "tracking cookies or keys")} set after rejecting`,
        detail: "Rejecting must be as effective as accepting: nothing beyond strictly necessary storage.",
        items: newTracking,
      });
    if (newRequests.length)
      out.push({
        id: "reject-tracking-requests",
        level: "bad",
        label: `${plural(newRequests.length, "tracking host")} contacted after rejecting`,
        detail: "These tags started after you rejected: they ignore the choice.",
        items: newRequests.map(groupLabel),
      });
    if (after.consentMode.present && grantedNow.length)
      out.push({
        id: "reject-granted",
        level: "bad",
        label: `Consent Mode grants ${grantedNow.join(", ")} after rejecting`,
        detail: "The CMP should send gtag('consent', 'update') with these denied (or leave the denied default).",
      });
    if (!out.length)
      out.push({
        id: "reject-clean",
        level: "good",
        label: "Rejecting added no tracking",
        detail: "No new analytics or advertising cookie, key or host after rejecting (heuristic).",
      });
  } else if (choice === "accept") {
    if (after.consentMode.present && !grantedNow.length)
      out.push({
        id: "accept-no-update",
        level: "warn",
        label: "Accepting did not grant Consent Mode signals",
        detail:
          "After Accept, no key signal is granted: the CMP may not send gtag('consent', 'update'), so Google tags stay restricted (or the capture came too early).",
      });
    if (newTracking.length || newRequests.length)
      out.push({
        id: "accept-added",
        level: "info",
        label: `Accepting added ${plural(newTracking.length + newRequests.length, "tracker")}`,
        detail: "Expected after consent: check that each one is listed in the banner's vendors.",
        items: [...newTracking, ...newRequests.map(groupLabel)],
      });
  } else if (newTracking.length || newRequests.length)
    out.push({
      id: "other-added",
      level: "info",
      label: `${plural(newTracking.length + newRequests.length, "tracker")} added`,
      detail: "Check that they match the purposes you allowed.",
      items: [...newTracking, ...newRequests.map(groupLabel)],
    });
  return { choice, before, after, cookiesAdded, cookiesRemoved, storageAdded, requestsAdded, signals, findings: out };
}

/** Wait after the load event before the capture: tags often fire on a timer or after the CMP initializes. */
export const SETTLE_MS = 3000;

/** How many captures the panel keeps per tab. */
export const MAX_CAPTURES = 12;
