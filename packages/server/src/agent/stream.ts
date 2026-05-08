import { streamText as defaultStreamText, type LanguageModel } from "ai";
import type {
  AgentStreamEvent,
  ChatMessage,
  ModelConfig,
} from "@lordcode/shared";
import type { ConfigStore } from "../config/store.js";
import { resolveApiKey as defaultResolveApiKey } from "./apiKey.js";
import { resolveLanguageModel as defaultResolveLanguageModel } from "./provider.js";

/**
 * Anything `streamText` is allowed to return that this generator cares about.
 * Keeps the unit tests unburdened by the full Vercel AI SDK surface.
 */
export interface StreamTextLike {
  textStream: AsyncIterable<string>;
  finishReason?: Promise<string | undefined> | string | undefined;
  usage?:
    | Promise<{ inputTokens?: number; outputTokens?: number } | undefined>
    | { inputTokens?: number; outputTokens?: number }
    | undefined;
}

export type StreamTextFn = (args: {
  model: LanguageModel;
  messages: ChatMessage[];
  abortSignal?: AbortSignal;
}) => StreamTextLike;

export interface StreamAgentContext {
  store: Pick<ConfigStore, "getCurrent">;
  signal?: AbortSignal;
  /** test seam: override how the LanguageModel is constructed */
  resolveLanguageModel?: (cfg: ModelConfig, apiKey: string) => LanguageModel;
  /** test seam: override apiKey resolution */
  resolveApiKey?: (cfg: ModelConfig) => string | null;
  /** test seam: override the streamText implementation */
  streamText?: StreamTextFn;
}

/**
 * Drive a single chat turn against the currently-selected model.
 *
 * Emission rules (mirrors spec §6.2.2):
 * - No current model     → `error` only.
 * - apiKey missing       → `error` only (message includes apiKeyEnv name if set).
 * - Happy path           → `start` → many `delta` → `finish`.
 * - streamText throws    → already-emitted partial frames are kept, then `error`.
 * - external abort       → no further frames after the cancellation point.
 */
export async function* streamAgent(
  messages: ChatMessage[],
  ctx: StreamAgentContext,
): AsyncGenerator<AgentStreamEvent, void, void> {
  const cfg = ctx.store.getCurrent();
  if (!cfg) {
    yield {
      type: "error",
      message: "no model selected (set one with /model <name>)",
    };
    return;
  }

  const resolveKey = ctx.resolveApiKey ?? defaultResolveApiKey;
  const apiKey = resolveKey(cfg);
  if (apiKey == null) {
    yield {
      type: "error",
      message: missingApiKeyMessage(cfg),
    };
    return;
  }

  if (ctx.signal?.aborted) {
    return;
  }

  const resolveModel = ctx.resolveLanguageModel ?? defaultResolveLanguageModel;
  const runStream =
    ctx.streamText ?? (defaultStreamText as unknown as StreamTextFn);

  let result: StreamTextLike;
  try {
    const model = resolveModel(cfg, apiKey);
    result = runStream({
      model,
      messages,
      ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
    });
  } catch (err) {
    yield { type: "error", message: errorMessage(err) };
    return;
  }

  yield { type: "start", model: cfg.name };

  try {
    for await (const chunk of result.textStream) {
      if (ctx.signal?.aborted) return;
      if (chunk.length === 0) continue;
      yield { type: "delta", text: chunk };
    }
  } catch (err) {
    if (ctx.signal?.aborted) return;
    yield { type: "error", message: errorMessage(err) };
    return;
  }

  if (ctx.signal?.aborted) return;

  const finishReason = await maybeAwait(result.finishReason);
  const usage = await maybeAwait(result.usage);
  const finish: Extract<AgentStreamEvent, { type: "finish" }> = {
    type: "finish",
  };
  if (finishReason) finish.finishReason = finishReason;
  if (usage) {
    const cleaned: { inputTokens?: number; outputTokens?: number } = {};
    if (typeof usage.inputTokens === "number")
      cleaned.inputTokens = usage.inputTokens;
    if (typeof usage.outputTokens === "number")
      cleaned.outputTokens = usage.outputTokens;
    if (Object.keys(cleaned).length > 0) finish.usage = cleaned;
  }
  yield finish;
}

function missingApiKeyMessage(cfg: ModelConfig): string {
  if (cfg.apiKeyEnv) {
    return `missing apiKey for ${cfg.name} (set env ${cfg.apiKeyEnv} or apiKey in config)`;
  }
  return `missing apiKey for ${cfg.name} (set env or apiKey in config)`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function maybeAwait<T>(v: Promise<T> | T | undefined): Promise<T | undefined> {
  if (v == null) return undefined;
  if (typeof (v as Promise<T>).then === "function") return await (v as Promise<T>);
  return v as T;
}
