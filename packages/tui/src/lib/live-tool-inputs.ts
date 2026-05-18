import type { AgentStreamEvent } from "@lordcode/shared";
import type { LiveToolInput } from "./format-tool-call.js";

export type { LiveToolInput } from "./format-tool-call.js";

export function applyLiveToolInputEvent(
  inputs: LiveToolInput[],
  event: AgentStreamEvent,
): LiveToolInput[] {
  switch (event.type) {
    case "tool-input-start":
      return upsertLiveToolInput(inputs, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        phase: "preparing",
      });

    case "tool-input-progress":
      return upsertLiveToolInput(inputs, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        phase: "preparing",
        inputBytes: event.inputBytes,
        elapsedMs: event.elapsedMs,
      });

    case "tool-input-end":
      return upsertLiveToolInput(inputs, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        phase: "executing",
        inputBytes: event.inputBytes,
        elapsedMs: event.elapsedMs,
      });

    case "tool-call":
    case "tool-result":
    case "tool-error":
      return inputs.filter((input) => input.toolCallId !== event.toolCallId);

    default:
      return inputs;
  }
}

function upsertLiveToolInput(
  inputs: LiveToolInput[],
  next: LiveToolInput,
): LiveToolInput[] {
  const index = inputs.findIndex((input) => input.toolCallId === next.toolCallId);
  if (index === -1) return [...inputs, next];
  return inputs.map((input, i) => (i === index ? next : input));
}
