import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  AgentChatRequest,
  AgentStreamEvent,
  ModelMessage,
} from "@lordcode/shared";
import type { AppDeps } from "../app.js";
import { streamAgent } from "../agent/index.js";

export function agentRoute(deps: AppDeps) {
  const route = new Hono();
  const log = deps.logger.child("route").child("agent");

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
    const messages: ModelMessage[] = body.messages;
    const streamLog = deps.sessionRuntime.log.child("agent").child("stream");
    log.debug("chat turn requested", { messages: messages.length });

    return streamSSE(c, async (stream) => {
      const signal = c.req.raw.signal;
      const canonicalEvents: Parameters<
        typeof deps.sessionRuntime.appendActive
      >[0][] = [];
      let assistantText = "";
      const flushAssistantText = () => {
        if (assistantText.length === 0) return;
        canonicalEvents.push({
          type: "message",
          role: "assistant",
          payload: { content: assistantText },
        });
        assistantText = "";
      };
      try {
        const last = messages[messages.length - 1];
        if (last?.role === "user") {
          await deps.sessionRuntime.appendActive({
            type: "message",
            role: "user",
            payload: { content: last.content, attachments: [] },
          });
        }
        for await (const ev of streamAgent(messages, {
          store: deps.configStore,
          logger: streamLog,
          signal,
        })) {
          collectCanonicalEvent(ev, canonicalEvents, {
            get assistantText() {
              return assistantText;
            },
            set assistantText(value: string) {
              assistantText = value;
            },
            flushAssistantText,
          });
          await stream.writeSSE({ data: JSON.stringify(ev) });
          if (ev.type === "finish") {
            for (const event of canonicalEvents) {
              await deps.sessionRuntime.appendActive(event);
            }
          }
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

function collectCanonicalEvent(
  ev: AgentStreamEvent,
  out: Parameters<AppDeps["sessionRuntime"]["appendActive"]>[0][],
  text: {
    assistantText: string;
    flushAssistantText: () => void;
  },
): void {
  if (ev.type === "delta") {
    text.assistantText += ev.text;
    return;
  }
  if (ev.type === "tool-call") {
    text.flushAssistantText();
    out.push({
      type: "tool_call",
      payload: {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        input: ev.input,
      },
    });
    return;
  }
  if (ev.type === "tool-result") {
    out.push({
      type: "tool_result",
      payload: {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        result: ev.output,
        isError: false,
      },
    });
    return;
  }
  if (ev.type === "tool-error") {
    out.push({
      type: "tool_result",
      payload: {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        result: { error: ev.message },
        isError: true,
      },
    });
    return;
  }
  if (ev.type === "finish") {
    text.flushAssistantText();
  }
}
