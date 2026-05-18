/**
 * HTTP API contracts shared between server, TUI, and (future) web UI.
 *
 * Wire format = Vercel AI SDK's `ModelMessage` (system / user / assistant /
 * tool). Importing as `type` keeps shared free of any runtime dependency on
 * the `ai` package — tsc emits the re-exports as pure type aliases.
 */

import type {
  AssistantContent,
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  ToolCallPart,
  ToolContent,
  ToolModelMessage,
  ToolResultPart,
  UserContent,
  UserModelMessage,
} from "ai";

export type {
  AssistantContent,
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  ToolCallPart,
  ToolContent,
  ToolModelMessage,
  ToolResultPart,
  UserContent,
  UserModelMessage,
};

/**
 * Output shape of a `tool-result` part. Re-exported from `ai` via the
 * `ToolResultPart["output"]` field (the SDK's `ToolResultOutput` type itself
 * is not surfaced from the top-level `ai` package barrel).
 */
export type ToolResultOutput = ToolResultPart["output"];

export interface HealthResponse {
  status: "ok";
  version: string;
  uptimeMs: number;
}

/**
 * Soft backward-compat alias. The wire format is now SDK-native — `ChatMessage`
 * remains exported so existing callers (and any future external clients we add
 * before the migration completes) compile unchanged.
 */
export type ChatMessage = ModelMessage;

/**
 * Convenience alias mirroring the subset of {@link UserContent} parts that
 * the TUI's paste flow actually emits today (text + inline base64 image).
 * Keeps `composeContent` strongly typed without forcing it to widen to the
 * full `UserContent` element union.
 */
export type ContentPart = TextPart | ImagePart;

export interface AgentChatRequest {
  /**
   * Full conversation history this turn should be evaluated against. The
   * client is the source of truth: server is stateless and feeds this array
   * directly to `streamText({ messages })`.
   */
  messages: ModelMessage[];
}

/**
 * One frame on the SSE stream emitted by `POST /agent/chat`.
 * Carried as a single `data:` field whose body is `JSON.stringify(AgentStreamEvent)`.
 *
 * Invariants:
 * - `start` is the first frame on a successful run (configuration errors may emit only `error`).
 * - `finish` and `error` are mutually exclusive; the stream terminates with one of them.
 * - `delta` carries final response text; `reasoning-delta` carries the model's thinking
 *   (e.g. extended-thinking / o1-style). Both may interleave during a single turn.
 * - `reasoning-start` / `reasoning-end` bracket a reasoning block so the UI can switch
 *   between a "Thinking..." indicator and a final "Thought for Xs" summary. Each turn may
 *   contain zero or more reasoning blocks; deltas without a wrapping start/end pair can
 *   still arrive (e.g. older providers) and the UI must tolerate them.
 *
 * Tool events (multi-step agent loop):
 * - `tool-call` precedes its paired `tool-result` / `tool-error` (matched by `toolCallId`).
 * - A single turn may emit multiple tool calls; they freely interleave with `delta` /
 *   `reasoning-*` from the same agent loop.
 * - `input` / `output` are wire-`unknown`: the server emits whatever the tool produced,
 *   the client decides per-`toolName` how to render. (First wave: `toolName === "ripgrep"`.)
 * - `tool-error` carries a `message: string` collapsed from the raw provider/tool error;
 *   the SDK feeds it back to the model so the agent loop can continue.
 */
export type AgentStreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | {
      type: "finish";
      finishReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      aborted?: boolean;
    }
  | { type: "error"; message: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; toolName: string; message: string };

export const API_ROUTES = {
  health: "/health",
  agentChat: "/agent/chat",
  models: "/models",
  currentModel: "/models/current",
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
