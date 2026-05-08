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

export interface ChatMessage {
  role: ChatRole;
  content: string;
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
 */
export type AgentStreamEvent =
  | { type: "start"; model: string }
  | { type: "delta"; text: string }
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
