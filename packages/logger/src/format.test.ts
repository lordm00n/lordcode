import { describe, expect, it } from "vitest";
import { formatLine, formatRunHeader } from "./format.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("formatLine", () => {
  it("emits `[<iso>] <level5> [<channel>] <message>` for the simplest case", () => {
    const line = formatLine({
      level: "info",
      channel: ["server", "boot"],
      message: "hello",
    });
    const m = line.match(/^\[([^\]]+)\] (.{5}) \[([^\]]+)\] (.*)$/);
    expect(m, line).not.toBeNull();
    expect(m![1]).toMatch(ISO_RE);
    expect(m![2]).toBe("info "); // 5-char width with trailing space
    expect(m![3]).toBe("server:boot");
    expect(m![4]).toBe("hello");
  });

  it("right-pads `info` and `warn` to a 5-char level token", () => {
    expect(formatLine({ level: "info", channel: [], message: "x" })).toContain(
      "] info  ",
    );
    expect(formatLine({ level: "warn", channel: [], message: "x" })).toContain(
      "] warn  ",
    );
    expect(formatLine({ level: "debug", channel: [], message: "x" })).toContain(
      "] debug ",
    );
    expect(formatLine({ level: "error", channel: [], message: "x" })).toContain(
      "] error ",
    );
  });

  it("omits `[<channel>]` when channel path is empty (root logger)", () => {
    const line = formatLine({ level: "debug", channel: [], message: "x" });
    expect(line).not.toContain("[]");
    // Shape: "[iso] debug x"
    expect(line.endsWith(" x")).toBe(true);
  });

  it("flattens embedded newlines in message to a single space", () => {
    const line = formatLine({
      level: "info",
      channel: ["c"],
      message: "first\nsecond\nthird",
    });
    expect(line).toMatch(/first second third$/);
  });

  it("appends meta as space-separated key=value tokens", () => {
    const line = formatLine({
      level: "debug",
      channel: ["c"],
      message: "chunk",
      meta: { type: "text-delta", len: 42, finished: true },
    });
    expect(line).toContain(" type=text-delta");
    expect(line).toContain(" len=42");
    expect(line).toContain(" finished=true");
  });

  it("quotes meta values containing whitespace or `=`", () => {
    const line = formatLine({
      level: "info",
      channel: ["c"],
      message: "m",
      meta: { input: "hello world", expr: "a=b" },
    });
    expect(line).toContain(' input="hello world"');
    expect(line).toContain(' expr="a=b"');
  });

  it("escapes embedded quotes and backslashes in meta values", () => {
    const line = formatLine({
      level: "info",
      channel: ["c"],
      message: "m",
      meta: { s: 'he said "hi"\\there' },
    });
    expect(line).toContain('s="he said \\"hi\\"\\\\there"');
  });

  it("substitutes `<unserializable>` for circular meta values", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const line = formatLine({
      level: "info",
      channel: ["c"],
      message: "m",
      meta: { a },
    });
    expect(line).toContain("a=<unserializable>");
  });

  it("appends `err=<message>` and an indented stack continuation for Error", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at foo (a.ts:1:1)\n    at bar (b.ts:2:2)";
    const line = formatLine({
      level: "error",
      channel: ["c"],
      message: "failed",
      err,
    });
    const lines = line.split("\n");
    expect(lines[0]).toContain('err="boom"');
    expect(lines[1]).toBe("  Error: boom");
    expect(lines[2]).toBe("      at foo (a.ts:1:1)");
    expect(lines[3]).toBe("      at bar (b.ts:2:2)");
  });

  it("renders non-Error err as a string in `err=...` (no stack)", () => {
    const line = formatLine({
      level: "error",
      channel: ["c"],
      message: "x",
      err: "string err",
    });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain('err="string err"');
  });
});

describe("formatRunHeader", () => {
  it("renders the canonical `=== run start <iso> mode=... pid=... version=... ===`", () => {
    const at = new Date("2026-05-09T13:10:00.123Z");
    const header = formatRunHeader({
      mode: "dev",
      pid: 12345,
      version: "0.0.0",
      startedAt: at,
    });
    expect(header).toBe(
      "=== run start 2026-05-09T13:10:00.123Z mode=dev pid=12345 version=0.0.0 ===",
    );
  });

  it("defaults `startedAt` to `new Date()` (ISO-8601 with ms)", () => {
    const header = formatRunHeader({
      mode: "release",
      pid: 1,
      version: "1.2.3",
    });
    const m = header.match(
      /^=== run start (\S+) mode=release pid=1 version=1\.2\.3 ===$/,
    );
    expect(m, header).not.toBeNull();
    expect(m![1]).toMatch(ISO_RE);
  });
});
