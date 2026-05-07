import type { ChatMessage } from "@lordcode/shared";
import type { Logger } from "../lib/logger.js";

export interface AgentContext {
  logger: Logger;
}

/**
 * Placeholder agent. Replace with real model / tool-use loop in later iterations.
 * Kept intentionally synchronous-looking so the wiring (TUI -> HTTP -> agent)
 * is verifiable end-to-end before the real implementation lands.
 */
export async function runAgent(
  messages: ChatMessage[],
  ctx: AgentContext,
): Promise<ChatMessage> {
  ctx.logger.debug("agent.run", { count: messages.length });

  const last = messages.at(-1);
  const echo = last?.content?.trim() ?? "";

  return {
    role: "assistant",
    content: echo
      ? `(stub agent) you said: ${echo}`
      : "(stub agent) hello, send me something to work on.",
  };
}
