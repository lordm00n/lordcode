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

  it("[F1.5] glob call: pattern first and default values elided", () => {
    expect(
      formatToolCall("glob", {
        pattern: "**/*.ts",
        includeHidden: false,
        exclude: [],
        headLimit: 100,
      }),
    ).toBe('glob(pattern: "**/*.ts")');
  });

  it("[F1.6] glob call: non-default options are included", () => {
    expect(
      formatToolCall("glob", {
        pattern: "*.ts",
        path: "s",
        exclude: ["x"],
        includeHidden: true,
        headLimit: 25,
      }),
    ).toBe(
      'glob(pattern: "*.ts", path: "s", exclude: ["x"], includeHidden: true, headLimit: 25)',
    );
  });

  it("[F1.7] read_file call: path-only is rendered minimally", () => {
    expect(formatToolCall("read_file", { path: "a.ts" })).toBe(
      'read_file(path: "a.ts")',
    );
  });

  it("[F1.8] read_file call: default offset=1 / limit=2000 are elided", () => {
    expect(
      formatToolCall("read_file", {
        path: "a.ts",
        offset: 1,
        limit: 2000,
      }),
    ).toBe('read_file(path: "a.ts")');
  });

  it("[F1.9] read_file call: non-default offset/limit are kept", () => {
    expect(
      formatToolCall("read_file", {
        path: "a.ts",
        offset: 100,
        limit: 50,
      }),
    ).toBe('read_file(path: "a.ts", offset: 100, limit: 50)');
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

  it("[F2.7] glob result: counts files with singular/plural and truncation", () => {
    expect(
      formatToolResult("glob", {
        files: ["a.ts"],
        truncated: false,
      }),
    ).toBe("1 file");

    expect(
      formatToolResult("glob", {
        files: ["a.ts", "b.ts"],
        truncated: true,
      }),
    ).toBe("2 files (truncated)");
  });

  it("[F2.8] glob result: malformed output falls back to preview", () => {
    expect(formatToolResult("glob", "oops")).toBe('"oops"');
  });

  it("[F2.9] read_file text result: line range and totals", () => {
    expect(
      formatToolResult("read_file", {
        kind: "text",
        path: "/abs/a.ts",
        content: "",
        startLine: 1,
        endLine: 50,
        totalLines: 200,
        truncated: true,
        lineTruncated: false,
      }),
    ).toBe("50 lines (1-50 of 200) (truncated)");
  });

  it("[F2.10] read_file text result: lineTruncated only", () => {
    expect(
      formatToolResult("read_file", {
        kind: "text",
        path: "/abs/a.ts",
        content: "",
        startLine: 1,
        endLine: 10,
        totalLines: 10,
        truncated: false,
        lineTruncated: true,
      }),
    ).toBe("10 lines (1-10 of 10) (lines clipped)");
  });

  it("[F2.11] read_file text result: empty window when offset > totalLines", () => {
    expect(
      formatToolResult("read_file", {
        kind: "text",
        path: "/abs/a.ts",
        content: "",
        startLine: 100,
        endLine: 99,
        totalLines: 3,
        truncated: false,
        lineTruncated: false,
      }),
    ).toBe("0 lines (100-99 of 3)");
  });

  it("[F2.12] read_file image result: humanised size + media type", () => {
    expect(
      formatToolResult("read_file", {
        kind: "image",
        path: "/abs/img.png",
        mediaType: "image/png",
        byteSize: 1234,
        base64: "x",
      }),
    ).toBe("image (1.2 KB, image/png)");
  });

  it("[F2.13] read_file image result: bytes < 1024 stay in B", () => {
    expect(
      formatToolResult("read_file", {
        kind: "image",
        path: "/abs/img.png",
        mediaType: "image/png",
        byteSize: 67,
        base64: "x",
      }),
    ).toBe("image (67 B, image/png)");
  });

  it("[F2.14] read_file: malformed output falls back to preview", () => {
    expect(formatToolResult("read_file", "broken")).toBe('"broken"');
  });

  it("[F2.15] bash result: exit 0 with line count", () => {
    expect(
      formatToolResult("bash", {
        exitCode: 0,
        stdout: "line1\nline2\nline3\n",
        stderr: "",
        truncated: false,
        killed: false,
      }),
    ).toBe("exit 0 · 3 lines");
  });

  it("[F2.16] bash result: non-zero exit code", () => {
    expect(
      formatToolResult("bash", {
        exitCode: 1,
        stdout: "",
        stderr: "error: not found\n",
        truncated: false,
        killed: false,
      }),
    ).toBe("exit 1 · 1 line");
  });

  it("[F2.17] bash result: killed with timeout", () => {
    expect(
      formatToolResult("bash", {
        exitCode: 143,
        stdout: "partial\noutput\n",
        stderr: "",
        truncated: false,
        killed: true,
      }),
    ).toBe("killed · exit 143 · 2 lines · (timeout)");
  });

  it("[F2.18] bash result: truncated output", () => {
    expect(
      formatToolResult("bash", {
        exitCode: 0,
        stdout: "lots of output\n",
        stderr: "",
        truncated: true,
        killed: false,
      }),
    ).toBe("exit 0 · 1 line · (truncated)");
  });

  it("[F2.19] bash result: killed + truncated (no timeout suffix)", () => {
    expect(
      formatToolResult("bash", {
        exitCode: 137,
        stdout: "x\ny\n",
        stderr: "z\n",
        truncated: true,
        killed: true,
      }),
    ).toBe("killed · exit 137 · 3 lines · (truncated)");
  });

  it("[F2.20] bash result: malformed output falls back to preview", () => {
    expect(formatToolResult("bash", "oops")).toBe('"oops"');
  });
});

describe("formatToolCall — bash", () => {
  it("[F1.10] bash call: shows command, elides default timeout", () => {
    expect(
      formatToolCall("bash", { command: "npm test", timeout: 30000 }),
    ).toBe('bash(command: "npm test")');
  });

  it("[F1.11] bash call: shows non-default timeout", () => {
    expect(
      formatToolCall("bash", { command: "npm run build", timeout: 120000 }),
    ).toBe('bash(command: "npm run build", timeout: 120000)');
  });

  it("[F1.12] bash call: includes cwd when provided", () => {
    expect(
      formatToolCall("bash", { command: "ls", cwd: "packages/server", timeout: 30000 }),
    ).toBe('bash(command: "ls", cwd: "packages/server")');
  });

  it("[F1.13] bash call: long commands are clipped", () => {
    const long = "a".repeat(200);
    const out = formatToolCall("bash", { command: long, timeout: 30000 });
    expect(out.length).toBeLessThan(120);
    expect(out).toMatch(/…\)$/);
  });
});

describe("formatToolError", () => {
  it("[F3.1] formats `<tool> failed: <message>`", () => {
    expect(formatToolError("ripgrep", "rg failed (exit 2): bad regex")).toBe(
      "ripgrep failed: rg failed (exit 2): bad regex",
    );
  });

  it("[F3.2] read_file error reuses the same shape", () => {
    expect(
      formatToolError("read_file", "ENOENT: file not found: /abs/x.ts"),
    ).toBe("read_file failed: ENOENT: file not found: /abs/x.ts");
  });
});
