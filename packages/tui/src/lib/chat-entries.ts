/**
 * UI-facing entry model produced by {@link import("./derive-entries.js").deriveEntries}.
 *
 * The TUI renders three kinds of rows:
 *  - `MessageEntry`: a user / assistant / system text bubble (the assistant
 *    side is purely a UI projection of one `AssistantModelMessage`).
 *  - `ToolEntry`: a single tool invocation, with its lifecycle phase folded
 *    in (`call` → `result` | `error`).
 *  - `SystemEntry`: a TUI-emitted note (e.g. `/model switched`, error frames).
 *    Distinct from a `MessageEntry` with `role === "system"`: SystemEntry is
 *    not part of the conversation wire format, it is local UI chrome.
 *
 * The canonical conversation state lives in `ModelMessage[]` (see the
 * accumulator in `history-accumulator.ts`). MessageEntry / ToolEntry are
 * *derived* projections — never authored directly.
 */
import type { UserContent } from "@lordcode/shared";

export interface SystemEntry {
  kind: "system";
  tone: "info" | "error";
  content: string;
}

/**
 * A single conversation bubble in the TUI.
 *
 * `content` mirrors the user/assistant content shape from
 * `@lordcode/shared`: a plain string for text-only turns or a part array for
 * multimodal turns. The assistant projection is always a string (see
 * `deriveEntries`) — only user turns currently surface arrays (pasted
 * images).
 */
export interface MessageEntry {
  kind: "msg";
  role: "user" | "assistant" | "system";
  content: string | UserContent;
  /**
   * Wall-clock time the model spent in reasoning blocks for the live in-flight
   * turn. Persisted only on the streaming overlay; past assistant entries do
   * not carry this (reasoning is intentionally not stored in history — see
   * `docs/spec/conversation-history/design.md` §3 decision #12).
   */
  reasoningDurationMs?: number;
}

/**
 * One tool invocation in the conversation. Constructed from one
 * `ToolCallPart` in the assistant message, paired with the matching
 * `ToolResultPart` in the following `ToolModelMessage` if present.
 *
 * `phase` reflects the rendering state at derive-time:
 *  - `"call"`   : tool-call without a matching tool-result yet (orphan)
 *  - `"result"` : tool-result present and successful
 *  - `"error"`  : tool-result present but the accumulator synthesised it from
 *                 a tool-error event (or the SDK emitted error-text/error-json)
 */
export interface ToolEntry {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  input: unknown;
  phase: "call" | "result" | "error";
  /** Populated when phase = "result"; unwrapped from `ToolResultOutput.value`. */
  output?: unknown;
  /** Populated when phase = "error"; lifted from the synthesised payload. */
  errorMessage?: string;
}

export type Entry = MessageEntry | SystemEntry | ToolEntry;
