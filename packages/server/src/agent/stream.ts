import { streamText as defaultStreamText, type LanguageModel } from "ai";
import type { Logger } from "@lordcode/logger";
import type {
  AgentStreamEvent,
  ChatMessage,
  ModelConfig,
} from "@lordcode/shared";
import type { ConfigStore } from "../config/store.js";
import { resolveApiKey as defaultResolveApiKey } from "./apiKey.js";
import { resolveLanguageModel as defaultResolveLanguageModel } from "./provider.js";

/**
 * One frame of `result.fullStream` that this generator can interpret.
 *
 * The full chunk universe is much larger (text-start, text-end, tool-*, source,
 * file, start, start-step, finish-step, finish, abort, raw, …); we keep the
 * shape loose so the test fakes don't have to model fields we don't read.
 */
export interface FullStreamChunk {
  /** Discriminator — see https://ai-sdk.dev/docs/ai-sdk-core/generating-text#fullstream-property */
  type: string;
  /** Present on `text-delta` and `reasoning-delta`. */
  text?: string;
  /** Present on `error` chunks (fullStream surfaces non-fatal provider errors as data). */
  error?: unknown;
}

/**
 * Anything `streamText` is allowed to return that this generator cares about.
 * Keeps the unit tests unburdened by the full Vercel AI SDK surface.
 */
export interface StreamTextLike {
  fullStream: AsyncIterable<FullStreamChunk>;
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
  /**
   * Channel-rooted logger for this turn. Optional so unit tests don't need to
   * wire one up. Caller convention: pass `serverLog.child("agent").child("stream")`
   * so per-frame debug lines surface as `server:agent:stream`.
   */
  logger?: Logger;
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
  const log = ctx.logger;
  const apiKeyLog = log
    ? // siblings under `server:agent`, not under `server:agent:stream`
      log.child("apikey")
    : undefined;
  const providerLog = log ? log.child("provider") : undefined;

  const cfg = ctx.store.getCurrent();
  if (!cfg) {
    log?.warn("no model selected");
    yield {
      type: "error",
      message: "no model selected (set one with /model <name>)",
    };
    return;
  }

  const resolveKey = ctx.resolveApiKey ?? ((c: ModelConfig) => defaultResolveApiKey(c, apiKeyLog));
  const apiKey = resolveKey(cfg);
  if (apiKey == null) {
    log?.warn("apiKey missing for current model", { model: cfg.name });
    yield {
      type: "error",
      message: missingApiKeyMessage(cfg),
    };
    return;
  }

  if (ctx.signal?.aborted) {
    log?.debug("aborted before stream start");
    return;
  }

  const resolveModel =
    ctx.resolveLanguageModel ?? ((c, k) => defaultResolveLanguageModel(c, k, providerLog));
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
    log?.error("streamText setup failed", err, { model: cfg.name });
    yield { type: "error", message: errorMessage(err) };
    return;
  }

  log?.debug("stream started", {
    model: cfg.name,
    messages: messages.length,
  });
  yield { type: "start", model: cfg.name };

  try {
    for await (const chunk of result.fullStream) {
      if (ctx.signal?.aborted) {
        log?.debug("aborted mid-stream");
        return;
      }
      switch (chunk.type) {
        case "text-delta": {
          const text = chunk.text ?? "";
          if (text.length === 0) break;
          log?.debug("chunk", { type: "text-delta", len: text.length });
          yield { type: "delta", text };
          break;
        }
        case "reasoning-start": {
          log?.debug("chunk", { type: "reasoning-start" });
          yield { type: "reasoning-start" };
          break;
        }
        case "reasoning-delta": {
          const text = chunk.text ?? "";
          if (text.length === 0) break;
          log?.debug("chunk", { type: "reasoning-delta", len: text.length });
          yield { type: "reasoning-delta", text };
          break;
        }
        case "reasoning-end": {
          log?.debug("chunk", { type: "reasoning-end" });
          yield { type: "reasoning-end" };
          break;
        }
        case "error": {
          // `fullStream` surfaces non-fatal provider errors as data instead of throwing.
          // The SDK's event-recorder also enqueues string-typed `error` chunks for
          // its own consistency checks (e.g. reasoning-delta arriving without a
          // preceding reasoning-start — vercel/ai#12054, PR #13110). Those checks
          // run *after* the offending chunk has already been forwarded to us
          // (stream-text.ts forwards at line 870 before validating), so the
          // payload is already in our hands; if we propagate the error we'd kill
          // an otherwise-healthy turn. Treat them as warnings and continue.
          if (isRecoverableSdkError(chunk.error)) {
            log?.debug("chunk: recoverable sdk error (suppressed)", {
              err: errorMessage(chunk.error),
            });
            break; // HACK: This is a workaround for a bug in the SDK.
          }
          log?.warn("chunk: provider error", {
            err: errorMessage(chunk.error),
          });
          yield { type: "error", message: errorMessage(chunk.error) };
          return;
        }
        default:
          // Placeholder: text-start/text-end, tool-input-*, tool-call,
          // tool-result, tool-error, source, file, start, start-step,
          // finish-step, finish, abort, raw — intentionally ignored until
          // later iterations add support.
          break;
      }
    }
  } catch (err) {
    if (ctx.signal?.aborted) {
      log?.debug("threw post-abort, suppressed");
      return;
    }
    log?.error("stream iterator threw", err);
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
  log?.debug("stream finished", {
    ...(finishReason ? { finishReason } : {}),
    ...(finish.usage ? { usage: finish.usage } : {}),
  });
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

/**
 * Recognise SDK-internal consistency-check errors that arrive on `fullStream`
 * but don't actually correspond to a failed turn. These come through with a
 * plain `string` payload (real provider/network errors are Error/object).
 *
 * Currently covers the "reasoning part X not found" / "text part X not found"
 * family from `stream-text.ts` (vercel/ai#12054 + PR #13110, unmerged). Drop
 * this once the upstream fix lands and we bump `ai`.
 */
const RECOVERABLE_SDK_ERROR_RE = /^(reasoning|text) part .+ not found$/;
function isRecoverableSdkError(err: unknown): boolean {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : null;
  return msg != null && RECOVERABLE_SDK_ERROR_RE.test(msg);
}

async function maybeAwait<T>(v: Promise<T> | T | undefined): Promise<T | undefined> {
  if (v == null) return undefined;
  if (typeof (v as Promise<T>).then === "function") return await (v as Promise<T>);
  return v as T;
}
