import { describe, expect, it } from "vitest";
import type { AgentStreamEvent, ModelMessage } from "@lordcode/shared";
import {
  accumulate,
  appendUserMessage,
  dropPending,
  initialAccumulatorState,
  snapshotForRender,
  type AccumulatorState,
} from "./history-accumulator.js";

const fold = (events: AgentStreamEvent[]): AccumulatorState =>
  events.reduce((s, e) => accumulate(s, e), initialAccumulatorState);

const histOf = (events: AgentStreamEvent[]): ModelMessage[] =>
  fold(events).history;

describe("accumulate — text-only turn", () => {
  it("[HA1.1] start → delta(s) → finish flushes a single assistant text message", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "finish" },
    ];
    expect(histOf(events)).toEqual([
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("[HA1.2] reasoning chunks do not affect history", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "reasoning-start" },
      { type: "reasoning-delta", text: "think " },
      { type: "reasoning-end" },
      { type: "delta", text: "answer" },
      { type: "finish" },
    ];
    expect(histOf(events)).toEqual([
      { role: "assistant", content: "answer" },
    ]);
  });

  it("[HA1.3] an error frame mid-stream leaves whatever text accumulated NOT yet flushed (turn ended without finish)", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "delta", text: "partial" },
      { type: "error", message: "boom" },
    ];
    const state = fold(events);
    expect(state.history).toEqual([]);
    expect(state.pendingAssistant).not.toBeNull();
    expect(state.pendingAssistant?.text).toBe("partial");
  });

  it("[HA1.4] empty assistant (no deltas at all) → no message emitted on finish", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "finish" },
    ];
    expect(histOf(events)).toEqual([]);
  });
});

describe("accumulate — single tool turn", () => {
  it("[HA2.1] tool-call → tool-result → text flushes [assistant(tool-call), tool(result), assistant(text)]", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "x" },
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "ripgrep",
        output: { mode: "content", matches: [], truncated: false },
      },
      { type: "delta", text: "no hits" },
      { type: "finish" },
    ];
    expect(histOf(events)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "ripgrep",
            input: { pattern: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "ripgrep",
            output: {
              type: "json",
              value: { mode: "content", matches: [], truncated: false },
            },
          },
        ],
      },
      { role: "assistant", content: "no hits" },
    ]);
  });

  it("[HA2.2] text → tool-call → tool-result → text keeps the leading text on the assistant message", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "delta", text: "let me search" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "x" },
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "ripgrep",
        output: { matches: [] },
      },
      { type: "delta", text: "found nothing" },
      { type: "finish" },
    ];
    const hist = histOf(events);
    expect(hist[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me search" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "ripgrep",
          input: { pattern: "x" },
        },
      ],
    });
    expect(hist[1]?.role).toBe("tool");
    expect(hist[2]).toEqual({ role: "assistant", content: "found nothing" });
  });
});

describe("accumulate — parallel tool calls in one step", () => {
  it("[HA3.1] tool-call A + tool-call B → tool-result A + tool-result B aggregates into single messages", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "tool-call",
        toolCallId: "a",
        toolName: "ripgrep",
        input: { pattern: "x" },
      },
      {
        type: "tool-call",
        toolCallId: "b",
        toolName: "ripgrep",
        input: { pattern: "y" },
      },
      {
        type: "tool-result",
        toolCallId: "a",
        toolName: "ripgrep",
        output: { ok: true },
      },
      {
        type: "tool-result",
        toolCallId: "b",
        toolName: "ripgrep",
        output: { ok: false },
      },
      { type: "delta", text: "done" },
      { type: "finish" },
    ];
    const hist = histOf(events);
    expect(hist).toHaveLength(3);
    const assistantContent = (hist[0] as { content: unknown }).content;
    expect(assistantContent).toEqual([
      {
        type: "tool-call",
        toolCallId: "a",
        toolName: "ripgrep",
        input: { pattern: "x" },
      },
      {
        type: "tool-call",
        toolCallId: "b",
        toolName: "ripgrep",
        input: { pattern: "y" },
      },
    ]);
    expect(hist[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "ripgrep",
          output: { type: "json", value: { ok: true } },
        },
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "ripgrep",
          output: { type: "json", value: { ok: false } },
        },
      ],
    });
    expect(hist[2]).toEqual({ role: "assistant", content: "done" });
  });
});

describe("accumulate — tool-error", () => {
  it("[HA4.1] tool-error is folded in as a tool-result with errored:true payload", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "[bad" },
      },
      {
        type: "tool-error",
        toolCallId: "c1",
        toolName: "ripgrep",
        message: "regex parse error",
      },
      { type: "delta", text: "try again" },
      { type: "finish" },
    ];
    const hist = histOf(events);
    expect(hist[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "ripgrep",
          output: {
            type: "json",
            value: { error: "regex parse error", errored: true },
          },
        },
      ],
    });
  });
});

describe("accumulate — tool input lifecycle is UI-only", () => {
  it("[UT-A1] tool-input-start/progress/end do not mutate history or pending state", () => {
    const state = fold([
      { type: "start", model: "m" },
      {
        type: "tool-input-start",
        toolCallId: "c1",
        toolName: "write_file",
      },
      {
        type: "tool-input-progress",
        toolCallId: "c1",
        toolName: "write_file",
        inputBytes: 128,
        elapsedMs: 25,
      },
      {
        type: "tool-input-end",
        toolCallId: "c1",
        toolName: "write_file",
        inputBytes: 128,
        elapsedMs: 30,
      },
    ]);
    expect(state.history).toEqual([]);
    expect(state.pendingAssistant).toBeNull();
    expect(state.pendingTool).toBeNull();
  });

  it("[UT-A2] tool-input events between text and tool-call do not flush assistant text", () => {
    const state = fold([
      { type: "start", model: "m" },
      { type: "delta", text: "writing file" },
      {
        type: "tool-input-start",
        toolCallId: "c1",
        toolName: "write_file",
      },
      {
        type: "tool-input-end",
        toolCallId: "c1",
        toolName: "write_file",
        inputBytes: 32,
        elapsedMs: 10,
      },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "write_file",
        input: { path: "a.ts" },
      },
    ]);
    expect(state.history).toEqual([]);
    expect(state.pendingAssistant?.text).toBe("writing file");
    expect(state.pendingAssistant?.toolCalls).toEqual([
      {
        toolCallId: "c1",
        toolName: "write_file",
        input: { path: "a.ts" },
      },
    ]);
  });
});

describe("accumulate — abort & in-flight handling", () => {
  it("[HA5.1] stream cut off mid-assistant text → pendingAssistant carries the partial, history empty", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      { type: "delta", text: "writing" },
      { type: "delta", text: " more" },
    ];
    const state = fold(events);
    expect(state.history).toEqual([]);
    expect(state.pendingAssistant?.text).toBe("writing more");
  });

  it("[HA5.2] dropPending() clears in-flight without touching flushed history", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "x" },
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "ripgrep",
        output: { matches: [] },
      },
      { type: "delta", text: "partial answer" },
    ];
    const state = fold(events);
    expect(state.history).toHaveLength(2);
    const dropped = dropPending(state);
    expect(dropped.history).toEqual(state.history);
    expect(dropped.pendingAssistant).toBeNull();
    expect(dropped.pendingTool).toBeNull();
  });

  it("[HA5.3] a new `start` resets any stale in-flight content from a previous aborted turn", () => {
    const aborted = fold([
      { type: "start", model: "m" },
      { type: "delta", text: "half" },
    ]);
    expect(aborted.pendingAssistant?.text).toBe("half");
    const restarted = accumulate(aborted, { type: "start", model: "m" });
    expect(restarted.pendingAssistant).toBeNull();
    expect(restarted.pendingTool).toBeNull();
    expect(restarted.history).toEqual(aborted.history);
  });
});

describe("accumulate — pre-shaped tool output", () => {
  it("[HA6.1] tool-result whose output already matches ToolResultOutput shape is NOT double-wrapped", () => {
    const events: AgentStreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "demo",
        input: {},
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "demo",
        output: { type: "text", value: "raw" },
      },
      { type: "finish" },
    ];
    const hist = histOf(events);
    const toolMsg = hist[1] as { content: Array<{ output: unknown }> };
    expect(toolMsg.content[0]?.output).toEqual({ type: "text", value: "raw" });
  });
});

describe("snapshotForRender", () => {
  it("[HA8.1] hides text-only pendingAssistant (the live streaming overlay shows it instead)", () => {
    const state = fold([
      { type: "start", model: "m" },
      { type: "delta", text: "typing" },
    ]);
    expect(snapshotForRender(state)).toEqual([]);
  });

  it("[HA8.2] surfaces pendingAssistant once it has a tool-call so the in-flight tool entry can render", () => {
    const state = fold([
      { type: "start", model: "m" },
      { type: "delta", text: "looking" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "x" },
      },
    ]);
    const snap = snapshotForRender(state);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "ripgrep",
          input: { pattern: "x" },
        },
      ],
    });
  });

  it("[HA8.3] surfaces pendingTool so a freshly-arrived result renders before the next text-delta flushes it", () => {
    const state = fold([
      { type: "start", model: "m" },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: {},
      },
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "ripgrep",
        output: { ok: true },
      },
    ]);
    const snap = snapshotForRender(state);
    expect(snap).toHaveLength(2);
    expect(snap[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "ripgrep",
          output: { type: "json", value: { ok: true } },
        },
      ],
    });
  });
});

describe("appendUserMessage", () => {
  it("[HA7.1] appends and drops any stale in-flight content (prior abort residue)", () => {
    const stale = fold([
      { type: "start", model: "m" },
      { type: "delta", text: "stuck" },
    ]);
    const next = appendUserMessage(stale, {
      role: "user",
      content: "继续刚才的",
    });
    expect(next.history).toEqual([
      { role: "user", content: "继续刚才的" },
    ]);
    expect(next.pendingAssistant).toBeNull();
    expect(next.pendingTool).toBeNull();
  });
});
