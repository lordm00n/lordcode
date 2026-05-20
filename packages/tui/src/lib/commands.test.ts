import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  // C1.1
  it('[C1.1] "hello" → send', () => {
    expect(parseCommand("hello")).toEqual({ kind: "send", text: "hello" });
  });

  // C1.2
  it('[C1.2] "hello world" → send (preserves text)', () => {
    expect(parseCommand("hello world")).toEqual({
      kind: "send",
      text: "hello world",
    });
  });

  // C1.3
  it('[C1.3] "/models" → models', () => {
    expect(parseCommand("/models")).toEqual({ kind: "models" });
  });

  // C1.4
  it('[C1.4] "/models extra" → models (extra args ignored)', () => {
    expect(parseCommand("/models extra")).toEqual({ kind: "models" });
  });

  // C1.5
  it('[C1.5] "/model" → invalid (missing name)', () => {
    const r = parseCommand("/model");
    expect(r.kind).toBe("invalid");
  });

  // C1.6
  it('[C1.6] "/model " → invalid (whitespace only)', () => {
    const r = parseCommand("/model ");
    expect(r.kind).toBe("invalid");
  });

  // C1.7
  it('[C1.7] "/model gpt-4o" → set-model', () => {
    expect(parseCommand("/model gpt-4o")).toEqual({
      kind: "set-model",
      name: "gpt-4o",
    });
  });

  // C1.8
  it('[C1.8] "/model gpt-4o x" → set-model (extra args ignored)', () => {
    expect(parseCommand("/model gpt-4o x")).toEqual({
      kind: "set-model",
      name: "gpt-4o",
    });
  });

  // C1.9
  it('[C1.9] "/unknown" → invalid', () => {
    const r = parseCommand("/unknown");
    expect(r.kind).toBe("invalid");
  });

  // C1.10
  it('[C1.10] "/Model gpt" → invalid (case-sensitive)', () => {
    const r = parseCommand("/Model gpt");
    expect(r.kind).toBe("invalid");
  });

  // C1.11
  it('[C1.11] "/" → invalid (empty command name)', () => {
    const r = parseCommand("/");
    expect(r.kind).toBe("invalid");
  });

  // C1.12
  it('[C1.12] "hello /models" → send (slash not at start)', () => {
    expect(parseCommand("hello /models")).toEqual({
      kind: "send",
      text: "hello /models",
    });
  });

  it('[UT-14] "/new" → new-session', () => {
    expect(parseCommand("/new")).toEqual({ kind: "new-session" });
  });

  it('[UT-15] "/rename Project work" → rename-session', () => {
    expect(parseCommand("/rename Project work")).toEqual({
      kind: "rename-session",
      title: "Project work",
    });
  });

  it('[UT-15] "/rename" → invalid (missing title)', () => {
    const r = parseCommand("/rename");
    expect(r.kind).toBe("invalid");
  });

  it('[UT-10] "/sessions" → sessions', () => {
    expect(parseCommand("/sessions")).toEqual({ kind: "sessions" });
  });
});
