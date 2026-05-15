import { describe, expect, it } from "vitest";
import {
  formatToolCall,
  formatToolError,
  formatToolResult,
} from "./format-tool-call.js";

describe("formatToolCall", () => {
  it("[F1.1] ripgrep call: pattern first, types/globs included, default modes elided", () => {
    expect(
      formatToolCall("ripgrep", {
        pattern: "useState",
        type: "ts",
        outputMode: "content", // default — should be dropped
        headLimit: 100, // default — should be dropped
      }),
    ).toBe('ripgrep(pattern: "useState", type: "ts")');
  });

  it("[F1.2] ripgrep call: non-default outputMode and headLimit are kept", () => {
    expect(
      formatToolCall("ripgrep", {
        pattern: "x",
        outputMode: "files_with_matches",
        headLimit: 25,
      }),
    ).toBe(
      'ripgrep(pattern: "x", outputMode: "files_with_matches", headLimit: 25)',
    );
  });

  it("[F1.3] ripgrep call: long input is clipped with ellipsis", () => {
    const long = "a".repeat(200);
    const out = formatToolCall("ripgrep", { pattern: long });
    // Body includes the trailing ")" so total grows; `clip` is applied to the
    // inner arg list only — should at least end with an ellipsis.
    expect(out.length).toBeLessThan(120);
    expect(out).toMatch(/…\)$/);
  });

  it("[F1.4] unknown tool: falls back to JSON-ish preview", () => {
    expect(formatToolCall("future_tool", { x: 1, y: "z" })).toMatch(
      /future_tool\(.*\)/,
    );
  });
});

describe("formatToolResult", () => {
  it("[F2.1] content mode: counts unique files", () => {
    expect(
      formatToolResult("ripgrep", {
        mode: "content",
        truncated: false,
        matches: [
          { file: "a.ts", line: 1, text: "x" },
          { file: "a.ts", line: 2, text: "x" },
          { file: "b.ts", line: 9, text: "x" },
        ],
      }),
    ).toBe("3 matches in 2 files");
  });

  it("[F2.2] content mode: singular when 1 match in 1 file", () => {
    expect(
      formatToolResult("ripgrep", {
        mode: "content",
        truncated: false,
        matches: [{ file: "a.ts", line: 1, text: "x" }],
      }),
    ).toBe("1 match in 1 file");
  });

  it("[F2.3] content mode: appends `(truncated)` when output was capped", () => {
    expect(
      formatToolResult("ripgrep", {
        mode: "content",
        truncated: true,
        matches: [{ file: "a.ts", line: 1, text: "x" }],
      }),
    ).toBe("1 match in 1 file (truncated)");
  });

  it("[F2.4] files_with_matches: file count + singular/plural", () => {
    expect(
      formatToolResult("ripgrep", {
        mode: "files_with_matches",
        truncated: false,
        files: ["a.ts", "b.ts"],
      }),
    ).toBe("2 files");
    expect(
      formatToolResult("ripgrep", {
        mode: "files_with_matches",
        truncated: false,
        files: ["a.ts"],
      }),
    ).toBe("1 file");
  });

  it("[F2.5] count: sums per-file totals", () => {
    expect(
      formatToolResult("ripgrep", {
        mode: "count",
        truncated: false,
        counts: [
          { file: "a.ts", count: 3 },
          { file: "b.ts", count: 1 },
        ],
      }),
    ).toBe("4 matches across 2 files");
  });

  it("[F2.6] empty content mode: 0 matches in 0 files", () => {
    expect(
      formatToolResult("ripgrep", {
        mode: "content",
        truncated: false,
        matches: [],
      }),
    ).toBe("0 matches in 0 files");
  });
});

describe("formatToolError", () => {
  it("[F3.1] formats `<tool> failed: <message>`", () => {
    expect(formatToolError("ripgrep", "rg failed (exit 2): bad regex")).toBe(
      "ripgrep failed: rg failed (exit 2): bad regex",
    );
  });
});
