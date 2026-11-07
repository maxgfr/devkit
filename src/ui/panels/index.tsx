import { lazy, type ComponentType } from "react";
import { CacheActions, Cookies, SiteData, Storage } from "./cache";
import { A11y, Errors, External, Fonts, Headers, JsonLd, Links, Overview, Perf, Seo, SiteFiles } from "./inspect";
import { ElementPicker } from "./element";
import { Mocks } from "./mocks";
import { Envs, Rules } from "./network";
import { Emulation, Forms, PageTools, Screenshot, Viewport } from "./page-tools";
import { Csp, Exposed, Secrets, ThirdParties } from "./security";
import { StorageUsage } from "./usage";
import { Color, Cron, Diff, Encode, Hash, Ids, Json, Jwt, Qr, Regex, Time, UrlTool } from "./utils";

const Ask = lazy(() => import("./ai").then((m) => ({ default: m.Ask })));
const Models = lazy(() => import("./ai").then((m) => ({ default: m.Models })));
const AiSettings = lazy(() => import("./ai").then((m) => ({ default: m.AiSettings })));
const VulnerableLibraries = lazy(() => import("./libraries").then((m) => ({ default: m.VulnerableLibraries })));

export type PanelProps = { params?: Record<string, string> };

export const PANEL_COMPONENTS: Record<string, ComponentType<PanelProps>> = {
  "cache-actions": CacheActions,
  usage: StorageUsage,
  "site-data": SiteData,
  cookies: Cookies,
  storage: Storage,
  overview: Overview,
  seo: Seo,
  jsonld: JsonLd,
  headers: Headers,
  perf: Perf,
  errors: Errors,
  links: Links,
  fonts: Fonts,
  a11y: A11y,
  "site-files": SiteFiles,
  external: External,
  secrets: Secrets,
  exposed: Exposed,
  "third-parties": ThirdParties,
  libraries: VulnerableLibraries,
  csp: Csp,
  element: ElementPicker,
  "page-tools": PageTools,
  emulation: Emulation,
  viewport: Viewport,
  screenshot: Screenshot,
  forms: Forms,
  rules: Rules,
  mocks: Mocks,
  envs: Envs,
  ask: Ask,
  models: Models,
  "ai-settings": AiSettings as ComponentType<PanelProps>,
  json: Json,
  jwt: Jwt,
  encode: Encode,
  hash: Hash,
  ids: Ids,
  time: Time,
  regex: Regex,
  diff: Diff,
  color: Color,
  cron: Cron,
  url: UrlTool,
  qr: Qr,
};
