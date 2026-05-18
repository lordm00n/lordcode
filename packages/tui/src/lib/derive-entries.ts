/**
 * Project a canonical `ModelMessage[]` history into the UI's `Entry[]` shape.
 *
 * Pure function — no React, no Date.now(). All UI-only state (live streaming
 * text, reasoning timer) lives on App.tsx; this module just answers
 * "given history, what does the entries list look like?".
 *
 * Mapping rules (mirrors §5.3 of the conversation-history spec):
 *
 * - SystemModelMessage / UserModelMessage → one MessageEntry as-is.
 * - AssistantModelMessage:
 *     - `content: string` → one MessageEntry with that string.
 *     - `content: array`  → at most ONE text MessageEntry (concatenation of
 *       every TextPart, in source order) PLUS one ToolEntry per ToolCallPart.
 *       The text entry is emitted BEFORE the tool entries to preserve the
 *       "prose, then tool invocation" reading order (this is also the source
 *       order most providers emit anyway).
 * - ToolModelMessage → not yielded directly; its ToolResultPart payloads are
 *   merged into the preceding assistant's ToolEntry(s) by `toolCallId`.
 *
 * Tool result reconciliation:
 *   - If a matching result is present → ToolEntry.phase = "result", with the
 *     SDK's tagged output unwrapped back to its raw JSON value so existing
 *     formatters (`formatToolResult`) keep working on the same shape they
 *     received on the wire.
 *   - If the matching result was synthesised by tool-error folding
 *     (output = { type: "json", value: { error, errored: true } }) → phase
 *     becomes "error" with `errorMessage` lifted out of the payload.
 *   - If no matching result is present (orphan tool-call from an aborted
 *     turn, before `repairOrphanToolCalls` patches it for sending) → phase
 *     stays "call".
 */
import type {
  AssistantModelMessage,
  ModelMessage,
  ToolCallPart,
  ToolModelMessage,
  ToolResultOutput,
  ToolResultPart,
} from "@lordcode/shared";
import type { Entry, ToolEntry } from "./chat-entries.js";

export function deriveEntries(history: ModelMessage[]): Entry[] {
  return deriveEntriesWithBoundaries(history).entries;
}

/**
 * Same projection as {@link deriveEntries} plus a parallel array recording,
 * for each input message, how many derived entries it contributed. Used by
 * App.tsx to interleave TUI-local system notes (errors / `/model` output)
 * at the correct conversational position without re-deriving by hand.
 */
export function deriveEntriesWithBoundaries(history: ModelMessage[]): {
  entries: Entry[];
  /** Same length as `history`; sums to `entries.length`. */
  entriesPerMessage: number[];
} {
  const entries: Entry[] = [];
  const entriesPerMessage: number[] = new Array(history.length).fill(0);

  for (let i = 0; i < history.length; i++) {
    const before = entries.length;
    appendDerivedForMessage(entries, history, i);
    entriesPerMessage[i] = entries.length - before;
  }

  return { entries, entriesPerMessage };
}

function appendDerivedForMessage(
  out: Entry[],
  history: ModelMessage[],
  i: number,
): void {
  const msg = history[i];
  if (msg == null) return;

  if (msg.role === "tool") {
    // Already consumed by the preceding assistant message; skip.
    return;
  }
  if (msg.role === "system") {
    out.push({
      kind: "msg",
      role: "system",
      content: typeof msg.content === "string" ? msg.content : "",
    });
    return;
  }
  if (msg.role === "user") {
    out.push({
      kind: "msg",
      role: "user",
      content: msg.content,
    });
    return;
  }

  // assistant
  if (typeof msg.content === "string") {
    out.push({
      kind: "msg",
      role: "assistant",
      content: msg.content,
    });
    return;
  }

  const next = history[i + 1];
  const resultsByCallId =
    next != null && next.role === "tool"
      ? indexToolResults(next)
      : new Map<string, ToolResultPart>();

  appendAssistantMultiPart(out, msg, resultsByCallId);
}

function indexToolResults(
  msg: ToolModelMessage,
): Map<string, ToolResultPart> {
  const map = new Map<string, ToolResultPart>();
  for (const part of msg.content) {
    if (part.type === "tool-result") {
      map.set(part.toolCallId, part);
    }
  }
  return map;
}

function appendAssistantMultiPart(
  out: Entry[],
  msg: AssistantModelMessage,
  resultsByCallId: Map<string, ToolResultPart>,
): void {
  // `content` is the AssistantContent array variant (string handled above).
  const parts = msg.content as Exclude<typeof msg.content, string>;

  const texts: string[] = [];
  const toolCalls: ToolCallPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      texts.push(part.text);
    } else if (part.type === "tool-call") {
      toolCalls.push(part);
    }
    // Other parts (file, reasoning, tool-result, tool-approval-request)
    // are not surfaced in the current TUI — intentionally ignored.
  }

  if (texts.length > 0) {
    out.push({
      kind: "msg",
      role: "assistant",
      content: texts.join(""),
    });
  }

  for (const tc of toolCalls) {
    const match = resultsByCallId.get(tc.toolCallId);
    out.push(toolEntryFor(tc, match));
  }
}

function toolEntryFor(
  call: ToolCallPart,
  match: ToolResultPart | undefined,
): ToolEntry {
  const base = {
    kind: "tool" as const,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  };
  if (match == null) {
    return { ...base, phase: "call" };
  }
  const errored = errorPayloadFrom(match.output);
  if (errored != null) {
    return { ...base, phase: "error", errorMessage: errored };
  }
  return {
    ...base,
    phase: "result",
    output: unwrapToolOutput(match.output),
  };
}

/**
 * If the SDK-tagged output is the synthetic "tool-error folded as result"
 * payload produced by the accumulator (see history-accumulator.ts), pull the
 * human-readable error message back out. Returns null when the output is a
 * normal successful result.
 */
function errorPayloadFrom(output: ToolResultOutput): string | null {
  if (output.type === "json" || output.type === "error-json") {
    const v = output.value as unknown;
    if (
      v != null &&
      typeof v === "object" &&
      (v as { errored?: unknown }).errored === true &&
      typeof (v as { error?: unknown }).error === "string"
    ) {
      return (v as { error: string }).error;
    }
  }
  if (output.type === "error-text") {
    return output.value;
  }
  return null;
}

/**
 * Reverse of `history-accumulator.toToolResultOutput`: pull the raw value back
 * out for the UI's `formatToolResult`, which sniffs on `output.mode` /
 * `output.kind` / etc. straight from the tool's emitted object.
 */
function unwrapToolOutput(output: ToolResultOutput): unknown {
  if (output.type === "json" || output.type === "error-json") {
    return output.value;
  }
  if (output.type === "text" || output.type === "error-text") {
    return output.value;
  }
  return output;
}
