import { lazy, type ComponentType } from "react";
import { A11yAudit } from "./a11y";
import { DataLayer } from "./datalayer";
import { AgentReadiness, AgentTools } from "./agents";
import { CacheActions, Cookies, SiteData, Storage } from "./cache";
import { Errors, External, Fonts, Headers, JsonLd, Links, Overview, Perf, SiteFiles } from "./inspect";
import { Seo } from "./seo";
import { ElementPicker } from "./element";
import { Headings } from "./headings";
import { Mocks } from "./mocks";
import { Assets } from "./assets";
import { Measure } from "./measure";
import { Envs, Rules } from "./network";
import { Emulation, Forms, PageTools, Screenshot, Viewport } from "./page-tools";
import { RepoDeps } from "./repo-deps";
import { Redirects } from "./redirects";
import { Responsiveness } from "./responsiveness";
import { BugReport } from "./report";
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
  headings: Headings,
  jsonld: JsonLd,
  datalayer: DataLayer,
  headers: Headers,
  perf: Perf,
  responsiveness: Responsiveness,
  errors: Errors,
  links: Links,
  fonts: Fonts,
  a11y: A11yAudit,
  "site-files": SiteFiles,
  "repo-deps": RepoDeps,
  "agent-tools": AgentTools,
  "agent-readiness": AgentReadiness,
  external: External,
  secrets: Secrets,
  exposed: Exposed,
  "third-parties": ThirdParties,
  libraries: VulnerableLibraries,
  csp: Csp,
  element: ElementPicker,
  measure: Measure,
  assets: Assets,
  "page-tools": PageTools,
  emulation: Emulation,
  viewport: Viewport,
  screenshot: Screenshot,
  forms: Forms,
  rules: Rules,
  mocks: Mocks,
  envs: Envs,
  redirects: Redirects,
  ask: Ask,
  report: BugReport,
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
