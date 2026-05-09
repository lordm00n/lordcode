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
  const log = deps.logger.child("route").child("agent");
  const streamLog = deps.logger.child("agent").child("stream");

  route.post("/chat", async (c) => {
    let body: AgentChatRequest;
    try {
      body = (await c.req.json()) as AgentChatRequest;
    } catch {
      log.warn("invalid body: not JSON");
      return c.json({ error: "request body must be JSON" }, 400);
    }

    if (!Array.isArray(body?.messages)) {
      log.warn("invalid body: messages must be an array");
      return c.json({ error: "messages must be an array" }, 400);
    }
    const messages: ChatMessage[] = body.messages;
    log.debug("chat turn requested", { messages: messages.length });

    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      try {
        for await (const ev of streamAgent(messages, {
          store: deps.configStore,
          logger: streamLog,
          signal,
        })) {
          await stream.writeSSE({ data: JSON.stringify(ev) });
        }
        log.debug("chat turn completed");
      } catch (err) {
        if (signal.aborted) {
          log.debug("chat turn aborted by client");
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const errorEvent: AgentStreamEvent = { type: "error", message };
        await stream.writeSSE({ data: JSON.stringify(errorEvent) });
        log.error("agent stream failed", err);
      }
    });
  });

  return route;
}
