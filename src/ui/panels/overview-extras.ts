// The Overview's rows for the landmarks, the dataLayer and agent readiness: each read as its panel reads it, summed
// up in one line, with the panel's "Copy for agent" report for the fix list and the print page.
import { useMemo } from "react";
import { readinessMarkdown } from "../../lib/agent/agents";
import { dataLayerMarkdown, landmarksMarkdown } from "../../lib/agent/inspect";
import type { PagePart } from "../../lib/agent/page";
import { fetchLlmsTxt } from "../../lib/agent-files";
import { analyzeDataLayer } from "../../lib/datalayer";
import { analyzeJsonLd } from "../../lib/jsonld";
import { isLandmarkExposed, landmarkIssues } from "../../lib/landmarks";
import type { MetaSnapshot } from "../../lib/page/collect";
import { readDataLayer } from "../../lib/page/datalayer";
import type { RawHeading } from "../../lib/page/headings";
import { collectLandmarks } from "../../lib/page/landmarks";
import { collectSemantics, collectWebMcp } from "../../lib/page/webmcp";
import { type ReadinessInputs, readinessScore } from "../../lib/readiness";
import { dataLayerVerdict, landmarksVerdict, readinessVerdict, type Verdict } from "../../lib/report";
import { analyzeTools } from "../../lib/webmcp";
import { type AsyncState, useAsync } from "../hooks";
import { useInPage, usePage } from "../page";

export interface OverviewRow {
  panel: string;
  label: string;
  state: { loading: boolean; error: unknown };
  verdict: Verdict | null;
}

const notRead = (s: { error: unknown }) => (s.error instanceof Error ? s.error.message : "not read yet");

export function useOverviewExtras(meta: AsyncState<MetaSnapshot>, headings: RawHeading[] | undefined) {
  const page = usePage();
  const landmarks = useInPage(collectLandmarks);
  // Read-only, in the page's world (like the dataLayer panel); masked by analyzeDataLayer before anything is shown.
  const dataLayer = useInPage(readDataLayer, [], "MAIN");
  const webmcp = useInPage(collectWebMcp, [], "MAIN");
  const semantics = useInPage(collectSemantics);
  // The score counts one agent file, /llms.txt (robots.txt, ai.txt and the sitemap only add recommendations, in the
  // Agent readiness panel). Fetched lazily, once the in-page reads are done, so it never competes with them.
  const inPage = Boolean(webmcp.data && semantics.data);
  const llms = useAsync(
    async () => (page.origin && page.canScript ? fetchLlmsTxt(page.origin) : null),
    [page.origin, page.canScript, inPage],
    inPage,
  );

  const lmIssues = useMemo(() => (landmarks.data ? landmarkIssues(landmarks.data, headings) : []), [landmarks.data, headings]);
  const analysis = useMemo(() => (dataLayer.data ? analyzeDataLayer(dataLayer.data) : null), [dataLayer.data]);
  const tools = useMemo(() => (webmcp.data ? analyzeTools(webmcp.data.tools) : []), [webmcp.data]);
  const ready = Boolean(meta.data && webmcp.data && semantics.data && llms.data !== undefined);
  // As the Agent readiness panel scores it: the JSON-LD without the vocabulary check.
  const inputs = useMemo<ReadinessInputs | null>(
    () =>
      ready
        ? {
            jsonLd: meta.data ? analyzeJsonLd(meta.data.jsonLd) : null,
            webmcp: webmcp.data ?? null,
            tools,
            semantics: semantics.data ?? null,
            llms: llms.data ?? undefined,
          }
        : null,
    [ready, meta.data, webmcp.data, tools, semantics.data, llms.data],
  );
  const score = useMemo(() => (inputs ? readinessScore(inputs) : null), [inputs]);
  const readinessError = meta.error ?? webmcp.error ?? semantics.error ?? llms.error;

  const rows: OverviewRow[] = [
    {
      panel: "headings",
      label: "Landmarks",
      state: landmarks,
      verdict: landmarks.data ? landmarksVerdict(lmIssues, landmarks.data.landmarks.filter(isLandmarkExposed).length) : null,
    },
    { panel: "datalayer", label: "dataLayer", state: dataLayer, verdict: analysis ? dataLayerVerdict(analysis) : null },
    {
      panel: "agent-readiness",
      label: "Agent readiness",
      state: {
        loading: !score && !readinessError && (meta.loading || webmcp.loading || semantics.loading || llms.loading || !ready),
        error: score ? null : readinessError,
      },
      verdict: score ? readinessVerdict(score, tools.length) : null,
    },
  ];

  const parts = (ctx: { url: string }): PagePart[] => [
    {
      area: "Landmarks",
      panel: "Inspect › Headings",
      md: landmarks.data ? landmarksMarkdown(landmarks.data, ctx, headings) : null,
      missing: notRead(landmarks),
    },
    {
      area: "dataLayer",
      panel: "Inspect › dataLayer",
      md: analysis ? dataLayerMarkdown(analysis, ctx) : null,
      missing: notRead(dataLayer),
    },
    {
      area: "Agent readiness",
      panel: "Inspect › Agent readiness",
      md: score && inputs ? readinessMarkdown(score, inputs, ctx) : null,
      missing: readinessError instanceof Error ? readinessError.message : "not read yet",
    },
  ];

  const refresh = () => {
    for (const s of [landmarks, dataLayer, webmcp, semantics]) s.run();
    if (inPage) llms.run();
  };

  return { rows, parts, refresh };
}
