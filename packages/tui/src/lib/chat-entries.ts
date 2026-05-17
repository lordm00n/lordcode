/**
 * Conversation entry model + the small reducers that decide how a streaming
 * agent turn is sliced into entries.
 *
 * Why split a single agent turn across multiple `MessageEntry`s
 * ------------------------------------------------------------
 * A turn that calls tools looks like:
 *
 *   reasoning? → text? → tool-call → tool-result → text? → tool-call → ...
 *               ──────────────────                ──────
 *                  segment 1                      segment 2
 *
 * If we hold all assistant text in a single floating `StreamingState` until
 * `finish`, every tool entry the reducer pushes into `entries` lands ABOVE
 * the live text panel — the UI ends up with tools stacked at the top of the
 * turn and the prose at the bottom, in the wrong logical order.
 *
 * Instead, on every `tool-call` we *flush* the current streaming state into
 * its own `MessageEntry` (the "segment") and reset the live panel so the
 * next text deltas accumulate fresh below the tool entry. The wire format
 * we ship back to the server collapses those segments back into a single
 * assistant message — see {@link collapseMessageEntries}.
 */
import type { ChatMessage } from "@lordcode/shared";

export interface SystemEntry {
  kind: "system";
  tone: "info" | "error";
  content: string;
}

export interface MessageEntry extends ChatMessage {
  kind: "msg";
  /**
   * Total wall-clock time the model spent in reasoning blocks during the
   * portion of the turn that this segment covers. Only set on assistant
   * entries that actually had at least one reasoning chunk; absent for
   * plain text-only segments.
   */
  reasoningDurationMs?: number;
}

/**
 * One tool invocation in the conversation. Mounted as `phase: "call"` when
 * the `tool-call` chunk arrives, then upgraded in-place to `"result"` or
 * `"error"` when the matching `tool-result` / `tool-error` arrives (matched
 * by `toolCallId`). Server contract guarantees the matching chunk shows up
 * in the same turn, so leaving it stuck on `"call"` would only happen on a
 * transport failure — same blast radius as a half-streamed assistant message.
 */
export interface ToolEntry {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  input: unknown;
  phase: "call" | "result" | "error";
  /** Populated when phase = "result". */
  output?: unknown;
  /** Populated when phase = "error". */
  errorMessage?: string;
}

export type Entry = MessageEntry | SystemEntry | ToolEntry;

/**
 * Build a `MessageEntry` from the live streaming state at the moment a turn
 * is about to be split (either by a `tool-call` mid-turn or by `finish`).
 *
 * Returns `null` if there's nothing worth emitting — no text and no
 * reasoning either streamed or measured. This keeps us from littering the
 * transcript with empty `ai · ` rows.
 *
 * Note: callers should `closeReasoning()` *before* invoking this so the
 * in-flight reasoning block's wall-clock has already been folded into
 * `reasoningDurationMs`.
 */
export function buildAssistantSegment(
  text: string,
  reasoningDurationMs: number | null,
): MessageEntry | null {
  if (text.length === 0 && reasoningDurationMs == null) return null;
  const entry: MessageEntry = {
    kind: "msg",
    role: "assistant",
    content: text,
  };
  if (reasoningDurationMs != null) {
    entry.reasoningDurationMs = reasoningDurationMs;
  }
  return entry;
}

/**
 * Locate a {@link ToolEntry} by `toolCallId` and return a new entries array
 * with that entry transformed by `update`. If no entry matches, append
 * `fallback` instead — defensive against transport drops where a
 * `tool-result` arrives without its preceding `tool-call`.
 */
export function upgradeToolEntry(
  prev: Entry[],
  toolCallId: string,
  update: (entry: ToolEntry) => ToolEntry,
  fallback: ToolEntry,
): Entry[] {
  let found = false;
  const next = prev.map((e) => {
    if (e.kind === "tool" && e.toolCallId === toolCallId) {
      found = true;
      return update(e);
    }
    return e;
  });
  return found ? next : [...next, fallback];
}

/**
 * Collapse the multi-segment view we keep in `entries` back into the
 * single-message-per-turn wire shape the server expects.
 *
 * Consecutive assistant entries with plain-string content (the only shape
 * the model emits) are concatenated into one. We deliberately leave
 * `ContentPart[]` content alone — that only happens on user turns today
 * (pasted images) and concatenating those would lose the structure.
 *
 * Reasoning duration is UI-only metadata and intentionally NOT replayed
 * across turns; the model already produced reasoning once and re-feeding
 * the summary would just be lossy noise.
 */
export function collapseMessageEntries(
  entries: MessageEntry[],
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const e of entries) {
    const last = result[result.length - 1];
    if (
      last != null &&
      last.role === "assistant" &&
      e.role === "assistant" &&
      typeof last.content === "string" &&
      typeof e.content === "string"
    ) {
      last.content = last.content + e.content;
      continue;
    }
    result.push({ role: e.role, content: e.content });
  }
  return result;
}
