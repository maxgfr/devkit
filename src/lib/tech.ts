import type { TechSignals } from "./page/collect";

export interface Tech {
  name: string;
  category: "Framework" | "Library" | "CMS" | "Analytics" | "Monitoring" | "Hosting" | "CSS" | "Commerce" | "Widget" | "Server";
  evidence: string;
}

interface Rule {
  name: string;
  category: Tech["category"];
  globals?: string[];
  attributes?: string[];
  scripts?: RegExp;
  generator?: RegExp;
  headers?: [string, RegExp?][];
  classes?: (sample: string[]) => boolean;
}

const RULES: Rule[] = [
  {
    name: "Next.js",
    category: "Framework",
    globals: ["__NEXT_DATA__", "next"],
    attributes: ["#__next"],
    scripts: /\/_next\//,
    headers: [["x-powered-by", /next\.js/i], ["x-nextjs-cache"]],
  },
  { name: "Nuxt", category: "Framework", globals: ["__NUXT__", "$nuxt"], attributes: ["#__nuxt"], scripts: /\/_nuxt\// },
  { name: "Remix", category: "Framework", globals: ["__remixContext"] },
  { name: "Gatsby", category: "Framework", globals: ["___gatsby", "__GATSBY"], attributes: ["#___gatsby"] },
  {
    name: "SvelteKit",
    category: "Framework",
    globals: ["__SVELTEKIT_DATA__", "__sveltekit_dev"],
    attributes: ["[data-sveltekit-preload-data]"],
    scripts: /\/_app\/immutable\//,
  },
  { name: "Svelte", category: "Library", attributes: ["[data-svelte-h]"], classes: (s) => s.some((c) => /^svelte-[a-z0-9]{5,}$/.test(c)) },
  { name: "Astro", category: "Framework", globals: ["Astro"], attributes: ["astro-island", "[data-astro-cid]"], generator: /astro/i },
  { name: "Qwik", category: "Framework", globals: ["Qwik", "__qwik"], attributes: ["[q\\:container]"] },
  { name: "React", category: "Library", globals: ["React", "__react_dom__"], attributes: ["[data-reactroot]"] },
  { name: "Preact", category: "Library", globals: ["Preact", "__PREACT_DEVTOOLS__"] },
  { name: "Vue", category: "Library", globals: ["__VUE__", "Vue"], attributes: ["[data-v-app]", "[data-server-rendered]"] },
  { name: "Angular", category: "Framework", globals: ["ng", "getAllAngularRootElements"], attributes: ["[ng-version]"] },
  { name: "AngularJS", category: "Framework", globals: ["angular"] },
  { name: "SolidJS", category: "Library", globals: ["_$HY", "solid"] },
  { name: "Ember", category: "Framework", globals: ["Ember"] },
  { name: "Lit", category: "Library", globals: ["litElementVersions", "Lit"] },
  { name: "Alpine.js", category: "Library", globals: ["Alpine"], attributes: ["[x-data]"] },
  { name: "htmx", category: "Library", globals: ["htmx"], attributes: ["[hx-get],[hx-post]"] },
  { name: "Hotwire Turbo", category: "Library", globals: ["Turbo"], attributes: ["[data-turbo]"] },
  { name: "Stimulus", category: "Library", globals: ["Stimulus"] },
  { name: "Livewire", category: "Framework", globals: ["Livewire"], attributes: ["[wire\\:id]"] },
  { name: "Inertia.js", category: "Library", globals: ["Inertia"] },
  { name: "jQuery", category: "Library", globals: ["jQuery"], scripts: /jquery[.-]/i },
  { name: "Lodash", category: "Library", globals: ["lodash"] },
  { name: "Moment.js", category: "Library", globals: ["moment"] },
  { name: "Day.js", category: "Library", globals: ["dayjs"] },
  { name: "GSAP", category: "Library", globals: ["gsap"] },
  { name: "Three.js", category: "Library", globals: ["THREE"] },
  { name: "Apollo Client", category: "Library", globals: ["__APOLLO_CLIENT__"] },
  { name: "WordPress", category: "CMS", globals: ["wp"], scripts: /\/wp-(content|includes)\//, generator: /wordpress/i },
  { name: "Drupal", category: "CMS", globals: ["Drupal"], generator: /drupal/i, headers: [["x-drupal-cache"]] },
  { name: "Webflow", category: "CMS", globals: ["Webflow"], generator: /webflow/i },
  { name: "Wix", category: "CMS", globals: ["Wix"], generator: /wix/i },
  { name: "Ghost", category: "CMS", generator: /ghost/i },
  { name: "Hugo", category: "Framework", generator: /hugo/i },
  { name: "Jekyll", category: "Framework", generator: /jekyll/i },
  { name: "Docusaurus", category: "Framework", generator: /docusaurus/i },
  { name: "Shopify", category: "Commerce", globals: ["Shopify"], scripts: /cdn\.shopify\.com/ },
  { name: "Stripe", category: "Commerce", globals: ["Stripe"], scripts: /js\.stripe\.com/ },
  { name: "Google Tag Manager", category: "Analytics", scripts: /googletagmanager\.com\/gtm\.js/ },
  {
    name: "Google Analytics",
    category: "Analytics",
    globals: ["gtag", "ga"],
    scripts: /google-analytics\.com|googletagmanager\.com\/gtag/,
  },
  { name: "Matomo", category: "Analytics", globals: ["_paq"], scripts: /matomo|piwik/i },
  { name: "Plausible", category: "Analytics", globals: ["plausible"], scripts: /plausible\.io/ },
  { name: "PostHog", category: "Analytics", globals: ["posthog"] },
  { name: "Mixpanel", category: "Analytics", globals: ["mixpanel"] },
  { name: "Amplitude", category: "Analytics", globals: ["amplitude"] },
  { name: "Segment", category: "Analytics", scripts: /cdn\.segment\.com/ },
  { name: "Hotjar", category: "Analytics", globals: ["hj"], scripts: /hotjar/ },
  { name: "Microsoft Clarity", category: "Analytics", globals: ["clarity"], scripts: /clarity\.ms/ },
  { name: "Sentry", category: "Monitoring", globals: ["__SENTRY__", "Sentry"], scripts: /sentry/i },
  { name: "Datadog RUM", category: "Monitoring", globals: ["DD_RUM"] },
  { name: "New Relic", category: "Monitoring", globals: ["newrelic"] },
  { name: "LogRocket", category: "Monitoring", globals: ["LogRocket"] },
  { name: "Intercom", category: "Widget", globals: ["Intercom"] },
  { name: "Crisp", category: "Widget", globals: ["$crisp"] },
  { name: "reCAPTCHA", category: "Widget", globals: ["grecaptcha"] },
  { name: "hCaptcha", category: "Widget", globals: ["hcaptcha"] },
  { name: "Cloudflare Turnstile", category: "Widget", globals: ["turnstile"] },
  {
    name: "Tailwind CSS",
    category: "CSS",
    classes: (s) =>
      s.filter((c) => /^(?:[a-z]+:)*(?:px|py|mx|my|mt|mb|pt|pb|gap|text|bg|rounded|flex|grid|w|h)-[\w./[\]-]+$/.test(c)).length > 25,
  },
  {
    name: "Bootstrap",
    category: "CSS",
    globals: ["bootstrap"],
    classes: (s) =>
      ["container", "row", "btn", "navbar"].filter((c) => s.includes(c)).length >= 3 && s.some((c) => /^col-(sm|md|lg|xl)-\d+$/.test(c)),
  },
  { name: "Vercel", category: "Hosting", headers: [["x-vercel-id"], ["server", /vercel/i]] },
  { name: "Netlify", category: "Hosting", headers: [["x-nf-request-id"], ["server", /netlify/i]] },
  { name: "Cloudflare", category: "Hosting", headers: [["cf-ray"], ["server", /cloudflare/i]] },
  { name: "Fastly", category: "Hosting", headers: [["x-served-by", /cache-/i], ["fastly-debug-digest"]] },
  { name: "Amazon CloudFront", category: "Hosting", headers: [["x-amz-cf-id"]] },
  { name: "GitHub Pages", category: "Hosting", headers: [["server", /github\.com/i]] },
  { name: "Akamai", category: "Hosting", headers: [["x-akamai-transformed"], ["server", /akamai/i]] },
  { name: "nginx", category: "Server", headers: [["server", /nginx/i]] },
  { name: "Apache", category: "Server", headers: [["server", /apache/i]] },
  { name: "Express", category: "Server", headers: [["x-powered-by", /express/i]] },
  { name: "PHP", category: "Server", headers: [["x-powered-by", /php/i]] },
  { name: "ASP.NET", category: "Server", headers: [["x-powered-by", /asp\.net/i], ["x-aspnet-version"]] },
];

/** Every technology `signals` and `headers` point to, with what gave it away. */
export function detectTech(signals: TechSignals, headers: Record<string, string> = {}): Tech[] {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const found: Tech[] = [];
  for (const rule of RULES) {
    const evidence =
      rule.globals?.find((g) => signals.globals.includes(g))?.replace(/^/, "window.") ??
      rule.attributes?.find((a) => signals.attributes.includes(a)) ??
      (rule.scripts && signals.scripts.find((s) => rule.scripts!.test(s))) ??
      (rule.generator && signals.generator.find((g) => rule.generator!.test(g))?.replace(/^/, "generator: ")) ??
      rule.headers
        ?.map(([name, re]) => (h[name] !== undefined && (!re || re.test(h[name]!)) ? `${name}: ${h[name]}` : null))
        .find(Boolean) ??
      (rule.classes?.(signals.classSample) ? "class names" : undefined);
    if (evidence) found.push({ name: rule.name, category: rule.category, evidence: String(evidence).slice(0, 120) });
  }
  const version = signals.attributes.find((a) => a.startsWith("ng-version="));
  const angular = found.find((t) => t.name === "Angular");
  if (version && angular) angular.name = `Angular ${version.split("=")[1]}`;
  return found;
}
