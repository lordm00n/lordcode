import { createParser, type EventSourceMessage } from "eventsource-parser";
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

export function createApiClient(baseUrl: string): ApiClient {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
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
      throw new Error(`HTTP ${res.status} ${path}: ${errMsg}`);
    }
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

    chat: (req) => openChatStream(baseUrl, req),
  };
}

function openChatStream(baseUrl: string, req: AgentChatRequest): ChatStream {
  const controller = new AbortController();
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    controller.abort();
  };

  const events: AsyncIterable<AgentStreamEvent> = {
    [Symbol.asyncIterator]: () => streamSseEvents(baseUrl, req, controller, () => aborted),
  };

  return { events, abort };
}

async function* streamSseEvents(
  baseUrl: string,
  req: AgentChatRequest,
  controller: AbortController,
  isAborted: () => boolean,
): AsyncGenerator<AgentStreamEvent, void, void> {
  let res: Response;
  try {
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
    if (isAbortError(err) || isAborted()) return;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
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

  const parser = createParser({
    onEvent(ev: EventSourceMessage) {
      if (!ev.data) return;
      try {
        const parsed = JSON.parse(ev.data) as AgentStreamEvent;
        queue.push(parsed);
        wake();
      } catch {
        // Q4: malformed JSON frames are silently skipped.
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
    if (pumpError) throw pumpError;
  } finally {
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
