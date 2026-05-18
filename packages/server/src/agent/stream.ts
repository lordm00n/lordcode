import {
  stepCountIs,
  streamText as defaultStreamText,
  type LanguageModel,
  type StopCondition,
  type ToolSet,
} from "ai";
import type { Logger } from "@lordcode/logger";
import type {
  AgentStreamEvent,
  ModelConfig,
  ModelMessage,
} from "@lordcode/shared";
import type { ConfigStore } from "../config/store.js";
import { buildTools } from "../tools/registry.js";
import { resolveApiKey as defaultResolveApiKey } from "./apiKey.js";
import { resolveLanguageModel as defaultResolveLanguageModel } from "./provider.js";

/**
 * Hard cap on agent loop steps per turn. Prevents the model from looping
 * forever on tool calls. Spec §3 decision #12.
 */
const AGENT_LOOP_MAX_STEPS = 10;

/**
 * Throttle thresholds for `tool-input-progress` debug lines. The SDK emits
 * one `tool-input-delta` per tokenised JSON fragment of a tool call's input,
 * which can be hundreds of frames for a single `write_file` content. We keep
 * one progress line per stream of tool input — emitted at most every
 * `_INTERVAL_MS` OR every `_BYTES`, whichever fires first — so the long
 * silent window between "model decided to call write_file" and "tool-call
 * dispatched" is visible without flooding the log.
 */
const TOOL_INPUT_LOG_INTERVAL_MS = 1000;
const TOOL_INPUT_LOG_BYTES = 64 * 1024;

/**
 * Per-call accumulator for `tool-input-*` streams. Keyed by `chunk.id` (= the
 * future `toolCallId`). Lifecycle: created on `tool-input-start`, updated on
 * each `tool-input-delta`, deleted on `tool-input-end`.
 */
interface ToolInputProgress {
  toolName: string;
  bytes: number;
  startedAt: number;
  lastLoggedAt: number;
  lastLoggedBytes: number;
}

/**
 * One frame of `result.fullStream` that this generator can interpret.
 *
 * The full chunk universe is much larger (source, file, raw, finish, …); we
 * keep the shape loose so the test fakes don't have to model fields we don't
 * read.
 *
 * Field presence by chunk type (see SDK `TextStreamPart`):
 * - `text-delta` / `reasoning-delta` → `text`, `id`
 * - `text-start` / `text-end` / `reasoning-start` / `reasoning-end` → `id`
 * - `tool-input-start` → `id`, `toolName`
 * - `tool-input-delta` → `id`, `delta`
 * - `tool-input-end` → `id`
 * - `tool-call` / `tool-result` / `tool-error` → `toolCallId`, `toolName`,
 *   plus `input` / `output` / `error`
 * - `error` → `error`
 * - `abort` → `reason`
 */
export interface FullStreamChunk {
  /** Discriminator — see https://ai-sdk.dev/docs/ai-sdk-core/generating-text#fullstream-property */
  type: string;
  /** Present on `text-delta` and `reasoning-delta`. */
  text?: string;
  /** Present on `error` chunks (fullStream surfaces non-fatal provider errors as data). */
  error?: unknown;
  /** Present on tool-call / tool-result / tool-error. */
  toolCallId?: string;
  /** Present on text-* / reasoning-* / tool-input-* chunks (= future toolCallId). */
  id?: string;
  /** Present on tool-input-delta. */
  delta?: string;
  /** Present on abort chunks. */
  reason?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
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
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
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
  /**
   * Working directory for any tool execution this turn. Defaults to the
   * server's `process.cwd()`. Tests inject a fixture dir to keep filesystem
   * effects scoped.
   */
  cwd?: string;
  /**
   * Pre-built tool set for this turn. When omitted, `streamAgent` builds the
   * default registry (currently `{ ripgrep }`). Tests pass `{}` to opt out
   * entirely or a fake to assert call shapes.
   */
  tools?: ToolSet;
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
  messages: ModelMessage[],
  ctx: StreamAgentContext,
): AsyncGenerator<AgentStreamEvent, void, void> {
  const log = ctx.logger;
  const apiKeyLog = log
    ? // siblings under `server:agent`, not under `server:agent:stream`
      log.child("apikey")
    : undefined;
  const providerLog = log ? log.child("provider") : undefined;
  const toolLog = log ? log.child("tool") : undefined;

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

  const tools =
    ctx.tools ??
    buildTools({
      cwd: ctx.cwd ?? process.cwd(),
      ...(toolLog ? { logger: toolLog } : {}),
    });

  let result: StreamTextLike;
  try {
    const model = resolveModel(cfg, apiKey);
    result = runStream({
      model,
      messages,
      tools,
      stopWhen: stepCountIs(AGENT_LOOP_MAX_STEPS),
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

  const inputProgress = new Map<string, ToolInputProgress>();

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
        case "text-start": {
          // Bracket marker; UI tracks prose via `text-delta`. Logged for
          // traceability so the order of model-side text/tool-call blocks
          // is reconstructable from `server:agent:stream`.
          log?.debug("chunk", { type: "text-start", id: chunk.id });
          break;
        }
        case "text-end": {
          log?.debug("chunk", { type: "text-end", id: chunk.id });
          break;
        }
        case "tool-input-start": {
          // The model has begun streaming the JSON arguments of a tool call.
          // The matching `tool-call` won't arrive until `tool-input-end`, so
          // for big inputs (e.g. write_file content) this opens a long
          // silent window — start tracking so we can emit progress lines.
          const id = chunk.id ?? "";
          const toolName = chunk.toolName ?? "";
          const now = Date.now();
          inputProgress.set(id, {
            toolName,
            bytes: 0,
            startedAt: now,
            lastLoggedAt: now,
            lastLoggedBytes: 0,
          });
          log?.debug("chunk", { type: "tool-input-start", id, toolName });
          break;
        }
        case "tool-input-delta": {
          // Throttled: emit at most one `tool-input-progress` line per
          // TOOL_INPUT_LOG_INTERVAL_MS or every TOOL_INPUT_LOG_BYTES of
          // accumulated wire bytes (whichever first). Logging every delta
          // would flood the channel — a single write_file can be 1000+ frames.
          const id = chunk.id ?? "";
          const entry = inputProgress.get(id);
          if (!entry) break;
          entry.bytes += Buffer.byteLength(chunk.delta ?? "", "utf8");
          const now = Date.now();
          const sinceLogged = entry.bytes - entry.lastLoggedBytes;
          if (
            now - entry.lastLoggedAt >= TOOL_INPUT_LOG_INTERVAL_MS ||
            sinceLogged >= TOOL_INPUT_LOG_BYTES
          ) {
            log?.debug("chunk", {
              type: "tool-input-progress",
              id,
              toolName: entry.toolName,
              bytes: entry.bytes,
              elapsedMs: now - entry.startedAt,
            });
            entry.lastLoggedAt = now;
            entry.lastLoggedBytes = entry.bytes;
          }
          break;
        }
        case "tool-input-end": {
          const id = chunk.id ?? "";
          const entry = inputProgress.get(id);
          if (entry) {
            log?.debug("chunk", {
              type: "tool-input-end",
              id,
              toolName: entry.toolName,
              bytes: entry.bytes,
              elapsedMs: Date.now() - entry.startedAt,
            });
            inputProgress.delete(id);
          } else {
            log?.debug("chunk", { type: "tool-input-end", id });
          }
          break;
        }
        case "tool-call": {
          // SDK guarantees these fields on `tool-call`; log + forward verbatim.
          // We propagate `input` as-is (`unknown` on the wire) so the TUI can
          // render per-`toolName` without a typed-by-name barrier here.
          const toolCallId = chunk.toolCallId ?? "";
          const toolName = chunk.toolName ?? "";
          log?.debug("chunk", { type: "tool-call", toolCallId, toolName });
          yield {
            type: "tool-call",
            toolCallId,
            toolName,
            input: chunk.input,
          };
          break;
        }
        case "tool-result": {
          const toolCallId = chunk.toolCallId ?? "";
          const toolName = chunk.toolName ?? "";
          log?.debug("chunk", { type: "tool-result", toolCallId, toolName });
          yield {
            type: "tool-result",
            toolCallId,
            toolName,
            output: chunk.output,
          };
          break;
        }
        case "tool-error": {
          const toolCallId = chunk.toolCallId ?? "";
          const toolName = chunk.toolName ?? "";
          const message = errorMessage(chunk.error);
          log?.warn("chunk: tool-error", { toolCallId, toolName, message });
          yield {
            type: "tool-error",
            toolCallId,
            toolName,
            message,
          };
          break;
        }
        case "start-step":
        case "finish-step": {
          // Step boundaries inside the agent tool loop — useful when reading
          // the log to tell which iteration produced which tool-call. We
          // intentionally don't lift them onto the wire (TUI doesn't render
          // step structure separately).
          log?.debug("chunk", { type: chunk.type });
          break;
        }
        case "abort": {
          log?.debug("chunk", { type: "abort", reason: chunk.reason });
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
          // Remaining placeholders: `start` and `finish` (we synthesise our
          // own equivalents around the loop), plus `source`, `file`,
          // `tool-output-denied`, `tool-approval-request`, `raw` — none are
          // surfaced to the wire yet and not interesting enough to log on
          // their own.
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
