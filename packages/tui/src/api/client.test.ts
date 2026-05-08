import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.js";
import type { AgentStreamEvent, ModelsListResponse } from "@lordcode/shared";

const baseUrl = "http://test.local";
const encoder = new TextEncoder();

interface FakeFetchInit {
  signal?: AbortSignal;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sseFrame = (ev: AgentStreamEvent): string =>
  `data: ${JSON.stringify(ev)}\n\n`;

/**
 * Build a fetch stub that returns a 200 SSE Response with a body driven by `chunks`.
 * Each `chunks` element is one Uint8Array enqueued in order; close after the last.
 */
const sseFetchOk = (chunks: Uint8Array[], onSignal?: (s: AbortSignal) => void) => {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
  return vi.fn(async (_url: string, init?: FakeFetchInit) => {
    if (init?.signal && onSignal) onSignal(init.signal);
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
};

const drainEvents = async (
  events: AsyncIterable<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> => {
  const out: AgentStreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
};

describe("createApiClient.chat — SSE parsing", () => {
  // C2.1
  it("[C2.1] yields start/delta/delta/finish in order", async () => {
    const frames: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "delta", text: "Hi" },
      { type: "delta", text: " there" },
      { type: "finish", finishReason: "stop" },
    ];
    const fetchStub = sseFetchOk(
      frames.map((f) => encoder.encode(sseFrame(f))),
    );
    vi.stubGlobal("fetch", fetchStub);

    const api = createApiClient(baseUrl);
    const stream = api.chat({ messages: [] });
    const got = await drainEvents(stream.events);
    expect(got).toEqual(frames);
  });

  // C2.2
  it("[C2.2] ends naturally if server closes without finish (no throw)", async () => {
    const frames: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "delta", text: "a" },
      { type: "delta", text: "b" },
    ];
    const fetchStub = sseFetchOk(
      frames.map((f) => encoder.encode(sseFrame(f))),
    );
    vi.stubGlobal("fetch", fetchStub);

    const api = createApiClient(baseUrl);
    const stream = api.chat({ messages: [] });
    const got = await drainEvents(stream.events);
    expect(got).toEqual(frames);
  });

  // C2.3
  it("[C2.3] yields start + error frames, then ends", async () => {
    const frames: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "error", message: "boom" },
    ];
    const fetchStub = sseFetchOk(
      frames.map((f) => encoder.encode(sseFrame(f))),
    );
    vi.stubGlobal("fetch", fetchStub);

    const api = createApiClient(baseUrl);
    const stream = api.chat({ messages: [] });
    const got = await drainEvents(stream.events);
    expect(got).toEqual(frames);
  });

  // C2.4 + C2.5
  it("[C2.4+C2.5] abort() flips the fetch signal and ends events cleanly", async () => {
    let captured: AbortSignal | undefined;
    let ctrlOuter: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrlOuter = ctrl;
        ctrl.enqueue(
          encoder.encode(sseFrame({ type: "start", model: "m" })),
        );
      },
    });
    const fetchStub = vi.fn(async (_url: string, init?: FakeFetchInit) => {
      captured = init?.signal;
      // emulate real fetch: when aborted, close/error the body so reads unblock
      init?.signal?.addEventListener("abort", () => {
        try {
          ctrlOuter?.error(
            Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        } catch {
          // already errored
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchStub);

    const api = createApiClient(baseUrl);
    const chat = api.chat({ messages: [] });
    const seen: AgentStreamEvent[] = [];
    for await (const ev of chat.events) {
      seen.push(ev);
      if (ev.type === "start") {
        chat.abort();
      }
    }
    expect(seen.map((e) => e.type)).toEqual(["start"]);
    expect(captured?.aborted).toBe(true);
  });

  // C2.6
  it("[C2.6] skips a single malformed JSON frame, keeps subsequent frames", async () => {
    const goodA = sseFrame({ type: "start", model: "m" });
    const malformed = "data: {oops\n\n";
    const goodB = sseFrame({ type: "delta", text: "x" });
    const fetchStub = sseFetchOk([
      encoder.encode(goodA),
      encoder.encode(malformed),
      encoder.encode(goodB),
    ]);
    vi.stubGlobal("fetch", fetchStub);

    const api = createApiClient(baseUrl);
    const got = await drainEvents(api.chat({ messages: [] }).events);
    expect(got.map((e) => e.type)).toEqual(["start", "delta"]);
  });

  // C2.7
  it("[C2.7] correctly splits multiple frames packed in a single Uint8Array", async () => {
    const big = encoder.encode(
      sseFrame({ type: "start", model: "m" }) +
        sseFrame({ type: "delta", text: "a" }) +
        sseFrame({ type: "delta", text: "b" }) +
        sseFrame({ type: "finish" }),
    );
    const fetchStub = sseFetchOk([big]);
    vi.stubGlobal("fetch", fetchStub);

    const api = createApiClient(baseUrl);
    const got = await drainEvents(api.chat({ messages: [] }).events);
    expect(got.map((e) => e.type)).toEqual([
      "start",
      "delta",
      "delta",
      "finish",
    ]);
  });
});

describe("createApiClient.listModels / setCurrentModel", () => {
  // C2.8
  it("[C2.8] listModels returns the JSON body on 200", async () => {
    const body: ModelsListResponse = {
      models: [
        {
          name: "x",
          provider: "openai",
          model: "gpt-4o-mini",
          apiKeySource: "plain",
        },
      ],
      current: "x",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    const api = createApiClient(baseUrl);
    expect(await api.listModels()).toEqual(body);
  });

  // C2.9
  it("[C2.9] listModels throws on a non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
      ),
    );
    const api = createApiClient(baseUrl);
    await expect(api.listModels()).rejects.toThrow();
  });

  // C2.10
  it("[C2.10] setCurrentModel returns the body on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ current: "claude" }), { status: 200 }),
      ),
    );
    const api = createApiClient(baseUrl);
    expect(await api.setCurrentModel("claude")).toEqual({ current: "claude" });
  });

  // C2.11
  it("[C2.11] setCurrentModel throws including server-supplied error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "no such model: claude",
              available: ["gpt"],
            }),
            { status: 400 },
          ),
      ),
    );
    const api = createApiClient(baseUrl);
    await expect(api.setCurrentModel("claude")).rejects.toThrow(
      /no such model: claude/,
    );
  });
});
