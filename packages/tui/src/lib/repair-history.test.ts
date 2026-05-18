import { describe, expect, it } from "vitest";
import type { ModelMessage } from "@lordcode/shared";
import { repairOrphanToolCalls } from "./repair-history.js";

const synthetic = (toolCallId: string, toolName: string) => ({
  type: "tool-result" as const,
  toolCallId,
  toolName,
  output: {
    type: "json" as const,
    value: { interrupted: true, reason: "user_cancelled" },
  },
});

describe("repairOrphanToolCalls", () => {
  it("[RH1.1] empty array → empty array", () => {
    expect(repairOrphanToolCalls([])).toEqual([]);
  });

  it("[RH1.2] history with no tool-calls → identity", () => {
    const hist: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(repairOrphanToolCalls(hist)).toEqual(hist);
  });

  it("[RH1.3] every tool-call already has a matching result → identity", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
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
            toolCallId: "a",
            toolName: "ripgrep",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ];
    expect(repairOrphanToolCalls(hist)).toEqual(hist);
  });

  it("[RH1.4] orphan tool-call with NO following tool message → inserts a tool message with synthetic cancelled result", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "ripgrep",
            input: { pattern: "x" },
          },
        ],
      },
      { role: "user", content: "继续" },
    ];
    expect(repairOrphanToolCalls(hist)).toEqual([
      hist[0],
      { role: "tool", content: [synthetic("a", "ripgrep")] },
      hist[1],
    ]);
  });

  it("[RH1.5] partial match: assistant has calls a+b, tool message has only result a → appends synthetic b", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
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
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "ripgrep",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ];
    const repaired = repairOrphanToolCalls(hist);
    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toBe(hist[0]);
    expect(repaired[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "ripgrep",
          output: { type: "json", value: { ok: true } },
        },
        synthetic("b", "ripgrep"),
      ],
    });
  });

  it("[RH1.6] orphan at end of history (mid-tool abort, then user resumed) → inserts before subsequent user", () => {
    const hist: ModelMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      { role: "user", content: "继续刚才的" },
    ];
    const repaired = repairOrphanToolCalls(hist);
    expect(repaired).toEqual([
      hist[0],
      hist[1],
      { role: "tool", content: [synthetic("a", "bash")] },
      hist[2],
    ]);
  });

  it("[RH1.7] multiple orphans across separate assistant messages all get patched independently", () => {
    const hist: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "a",
            toolName: "ripgrep",
            input: {},
          },
        ],
      },
      { role: "user", content: "ok" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "b",
            toolName: "ripgrep",
            input: {},
          },
        ],
      },
    ];
    const repaired = repairOrphanToolCalls(hist);
    expect(repaired).toEqual([
      hist[0],
      { role: "tool", content: [synthetic("a", "ripgrep")] },
      hist[1],
      hist[2],
      { role: "tool", content: [synthetic("b", "ripgrep")] },
    ]);
  });

  it("[RH1.8] string-content assistant (text-only) is left alone even when followed by a tool message", () => {
    const hist: ModelMessage[] = [
      { role: "assistant", content: "plain text" },
      { role: "user", content: "next" },
    ];
    expect(repairOrphanToolCalls(hist)).toEqual(hist);
  });
});
