import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@lordcode/shared";
import { deriveEntries } from "./derive-entries.js";

describe("deriveEntries", () => {
  it("[DE1.1] empty history → empty entries", () => {
    expect(deriveEntries([])).toEqual([]);
  });

  it("[DE1.2] user(string) + assistant(string) → two MessageEntries", () => {
    const hist: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(deriveEntries(hist)).toEqual([
      { kind: "msg", role: "user", content: "hi" },
      { kind: "msg", role: "assistant", content: "hello" },
    ]);
  });

  it("[DE1.3] user content with image parts is preserved", () => {
    const hist: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this " },
          { type: "image", image: "AAA", mediaType: "image/png" },
        ],
      },
    ];
    expect(deriveEntries(hist)).toEqual([
      {
        kind: "msg",
        role: "user",
        content: [
          { type: "text", text: "look at this " },
          { type: "image", image: "AAA", mediaType: "image/png" },
        ],
      },
    ]);
  });
});

describe("deriveEntries — assistant + tool turns", () => {
  it("[DE2.1] single tool call with a result → text MessageEntry then ToolEntry(phase:result, unwrapped)", () => {
    const hist: ModelMessage[] = [
      { role: "user", content: "search" },
      {
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
      { role: "assistant", content: "no matches" },
    ];

    expect(deriveEntries(hist)).toEqual([
      { kind: "msg", role: "user", content: "search" },
      { kind: "msg", role: "assistant", content: "looking" },
      {
        kind: "tool",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "x" },
        phase: "result",
        output: { mode: "content", matches: [], truncated: false },
      },
      { kind: "msg", role: "assistant", content: "no matches" },
    ]);
  });

  it("[DE2.2] assistant array with only a tool-call (no text) → emits ToolEntry only, no naked 'ai ·' row", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "ripgrep",
            input: { pattern: "y" },
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
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ];

    expect(deriveEntries(hist)).toEqual([
      {
        kind: "tool",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "y" },
        phase: "result",
        output: { ok: true },
      },
    ]);
  });

  it("[DE2.3] orphan tool-call (no matching tool message) → phase stays 'call'", () => {
    const hist: ModelMessage[] = [
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
    ];

    expect(deriveEntries(hist)).toEqual([
      {
        kind: "tool",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "x" },
        phase: "call",
      },
    ]);
  });

  it("[DE2.4] synthesised tool-error payload (errored:true) lifts back to phase:error + errorMessage", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "ripgrep",
            input: { pattern: "[bad" },
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
              value: { error: "regex parse error", errored: true },
            },
          },
        ],
      },
    ];

    expect(deriveEntries(hist)).toEqual([
      {
        kind: "tool",
        toolCallId: "c1",
        toolName: "ripgrep",
        input: { pattern: "[bad" },
        phase: "error",
        errorMessage: "regex parse error",
      },
    ]);
  });

  it("[DE2.5] parallel tool calls in one assistant message render in order, each paired with its result", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "ripgrep",
            input: { pattern: "1" },
          },
          {
            type: "tool-call",
            toolCallId: "b",
            toolName: "ripgrep",
            input: { pattern: "2" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "ripgrep",
            output: { type: "json", value: { n: 1 } },
          },
          {
            type: "tool-result",
            toolCallId: "b",
            toolName: "ripgrep",
            output: { type: "json", value: { n: 2 } },
          },
        ],
      },
    ];

    const entries = deriveEntries(hist);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ toolCallId: "a", phase: "result", output: { n: 1 } });
    expect(entries[1]).toMatchObject({ toolCallId: "b", phase: "result", output: { n: 2 } });
  });

  it("[DE2.6] multi-text-part assistant collapses into a single text MessageEntry", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "part1 " },
          { type: "text", text: "part2" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "ripgrep",
            input: {},
          },
        ],
      },
    ];
    const entries = deriveEntries(hist);
    expect(entries[0]).toEqual({
      kind: "msg",
      role: "assistant",
      content: "part1 part2",
    });
    expect(entries[1]).toMatchObject({ kind: "tool", phase: "call" });
  });

  it("[DE2.7] text-only tool output (output.type === 'text') is unwrapped to a raw string", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "bash",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "text", value: "hi\n" },
          },
        ],
      },
    ];
    expect(deriveEntries(hist)[0]).toMatchObject({
      kind: "tool",
      phase: "result",
      output: "hi\n",
    });
  });
});
