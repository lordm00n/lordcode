import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import type {
  AgentStreamEvent,
  ModelConfig,
  ModelMessage,
} from "@lordcode/shared";
import {
  streamAgent,
  type FullStreamChunk,
  type StreamTextFn,
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
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
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

  // ── Tool events (B6.11–B6.14) ──────────────────────────────────────────

  // B6.11 — happy path: tool-call → tool-result chunks translate verbatim,
  // and may interleave with text-delta from the agent loop.
  it("[B6.11] forwards tool-call and tool-result chunks (interleaved with text)", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "text-delta", text: "let me search" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "ripgrep",
          input: { pattern: "useState", outputMode: "content", headLimit: 100 },
        },
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "ripgrep",
          output: { mode: "content", matches: [], truncated: false },
        },
        { type: "text-delta", text: "no matches" },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "delta",
      "tool-call",
      "tool-result",
      "delta",
      "finish",
    ]);
    const toolCall = events[2] as Extract<AgentStreamEvent, { type: "tool-call" }>;
    expect(toolCall.toolCallId).toBe("call_1");
    expect(toolCall.toolName).toBe("ripgrep");
    expect(toolCall.input).toEqual({
      pattern: "useState",
      outputMode: "content",
      headLimit: 100,
    });
    const toolResult = events[3] as Extract<AgentStreamEvent, { type: "tool-result" }>;
    expect(toolResult.toolCallId).toBe("call_1");
    expect(toolResult.output).toEqual({
      mode: "content",
      matches: [],
      truncated: false,
    });
  });

  // B6.12 — tool-error from the SDK translates to AgentStreamEvent.tool-error
  // with `message` collapsed from the unknown `error` payload. The stream
  // does NOT terminate — the model can still continue (agent loop recovery).
  it("[B6.12] forwards tool-error and keeps streaming subsequent chunks", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "ripgrep",
          input: { pattern: "[bad" },
        },
        {
          type: "tool-error",
          toolCallId: "call_2",
          toolName: "ripgrep",
          error: new Error("rg failed (exit 2): regex parse error"),
        },
        { type: "text-delta", text: "let me try a different approach" },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "tool-call",
      "tool-error",
      "delta",
      "finish",
    ]);
    const toolError = events[2] as Extract<AgentStreamEvent, { type: "tool-error" }>;
    expect(toolError.toolCallId).toBe("call_2");
    expect(toolError.toolName).toBe("ripgrep");
    expect(toolError.message).toMatch(/regex parse error/);
  });

  // B6.13 — toolCallId pairs across multiple agent loop iterations: the
  // call/result IDs are surfaced unchanged so the TUI can group them.
  it("[B6.13] preserves distinct toolCallIds across multiple tool invocations", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "tool-call", toolCallId: "a", toolName: "ripgrep", input: { pattern: "p1" } },
        { type: "tool-result", toolCallId: "a", toolName: "ripgrep", output: { mode: "content", matches: [], truncated: false } },
        { type: "tool-call", toolCallId: "b", toolName: "ripgrep", input: { pattern: "p2" } },
        { type: "tool-result", toolCallId: "b", toolName: "ripgrep", output: { mode: "content", matches: [], truncated: false } },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    const ids = events
      .filter(
        (e): e is Extract<AgentStreamEvent, { type: "tool-call" | "tool-result" }> =>
          e.type === "tool-call" || e.type === "tool-result",
      )
      .map((e) => e.toolCallId);
    expect(ids).toEqual(["a", "a", "b", "b"]);
  });

  it("[UT-S1] forwards tool-input-start with SDK id mapped to toolCallId", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "tool-input-start", id: "call_x", toolName: "write_file" },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    expect(events).toContainEqual({
      type: "tool-input-start",
      toolCallId: "call_x",
      toolName: "write_file",
    });
  });

  it("[UT-S2] does not emit tool-input-progress before throttle thresholds", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "tool-input-start", id: "call_x", toolName: "write_file" },
        { type: "tool-input-delta", id: "call_x", delta: '{"path":"a.t' },
        { type: "tool-input-delta", id: "call_x", delta: 'xt","content"' },
        { type: "tool-input-delta", id: "call_x", delta: ':"hello"}' },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    expect(events.map((e) => e.type)).not.toContain("tool-input-progress");
  });

  it("[UT-S3] emits throttled tool-input-progress with aggregate bytes", async () => {
    const largeDelta = "x".repeat(64 * 1024);
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "tool-input-start", id: "call_x", toolName: "write_file" },
        { type: "tool-input-delta", id: "call_x", delta: largeDelta },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    const progress = events.find(
      (e): e is Extract<AgentStreamEvent, { type: "tool-input-progress" }> =>
        e.type === "tool-input-progress",
    );
    expect(progress).toMatchObject({
      type: "tool-input-progress",
      toolCallId: "call_x",
      toolName: "write_file",
      inputBytes: largeDelta.length,
    });
    expect(typeof progress?.elapsedMs).toBe("number");
  });

  it("[UT-S4] forwards tool-input-end with final aggregate bytes", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "tool-input-start", id: "call_x", toolName: "write_file" },
        { type: "tool-input-delta", id: "call_x", delta: "hello" },
        { type: "tool-input-end", id: "call_x" },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    const end = events.find(
      (e): e is Extract<AgentStreamEvent, { type: "tool-input-end" }> =>
        e.type === "tool-input-end",
    );
    expect(end).toMatchObject({
      type: "tool-input-end",
      toolCallId: "call_x",
      toolName: "write_file",
      inputBytes: 5,
    });
    expect(typeof end?.elapsedMs).toBe("number");
  });

  it("[UT-S5] preserves tool-input lifecycle order before formal tool events", async () => {
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([
        { type: "tool-input-start", id: "call_x", toolName: "write_file" },
        { type: "tool-input-delta", id: "call_x", delta: "hello" },
        { type: "tool-input-end", id: "call_x" },
        {
          type: "tool-call",
          toolCallId: "call_x",
          toolName: "write_file",
          input: { path: "a.txt", content: "hello" },
        },
        {
          type: "tool-result",
          toolCallId: "call_x",
          toolName: "write_file",
          output: { path: "/tmp/a.txt", bytesWritten: 5, created: true, previousBytes: null },
        },
      ]),
      finishReason: Promise.resolve("stop"),
    };
    const events = await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        streamText: () => fakeStream,
        tools: {},
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "start",
      "tool-input-start",
      "tool-input-end",
      "tool-call",
      "tool-result",
      "finish",
    ]);
  });

  // B6.14 — streamText is invoked with a `tools` set and a `stopWhen` cap.
  // Defending against regression: it would be easy to forget either when
  // refactoring stream.ts.
  it("[B6.14] passes tools and stopWhen into streamText", async () => {
    let capturedArgs: Parameters<StreamTextFn>[0] | null = null;
    const fakeStream: StreamTextLike = {
      fullStream: arrayToFullStream([{ type: "text-delta", text: "ok" }]),
      finishReason: Promise.resolve("stop"),
    };
    const fakeTools = { sentinel: { description: "", inputSchema: {} } } as unknown as NonNullable<
      Parameters<StreamTextFn>[0]["tools"]
    >;
    await collect(
      streamAgent([], {
        store: fakeStore(cfg),
        resolveApiKey: () => "sk-fake",
        resolveLanguageModel: () => fakeModel,
        tools: fakeTools,
        streamText: (args) => {
          capturedArgs = args;
          return fakeStream;
        },
      }),
    );
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.tools).toBe(fakeTools);
    expect(capturedArgs!.stopWhen).toBeDefined();
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
