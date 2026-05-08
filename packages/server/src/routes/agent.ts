import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  AgentChatRequest,
  AgentStreamEvent,
  ChatMessage,
} from "@lordcode/shared";
import type { AppDeps } from "../app.js";
import { streamAgent } from "../agent/index.js";

export function agentRoute(deps: AppDeps) {
  const route = new Hono();

  route.post("/chat", async (c) => {
    let body: AgentChatRequest;
    try {
      body = (await c.req.json()) as AgentChatRequest;
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }

    if (!Array.isArray(body?.messages)) {
      return c.json({ error: "messages must be an array" }, 400);
    }
    const messages: ChatMessage[] = body.messages;

    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      try {
        for await (const ev of streamAgent(messages, {
          store: deps.configStore,
          signal,
        })) {
          await stream.writeSSE({ data: JSON.stringify(ev) });
        }
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: AgentStreamEvent = { type: "error", message };
        await stream.writeSSE({ data: JSON.stringify(errorEvent) });
        deps.logger.error("agent stream failed", err);
      }
    });
  });

  return route;
}
