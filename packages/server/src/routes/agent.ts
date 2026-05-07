import { Hono } from "hono";
import type { AgentChatRequest, AgentChatResponse } from "@lordcode/shared";
import type { AppDeps } from "../app.js";
import { runAgent } from "../agent/index.js";

export function agentRoute(deps: AppDeps) {
  const route = new Hono();

  route.post("/chat", async (c) => {
    const body = (await c.req.json()) as AgentChatRequest;

    if (!Array.isArray(body?.messages)) {
      return c.json({ error: "messages must be an array" }, 400);
    }

    const message = await runAgent(body.messages, { logger: deps.logger });
    const response: AgentChatResponse = { message };
    return c.json(response);
  });

  return route;
}
