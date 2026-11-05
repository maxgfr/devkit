import type { ModelMessage } from "ai";
import {
  type Capabilities,
  callOptions,
  callProblem,
  describeError,
  type Effort,
  type LlmSettings,
  languageName,
  loadModel,
  providerKindOf,
  resolveCapabilities,
  stopReasonOf,
  webSearchTools,
} from "llm-connect";
import { catalogInfo, unifiedModels } from "./catalog";

export interface StreamHandlers {
  onText: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface StreamOutcome {
  messages: ModelMessage[];
  stop: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

/** Capabilities of the configured model, with limits and prices from llm-models when it loads. */
export async function capabilitiesOf(settings: LlmSettings): Promise<Capabilities> {
  const kind = providerKindOf(settings);
  const modelId = settings.customModel || settings.model;
  let catalog: ReturnType<typeof catalogInfo>;
  try {
    catalog = catalogInfo(await unifiedModels(), settings.providerId, modelId);
  } catch {
    catalog = undefined;
  }
  return resolveCapabilities({ kind, modelId, catalog });
}

export function systemPrompt(base: string, settings: LlmSettings): string {
  return settings.language ? `${base}\nWrite your answer in ${languageName(settings.language)}.` : base;
}

/**
 * Streams one answer. `messages` is the whole conversation so far (the last one from the user);
 * the outcome's `messages` are the turns to append (assistant, with reasoning to replay).
 */
export async function streamAnswer(
  settings: LlmSettings,
  system: string,
  messages: ModelMessage[],
  options: { effort?: Effort | null; webSearch?: boolean; capabilities: Capabilities; signal?: AbortSignal },
  handlers: StreamHandlers,
): Promise<StreamOutcome> {
  const { streamText } = await import("ai");
  const { capabilities } = options;
  const effort = options.effort && capabilities.effort.levels.includes(options.effort) ? options.effort : null;
  const webSearch = Boolean(options.webSearch && capabilities.webSearch);
  const instructions = systemPrompt(system, settings);
  // AI SDK v7 takes the system prompt apart from the messages; callProblem still checks it as the first message.
  const problem = callProblem(
    settings,
    { messages: [{ role: "system", content: instructions }, ...messages], effort, webSearch },
    capabilities,
  );
  if (problem) return { messages: [], stop: "error", error: problem.message };
  try {
    const tools = webSearch ? await webSearchTools(capabilities.webSearch, { maxUses: 3 }) : undefined;
    const result = streamText({
      model: await loadModel(settings),
      system: instructions,
      messages,
      abortSignal: options.signal,
      ...(tools && Object.keys(tools).length ? { tools } : {}),
      ...callOptions(settings, { effort, capabilities }),
    } as Parameters<typeof streamText>[0]);
    let streamError: unknown = null;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") handlers.onText(part.text);
      else if (part.type === "reasoning-delta") handlers.onReasoning?.(part.text);
      else if (part.type === "error") streamError = part.error;
    }
    if (streamError) throw streamError;
    const [responseMessages, finishReason, rawFinishReason, usage] = await Promise.all([
      result.responseMessages,
      result.finishReason,
      result.rawFinishReason,
      result.totalUsage,
    ]);
    return {
      messages: responseMessages as ModelMessage[],
      stop: stopReasonOf(providerKindOf(settings), finishReason, rawFinishReason),
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    };
  } catch (error) {
    if (options.signal?.aborted) return { messages: [], stop: "aborted" };
    return { messages: [], stop: "error", error: describeError(error, settings.apiKey).message };
  }
}
