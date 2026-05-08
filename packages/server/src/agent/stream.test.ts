import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import type {
  AgentStreamEvent,
  ChatMessage,
  ModelConfig,
} from "@lordcode/shared";
import { streamAgent, type StreamTextLike } from "./stream.js";

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

const arrayToTextStream = (chunks: string[]): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) {
      yield c;
    }
  },
});

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
      textStream: arrayToTextStream(["Hel", "lo"]),
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
    const errorStream: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        yield "A";
        throw new Error("provider exploded");
      },
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => ({ textStream: errorStream }),
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "error"]);
    expect((events[2] as { message: string }).message).toMatch(
      /provider exploded/,
    );
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

    const slowStream: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        yield "first";
        ac.abort();
        await Promise.resolve();
        yield "second";
      },
    };

    const streamTextImpl = (args: { abortSignal?: AbortSignal }) => {
      args.abortSignal?.addEventListener("abort", () => {
        abortReceived = true;
      });
      return { textStream: slowStream } as StreamTextLike;
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
