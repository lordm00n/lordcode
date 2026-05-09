import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { Logger } from "@lordcode/logger";
import { createLogger } from "@lordcode/logger";
import {
  API_ROUTES,
  type AgentChatRequest,
  type AgentStreamEvent,
  type HealthResponse,
  type ModelsListResponse,
  type SetCurrentModelRequest,
  type SetCurrentModelResponse,
} from "@lordcode/shared";

export interface ChatStream {
  /** Async iterable of decoded SSE events. Ends naturally when server closes. */
  events: AsyncIterable<AgentStreamEvent>;
  /** Cancels the underlying fetch (best-effort). Idempotent. */
  abort: () => void;
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
  listModels(): Promise<ModelsListResponse>;
  setCurrentModel(name: string): Promise<SetCurrentModelResponse>;
  chat(req: AgentChatRequest): ChatStream;
}

/** Silent fallback for callers (notably tests) that don't pass a logger. */
const noopLogger: Logger = createLogger({
  level: "silent",
  transports: [{ write() {}, close() {} }],
});

export function createApiClient(baseUrl: string, logger?: Logger): ApiClient {
  // Convention: caller hands in `tuiLogger`; the api channel surfaces as `tui:api`.
  const log = (logger ?? noopLogger).child("api");

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    log.debug("http request", {
      method: init?.method ?? "GET",
      path,
    });
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      log.error("http request failed", err, { path });
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      const errMsg =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text || res.statusText;
      log.warn("http non-2xx", { path, status: res.status, error: errMsg });
      throw new Error(`HTTP ${res.status} ${path}: ${errMsg}`);
    }
    log.debug("http response", { path, status: res.status });
    return (await res.json()) as T;
  };

  return {
    health: () => json<HealthResponse>(API_ROUTES.health),

    listModels: () => json<ModelsListResponse>(API_ROUTES.models),

    setCurrentModel: (name) => {
      const body: SetCurrentModelRequest = { name };
      return json<SetCurrentModelResponse>(API_ROUTES.currentModel, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    chat: (req) => openChatStream(baseUrl, req, log),
  };
}

function openChatStream(
  baseUrl: string,
  req: AgentChatRequest,
  log: Logger,
): ChatStream {
  const controller = new AbortController();
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    log.debug("chat: abort requested");
    controller.abort();
  };

  const events: AsyncIterable<AgentStreamEvent> = {
    [Symbol.asyncIterator]: () =>
      streamSseEvents(baseUrl, req, controller, () => aborted, log),
  };

  return { events, abort };
}

async function* streamSseEvents(
  baseUrl: string,
  req: AgentChatRequest,
  controller: AbortController,
  isAborted: () => boolean,
  log: Logger,
): AsyncGenerator<AgentStreamEvent, void, void> {
  let res: Response;
  try {
    log.debug("chat: opening stream", { messages: req.messages.length });
    res = await fetch(`${baseUrl}${API_ROUTES.agentChat}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err) || isAborted()) {
      log.debug("chat: aborted before response");
      return;
    }
    log.error("chat: fetch failed", err);
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.warn("chat: non-2xx response", {
      status: res.status,
      body: text.slice(0, 200),
    });
    throw new Error(`HTTP ${res.status} ${API_ROUTES.agentChat}: ${text}`);
  }
  if (!res.body) {
    throw new Error("response has no body");
  }

  const queue: AgentStreamEvent[] = [];
  let resolveWaiter: (() => void) | null = null;
  const wake = () => {
    if (resolveWaiter) {
      const r = resolveWaiter;
      resolveWaiter = null;
      r();
    }
  };

  let parsedFrames = 0;
  let droppedFrames = 0;

  const parser = createParser({
    onEvent(ev: EventSourceMessage) {
      if (!ev.data) return;
      try {
        const parsed = JSON.parse(ev.data) as AgentStreamEvent;
        parsedFrames++;
        queue.push(parsed);
        wake();
      } catch {
        // Q4: malformed JSON frames are silently skipped.
        droppedFrames++;
        log.warn("chat: malformed sse frame dropped");
      }
    },
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pumpDone = false;
  let pumpError: unknown = undefined;

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          parser.feed(decoder.decode(value, { stream: true }));
          if (queue.length > 0) wake();
        }
      }
    } catch (err) {
      if (!isAbortError(err) && !isAborted()) pumpError = err;
    } finally {
      pumpDone = true;
      wake();
    }
  })();

  try {
    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift()!;
        yield ev;
      }
      if (pumpDone) break;
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }
    if (pumpError) {
      log.error("chat: pump error", pumpError);
      throw pumpError;
    }
  } finally {
    log.debug("chat: stream ended", { parsedFrames, droppedFrames });
    try {
      await pump;
    } catch {
      // already captured
    }
    try {
      reader.releaseLock();
    } catch {
      // reader may already be detached
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError";
}
