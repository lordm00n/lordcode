/**
 * Pre-flight integrity check for `ModelMessage[]` before sending it back to
 * `/agent/chat`. Most providers (OpenAI, Anthropic, …) reject a conversation
 * where an assistant turn contains a `tool-call` part with no matching
 * `tool-result` in a later `tool` message. The accumulator in steady state
 * never produces such an orphan, but two paths can:
 *
 *  1. ESC interrupt landing AFTER the SDK has emitted the assistant's
 *     `tool-call` chunk but BEFORE the matching `tool-result` chunk arrives
 *     (see spec §6.5).
 *  2. A future feature that loads history from disk where the previous
 *     session crashed mid-tool.
 *
 * For each orphan tool-call we synthesise a `cancelled` tool-result and
 * splice it into the next `tool` message (creating one immediately after
 * the assistant if none exists). The synthetic payload follows the spec's
 * `{ interrupted: true, reason: "user_cancelled" }` shape so the model can
 * tell the call was aborted versus genuinely returning no data.
 *
 * Pure, deterministic, returns a new array. No-op on already-valid input.
 */
import type {
  ModelMessage,
  ToolModelMessage,
  ToolResultPart,
} from "@lordcode/shared";

export function repairOrphanToolCalls(
  messages: ModelMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg == null) continue;
    out.push(msg);

    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") continue;
    const assistantParts = msg.content;

    const callIds = new Set<string>();
    for (const part of assistantParts) {
      if (part.type === "tool-call") callIds.add(part.toolCallId);
    }
    if (callIds.size === 0) continue;

    const next = messages[i + 1];
    const nextIsTool = next != null && next.role === "tool";
    const existingResultIds = new Set<string>();
    if (nextIsTool) {
      for (const part of (next as ToolModelMessage).content) {
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }

    const orphanIds: string[] = [];
    for (const id of callIds) {
      if (!existingResultIds.has(id)) orphanIds.push(id);
    }
    if (orphanIds.length === 0) continue;

    const synthesised: ToolResultPart[] = orphanIds.map((id) =>
      syntheticCancelledResult(id, toolNameForCall(assistantParts, id)),
    );

    if (nextIsTool) {
      const merged: ToolModelMessage = {
        role: "tool",
        content: [
          ...(next as ToolModelMessage).content,
          ...synthesised,
        ],
      };
      out.push(merged);
      i++;
    } else {
      out.push({ role: "tool", content: synthesised });
    }
  }

  return out;
}

type AssistantPartsArray = Exclude<
  import("@lordcode/shared").AssistantContent,
  string
>;

function toolNameForCall(
  content: AssistantPartsArray,
  toolCallId: string,
): string {
  for (const part of content) {
    if (part.type === "tool-call" && part.toolCallId === toolCallId) {
      return part.toolName;
    }
  }
  return "";
}

function syntheticCancelledResult(
  toolCallId: string,
  toolName: string,
): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    output: {
      type: "json",
      value: { interrupted: true, reason: "user_cancelled" },
    },
  };
}
