import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import type {
  AgentStreamEvent,
  ChatMessage,
  ModelConfig,
} from "@lordcode/shared";
import {
  streamAgent,
  type FullStreamChunk,
  type StreamTextLike,
} from "./stream.js";

const cfg: ModelConfig = {
  name: "test-model",
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-fake",
};

const fakeModel = { provider: "fake" } as unknown as LanguageModel;

const fakeStore = (current: ModelConfig | null) => ({
  getCurrent: () => current,
});

const arrayToFullStream = (
  chunks: FullStreamChunk[],
): AsyncIterable<FullStreamChunk> => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) {
      yield c;
    }
  },
});

const textChunks = (...texts: string[]): FullStreamChunk[] =>
  texts.map((t) => ({ type: "text-delta", text: t }));

const collect = async (
  iter: AsyncIterable<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> => {
  const out: AgentStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
};

describe("streamAgent", () => {
  // B6.1
  it("[B6.1] emits a single error frame when no current model is selected", async () => {
    const events = await collect(
      streamAgent([], { store: fakeStore(null) }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect((events[0] as { message: string }).message).toMatch(
      /no model selected/,
    );
  });

  // B6.2
  it("[B6.2] emits a single error frame when apiKey is missing (mentions env name)", async () => {
    const events = await collect(
      streamAgent([], {
        store: fakeStore({
          ...cfg,
          apiKey: undefined,
          apiKeyEnv: "ABSENT_VAR_FOR_TEST",
        }),
        resolveApiKey: () => null,
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect((events[0] as { message: string }).message).toMatch(
      /ABSENT_VAR_FOR_TEST/,
    );
  });

  // B6.3 + B6.4
  it("[B6.3+B6.4] emits start → delta(s) → finish in order with model name + finish metadata", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream(textChunks("Hel", "lo")),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 12, outputTokens: 2 }),
    };
    const events = await collect(
      streamAgent(messages, {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "delta",
      "delta",
      "finish",
    ]);
    expect((events[0] as { model: string }).model).toBe("test-model");
    expect((events[1] as { text: string }).text).toBe("Hel");
    expect((events[2] as { text: string }).text).toBe("lo");
    const finish = events[3] as Extract<AgentStreamEvent, { type: "finish" }>;
    expect(finish.finishReason).toBe("stop");
    expect(finish.usage).toEqual({ inputTokens: 12, outputTokens: 2 });
  });

  // B6.5
  it("[B6.5] keeps emitted partials when streamText throws mid-stream", async () => {
    const errorStream: AsyncIterable<FullStreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta", text: "A" };
        throw new Error("provider exploded");
      },
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => ({ fullStream: errorStream }),
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "error"]);
    expect((events[2] as { message: string }).message).toMatch(
      /provider exploded/,
    );
  });

  // B6.8 — fullStream-era: reasoning-start/delta/end bracket the model's thinking,
  // and the trio is forwarded independently of text deltas (they may interleave).
  it("[B6.8] forwards reasoning-start/delta/end chunks alongside text deltas, ignoring placeholder chunk types", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "start" },
        { type: "reasoning-start" },
        { type: "reasoning-delta", text: "Let me think… " },
        { type: "reasoning-delta", text: "step by step." },
        { type: "reasoning-end" },
        { type: "text-start" },
        { type: "text-delta", text: "Answer" },
        { type: "text-end" },
        { type: "finish-step" },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "delta",
      "finish",
    ]);
    expect((events[2] as { text: string }).text).toBe("Let me think… ");
    expect((events[3] as { text: string }).text).toBe("step by step.");
    expect((events[5] as { text: string }).text).toBe("Answer");
  });

  // B6.9 — fullStream surfaces non-fatal provider errors as `{type:"error"}` chunks
  // (rather than throwing). They terminate the stream just like a thrown error.
  it("[B6.9] converts an error chunk from fullStream into a single error event and stops", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "text-delta", text: "Hi" },
        { type: "error", error: new Error("rate limited") },
        { type: "text-delta", text: "ignored" },
      ]),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "error"]);
    expect((events[2] as { message: string }).message).toMatch(/rate limited/);
  });

  // B6.10 — workaround for vercel/ai#12054: the SDK eventProcessor enqueues
  // string-typed `error` chunks (e.g. "reasoning part 0 not found") AFTER the
  // offending reasoning chunk has already been forwarded. We must NOT propagate
  // those validation errors as fatal — the rest of the turn (text + finish)
  // is still healthy. Real provider errors (Error objects) keep terminating.
  it("[B6.10] silently recovers from SDK consistency-check error chunks and keeps streaming", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "reasoning-delta", text: "stray thought" },
        { type: "error", error: "reasoning part 0 not found" },
        { type: "text-delta", text: "actual answer" },
        { type: "error", error: "text part 7 not found" },
        { type: "text-delta", text: " continues" },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "reasoning-delta",
      "delta",
      "delta",
      "finish",
    ]);
    expect((events[2] as { text: string }).text).toBe("actual answer");
    expect((events[3] as { text: string }).text).toBe(" continues");
  });

  // B6.6
  it("[B6.6] emits no frames when ctx.signal is already aborted before the first delta", async () => {
    const ac = new AbortController();
    ac.abort();
    const streamTextSpy = vi.fn();
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        signal: ac.signal,
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: streamTextSpy as never,
      }),
    );
    expect(events).toEqual([]);
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  // B6.7
  it("[B6.7] aborting mid-stream stops emission but keeps frames already produced", async () => {
    const ac = new AbortController();
    let abortReceived = false;

    const slowStream: AsyncIterable<FullStreamChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta", text: "first" };
        ac.abort();
        await Promise.resolve();
        yield { type: "text-delta", text: "second" };
      },
    };

    const streamTextImpl = (args: { abortSignal?: AbortSignal }) => {
      args.abortSignal?.addEventListener("abort", () => {
        abortReceived = true;
      });
      return { fullStream: slowStream } as StreamTextLike;
    };

    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        signal: ac.signal,
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: streamTextImpl as never,
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["start", "delta"]);
    expect((events[1] as { text: string }).text).toBe("first");
    expect(abortReceived).toBe(true);
  });
});
