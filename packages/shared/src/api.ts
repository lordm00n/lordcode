/**
 * HTTP API contracts shared between server, TUI, and (future) web UI.
 * Keep this file dependency-free: pure types only.
 */

export interface HealthResponse {
  status: "ok";
  version: string;
  uptimeMs: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface TextPart {
  type: "text";
  text: string;
}

/**
 * Inline image content. `image` is a raw base64 string (no `data:` prefix)
 * and `mediaType` is the IANA type (e.g. `image/png`). Wire shape mirrors
 * Vercel AI SDK's `ImagePart` so the server can hand `messages` directly to
 * `streamText` without translation.
 */
export interface ImagePart {
  type: "image";
  /** Raw base64-encoded image data, no `data:` prefix. */
  image: string;
  /** IANA media type — `image/png`, `image/jpeg`, etc. */
  mediaType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: ChatRole;
  /**
   * Either a plain string (legacy text-only turns) or an ordered list of
   * parts for multimodal turns. Single-modality user turns SHOULD remain a
   * string to keep the wire format compact.
   */
  content: string | ContentPart[];
}

export interface AgentChatRequest {
  messages: ChatMessage[];
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
  | { type: "error"; message: string };

export const API_ROUTES = {
  health: "/health",
  agentChat: "/agent/chat",
  models: "/models",
  currentModel: "/models/current",
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
