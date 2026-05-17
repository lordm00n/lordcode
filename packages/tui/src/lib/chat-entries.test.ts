import { describe, expect, it } from "vitest";
import {
  buildAssistantSegment,
  collapseMessageEntries,
  upgradeToolEntry,
  type Entry,
  type MessageEntry,
  type ToolEntry,
} from "./chat-entries.js";

describe("buildAssistantSegment", () => {
  it("[CE1.1] empty text + no reasoning → null (don't emit empty 'ai ·' rows)", () => {
    expect(buildAssistantSegment("", null)).toBeNull();
  });

  it("[CE1.2] non-empty text → entry with content only", () => {
    expect(buildAssistantSegment("hello", null)).toEqual({
      kind: "msg",
      role: "assistant",
      content: "hello",
    });
  });

  it("[CE1.3] empty text but reasoning measured → entry with reasoningDurationMs so 'Thought for Xs' still renders", () => {
    expect(buildAssistantSegment("", 1234)).toEqual({
      kind: "msg",
      role: "assistant",
      content: "",
      reasoningDurationMs: 1234,
    });
  });

  it("[CE1.4] both text and reasoning → entry carries both", () => {
    expect(buildAssistantSegment("hi", 42)).toEqual({
      kind: "msg",
      role: "assistant",
      content: "hi",
      reasoningDurationMs: 42,
    });
  });
});

describe("upgradeToolEntry", () => {
  const callEntry = (id: string): ToolEntry => ({
    kind: "tool",
    toolCallId: id,
    toolName: "ripgrep",
    input: { pattern: "x" },
    phase: "call",
  });

  it("[CE2.1] matching id → replaces in place, leaves siblings untouched", () => {
    const a = callEntry("a");
    const b = callEntry("b");
    const prev: Entry[] = [
      { kind: "msg", role: "user", content: "go" },
      a,
      b,
    ];
    const next = upgradeToolEntry(
      prev,
      "a",
      (e) => ({ ...e, phase: "result", output: { ok: true } }),
      a,
    );
    expect(next).toEqual([
      { kind: "msg", role: "user", content: "go" },
      { ...a, phase: "result", output: { ok: true } },
      b,
    ]);
  });

  it("[CE2.2] no match → appends fallback so a stray tool-result is still visible", () => {
    const fallback: ToolEntry = {
      kind: "tool",
      toolCallId: "z",
      toolName: "ripgrep",
      input: undefined,
      phase: "result",
      output: { ok: true },
    };
    const prev: Entry[] = [{ kind: "msg", role: "user", content: "go" }];
    const next = upgradeToolEntry(prev, "z", (e) => e, fallback);
    expect(next).toEqual([
      { kind: "msg", role: "user", content: "go" },
      fallback,
    ]);
  });
});

describe("collapseMessageEntries", () => {
  const user = (text: string): MessageEntry => ({
    kind: "msg",
    role: "user",
    content: text,
  });
  const assistant = (text: string, ms?: number): MessageEntry => ({
    kind: "msg",
    role: "assistant",
    content: text,
    ...(ms != null ? { reasoningDurationMs: ms } : {}),
  });

  it("[CE3.1] no entries → empty wire array", () => {
    expect(collapseMessageEntries([])).toEqual([]);
  });

  it("[CE3.2] alternating user/assistant → preserved 1:1, reasoning metadata stripped", () => {
    expect(
      collapseMessageEntries([user("hi"), assistant("hello", 999)]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("[CE3.3] consecutive assistant string segments (text→tool→text turn) → merged into a single assistant message", () => {
    const wire = collapseMessageEntries([
      user("do it"),
      assistant("ok let me check "),
      assistant("done"),
    ]);
    expect(wire).toEqual([
      { role: "user", content: "do it" },
      { role: "assistant", content: "ok let me check done" },
    ]);
  });

  it("[CE3.4] three-segment turn (text → tool → text → tool → text) collapses to one assistant message", () => {
    const wire = collapseMessageEntries([
      user("go"),
      assistant("first "),
      assistant("second "),
      assistant("third"),
    ]);
    expect(wire).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "first second third" },
    ]);
  });

  it("[CE3.5] consecutive assistant entries across separate turns get merged too — server sees one assistant message between user turns", () => {
    const wire = collapseMessageEntries([
      user("turn 1"),
      assistant("answer 1"),
      user("turn 2"),
      assistant("part a "),
      assistant("part b"),
    ]);
    expect(wire).toEqual([
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "part a part b" },
    ]);
  });

  it("[CE3.6] does NOT collapse adjacent user entries (they only appear via paste flow, never back-to-back in practice, but be safe)", () => {
    const wire = collapseMessageEntries([user("a"), user("b")]);
    expect(wire).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
  });

  it("[CE3.7] assistant entry with ContentPart[] content (hypothetical future shape) is left alone — merging would lose structure", () => {
    const multimodal: MessageEntry = {
      kind: "msg",
      role: "assistant",
      content: [{ type: "text", text: "structured" }],
    };
    const wire = collapseMessageEntries([
      assistant("plain "),
      multimodal,
      assistant("tail"),
    ]);
    expect(wire).toEqual([
      { role: "assistant", content: "plain " },
      { role: "assistant", content: [{ type: "text", text: "structured" }] },
      { role: "assistant", content: "tail" },
    ]);
  });

  it("[CE3.8] user content with image parts is preserved exactly (no merge with surrounding strings)", () => {
    const wire = collapseMessageEntries([
      {
        kind: "msg",
        role: "user",
        content: [
          { type: "text", text: "see this " },
          { type: "image", image: "AAA", mediaType: "image/png" },
        ],
      },
      assistant("got it"),
    ]);
    expect(wire).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see this " },
          { type: "image", image: "AAA", mediaType: "image/png" },
        ],
      },
      { role: "assistant", content: "got it" },
    ]);
  });
});
