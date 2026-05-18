/**
 * Pure accumulator that folds the SSE `AgentStreamEvent` stream into a
 * canonical `ModelMessage[]` history. Mirrors the spec in
 * `docs/spec/conversation-history/design.md` §3 / §5.2.
 *
 * Design highlights:
 * - `history` only ever grows by FULL `ModelMessage`s. In-flight content lives
 *   in `pendingAssistant` / `pendingTool` until a flush is triggered.
 * - Event-type transitions are the flush triggers:
 *     - text/tool-call → tool-result/tool-error  ⇒ flush pendingAssistant
 *     - tool-result/tool-error → text/tool-call ⇒ flush pendingTool
 *   This is the natural shape of an LLM step (assistant content followed by
 *   matching tool outputs) so the resulting `ModelMessage[]` is what providers
 *   expect on the next turn.
 * - At most one of `pendingAssistant` / `pendingTool` is non-null at any time.
 * - `start` is treated as a hard reset of pending state for the new turn:
 *   any leftover in-flight bits from a previous run (e.g. an aborted turn that
 *   didn't manage to flush) are dropped before we start accumulating again.
 * - `reasoning-*`, `tool-input-*`, and `error` are UI-only and never touch history.
 */
import type {
  AgentStreamEvent,
  AssistantContent,
  AssistantModelMessage,
  ModelMessage,
  ToolContent,
  ToolModelMessage,
  ToolResultOutput,
  ToolResultPart,
} from "@lordcode/shared";

/**
 * Rolling state used by {@link accumulate}.
 */
export interface AccumulatorState {
  history: ModelMessage[];
  pendingAssistant: AssistantInFlight | null;
  pendingTool: ToolInFlight | null;
}

interface AssistantInFlight {
  /** Text accumulated so far in this assistant message (across multiple deltas). */
  text: string;
  /** Tool-call parts collected so far in this assistant message (parallel calls). */
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
}

interface ToolInFlight {
  /** Tool-result / tool-error parts collected so far for this tool message. */
  results: PendingToolResult[];
}

interface PendingToolResult {
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
}

export const initialAccumulatorState: AccumulatorState = {
  history: [],
  pendingAssistant: null,
  pendingTool: null,
};

/**
 * Apply one SSE event to the accumulator. Returns a NEW state value; never
 * mutates `state`. Flush rules above.
 */
export function accumulate(
  state: AccumulatorState,
  event: AgentStreamEvent,
): AccumulatorState {
  switch (event.type) {
    case "start": {
      // A fresh turn is starting. Discard any pending in-flight content from a
      // prior aborted turn; it's structurally incomplete (no matching result
      // or terminator) and shipping it would corrupt history.
      if (state.pendingAssistant == null && state.pendingTool == null) {
        return state;
      }
      return {
        history: state.history,
        pendingAssistant: null,
        pendingTool: null,
      };
    }

    case "delta": {
      // text → tool-result/tool-error would have already been flushed by the
      // tool-result/tool-error branch below, so seeing a text delta means we
      // either have an existing pendingAssistant or are starting a new one
      // (transition from pendingTool to pendingAssistant).
      let next = state;
      if (state.pendingTool != null) {
        next = flushPendingTool(state);
      }
      const current =
        next.pendingAssistant ?? emptyAssistantInFlight();
      const updated: AssistantInFlight = {
        text: current.text + event.text,
        toolCalls: current.toolCalls,
      };
      return {
        history: next.history,
        pendingAssistant: updated,
        pendingTool: null,
      };
    }

    case "tool-call": {
      let next = state;
      if (state.pendingTool != null) {
        next = flushPendingTool(state);
      }
      const current =
        next.pendingAssistant ?? emptyAssistantInFlight();
      const updated: AssistantInFlight = {
        text: current.text,
        toolCalls: [
          ...current.toolCalls,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          },
        ],
      };
      return {
        history: next.history,
        pendingAssistant: updated,
        pendingTool: null,
      };
    }

    case "tool-result": {
      let next = state;
      if (state.pendingAssistant != null) {
        next = flushPendingAssistant(state);
      }
      const current = next.pendingTool ?? { results: [] };
      const updated: ToolInFlight = {
        results: [
          ...current.results,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: toToolResultOutput(event.output),
          },
        ],
      };
      return {
        history: next.history,
        pendingAssistant: null,
        pendingTool: updated,
      };
    }

    case "tool-error": {
      let next = state;
      if (state.pendingAssistant != null) {
        next = flushPendingAssistant(state);
      }
      const current = next.pendingTool ?? { results: [] };
      const errOutput: ToolResultOutput = {
        type: "json",
        value: { error: event.message, errored: true },
      };
      const updated: ToolInFlight = {
        results: [
          ...current.results,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            output: errOutput,
          },
        ],
      };
      return {
        history: next.history,
        pendingAssistant: null,
        pendingTool: updated,
      };
    }

    case "finish": {
      // Flush whichever side is still in flight. Order matters: assistant
      // first (it precedes its tool results), then tool.
      let next = state;
      if (next.pendingAssistant != null) next = flushPendingAssistant(next);
      if (next.pendingTool != null) next = flushPendingTool(next);
      return next;
    }

    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-input-start":
    case "tool-input-progress":
    case "tool-input-end":
    case "error":
      return state;
  }
}

/**
 * Adopt the user's outgoing message at send time. Pure; appends and resets
 * pending state. Any leftover pending content (e.g. an ESC-interrupted turn
 * that wasn't finished) is dropped — sending half a step would produce an
 * invalid `messages[]` for the next request.
 */
export function appendUserMessage(
  state: AccumulatorState,
  message: ModelMessage,
): AccumulatorState {
  return {
    history: [...state.history, message],
    pendingAssistant: null,
    pendingTool: null,
  };
}

/**
 * Project the canonical history PLUS visible in-flight content into a single
 * `ModelMessage[]` for rendering. Pure.
 *
 * Visibility rules picked to avoid duplicating content the streaming overlay
 * already shows on screen:
 *  - `pendingAssistant` is included ONLY when it carries at least one
 *    `tool-call`. A text-only pendingAssistant is the live "ai · …▌" panel —
 *    surfacing it via entries too would double-render the same prose.
 *  - `pendingTool` is included whenever it has at least one result; tool
 *    results never stream into the overlay, so this is the only way to make
 *    them visible before the next event flushes them into history.
 *
 * The returned array is structurally a valid `ModelMessage[]` (no orphan
 * assistant.tool-call beyond the trailing one) but is for rendering only —
 * never ship this back over the wire. Use `state.history` (optionally via
 * `repairOrphanToolCalls`) for wire payloads.
 */
export function snapshotForRender(state: AccumulatorState): ModelMessage[] {
  const out: ModelMessage[] = [...state.history];
  const pa = state.pendingAssistant;
  if (pa != null && pa.toolCalls.length > 0) {
    const msg = assistantInFlightToMessage(pa);
    if (msg != null) out.push(msg);
  }
  const pt = state.pendingTool;
  if (pt != null && pt.results.length > 0) {
    const content: ToolContent = pt.results.map(
      (r): ToolResultPart => ({
        type: "tool-result",
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.output,
      }),
    );
    out.push({ role: "tool", content });
  }
  return out;
}

/**
 * Drop any in-flight pending content without flushing. Used at abort points
 * where the partial assistant text / tool-call has no matching terminator and
 * would be invalid to ship.
 */
export function dropPending(state: AccumulatorState): AccumulatorState {
  if (state.pendingAssistant == null && state.pendingTool == null) {
    return state;
  }
  return {
    history: state.history,
    pendingAssistant: null,
    pendingTool: null,
  };
}

function emptyAssistantInFlight(): AssistantInFlight {
  return { text: "", toolCalls: [] };
}

function flushPendingAssistant(state: AccumulatorState): AccumulatorState {
  const p = state.pendingAssistant;
  if (p == null) return state;
  const msg = assistantInFlightToMessage(p);
  if (msg == null) {
    return {
      history: state.history,
      pendingAssistant: null,
      pendingTool: state.pendingTool,
    };
  }
  return {
    history: [...state.history, msg],
    pendingAssistant: null,
    pendingTool: state.pendingTool,
  };
}

function flushPendingTool(state: AccumulatorState): AccumulatorState {
  const p = state.pendingTool;
  if (p == null || p.results.length === 0) {
    return {
      history: state.history,
      pendingAssistant: state.pendingAssistant,
      pendingTool: null,
    };
  }
  const content: ToolContent = p.results.map(
    (r): ToolResultPart => ({
      type: "tool-result",
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: r.output,
    }),
  );
  const msg: ToolModelMessage = { role: "tool", content };
  return {
    history: [...state.history, msg],
    pendingAssistant: state.pendingAssistant,
    pendingTool: null,
  };
}

/**
 * Turn an in-flight assistant accumulation into an `AssistantModelMessage`,
 * or `null` if there's nothing material to emit (no text + no tool-calls).
 *
 * Text-only assistants flatten back to `content: string` so the wire stays
 * compact and matches what providers expect for plain-text turns.
 */
function assistantInFlightToMessage(
  p: AssistantInFlight,
): AssistantModelMessage | null {
  const hasText = p.text.length > 0;
  const hasToolCalls = p.toolCalls.length > 0;
  if (!hasText && !hasToolCalls) return null;

  if (hasText && !hasToolCalls) {
    return { role: "assistant", content: p.text };
  }

  const content: Exclude<AssistantContent, string> = [];
  if (hasText) {
    content.push({ type: "text", text: p.text });
  }
  for (const tc of p.toolCalls) {
    content.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    });
  }
  return { role: "assistant", content };
}

/**
 * Coerce a wire-`unknown` tool output into the SDK's `ToolResultOutput`.
 * The SSE chunk forwards whatever the tool produced as a raw value (see
 * `packages/server/src/agent/stream.ts` — `output: chunk.output`); for
 * history bookkeeping we wrap it in the SDK's tagged `{ type: "json", value }`
 * shape so the next turn's `streamText({ messages })` accepts it.
 *
 * Pre-shaped outputs (already `{ type, value }`) pass through verbatim so we
 * don't double-wrap; this future-proofs us against providers/tools that
 * already emit fully-tagged `ToolResultOutput`.
 */
function toToolResultOutput(raw: unknown): ToolResultOutput {
  if (isToolResultOutput(raw)) return raw;
  // Cast through the SDK's JSON `value` slot. Tools in this repo emit plain
  // JSON-serialisable objects today (see `packages/server/src/tools/*`); any
  // future tool that wants richer media should pre-wrap its output.
  return { type: "json", value: raw as never };
}

function isToolResultOutput(v: unknown): v is ToolResultOutput {
  if (v == null || typeof v !== "object") return false;
  const t = (v as { type?: unknown }).type;
  return (
    t === "text" ||
    t === "json" ||
    t === "error-text" ||
    t === "error-json" ||
    t === "execution-denied" ||
    t === "content"
  );
}
