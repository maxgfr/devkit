import type { CatalogModelInfo } from "llm-connect";
import type { UnifiedModel } from "llm-models";

let models: Promise<UnifiedModel[]> | null = null;

/** The full llm-models catalog (prices, limits, modalities), loaded on first use. */
export function unifiedModels(): Promise<UnifiedModel[]> {
  models ??= import("llm-models")
    .then((m) => m.fetchUnifiedModels())
    .catch((e) => {
      models = null;
      throw e;
    });
  return models;
}

const bare = (id: string) =>
  id
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/[-_.:]/g, "");

/** The catalog entry of `modelId` from `providerId`, as llm-connect's `CatalogModelInfo`. */
export function catalogInfo(all: UnifiedModel[], providerId: string | undefined, modelId: string): CatalogModelInfo | undefined {
  const exact = all.find((m) => m.id === modelId && (!providerId || m.provider === providerId));
  const loose =
    exact ??
    all.find((m) => bare(m.id) === bare(modelId) && (!providerId || m.provider === providerId)) ??
    all.find((m) => bare(m.id) === bare(modelId));
  if (!loose) return undefined;
  return {
    id: loose.id,
    name: loose.name,
    contextWindow: loose.context_length,
    maxOutput: loose.output_limit,
    input: loose.modalities.input,
    reasoning: loose.capabilities.reasoning,
    toolCall: loose.capabilities.tool_call,
    cost: loose.cost
      ? { input: loose.cost.input, output: loose.cost.output, cacheRead: loose.cost.cache_read, cacheWrite: loose.cost.cache_write }
      : undefined,
  };
}

/** USD for a call, with costs in USD per million tokens. */
export function estimateCost(
  cost: { input: number; output: number } | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!cost) return null;
  return (inputTokens * cost.input + outputTokens * cost.output) / 1_000_000;
}

export const formatUsd = (n: number | null) =>
  n === null ? "unknown" : n === 0 ? "free" : n < 0.01 ? `<$0.01` : `$${n.toFixed(n < 1 ? 3 : 2)}`;
