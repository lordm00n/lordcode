import { describe, expect, it, vi } from "vitest";
import { parseRipgrepJsonLines } from "./parse.js";

// Helpers that produce real `rg --json` shapes (verified against ripgrep 15.0.0).

const begin = (path: string): string =>
  JSON.stringify({ type: "begin", data: { path: { text: path } } });

const match = (
  path: string,
  line: number,
  text: string,
  submatches: { start: number; end: number; text: string }[] = [],
): string =>
  JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: submatches.map((s) => ({
        match: { text: s.text },
        start: s.start,
        end: s.end,
      })),
    },
  });

const ctx = (path: string, line: number, text: string): string =>
  JSON.stringify({
    type: "context",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: [],
    },
  });

const end = (path: string): string =>
  JSON.stringify({
    type: "end",
    data: { path: { text: path }, binary_offset: null },
  });

const summary = JSON.stringify({
  type: "summary",
  data: { stats: {} },
});

describe("parseRipgrepJsonLines", () => {
  // ── content mode ──────────────────────────────────────────────────────────

  it("[P1.1] folds begin/match/end into matches; strips trailing newline", () => {
    const out = parseRipgrepJsonLines(
      [
        begin("a.ts"),
        match("a.ts", 12, "  const x = useState(0)\n", [
          { start: 14, end: 22, text: "useState" },
        ]),
        match("a.ts", 30, "useState\n", [
          { start: 0, end: 8, text: "useState" },
        ]),
        end("a.ts"),
        summary,
      ],
      { outputMode: "content", headLimit: 100 },
    );
    expect(out).toEqual({
      mode: "content",
      truncated: false,
      matches: [
        { file: "a.ts", line: 12, text: "  const x = useState(0)" },
        { file: "a.ts", line: 30, text: "useState" },
      ],
    });
  });

  it("[P1.2] returns empty matches on a no-match summary-only stream", () => {
    const out = parseRipgrepJsonLines([summary], {
      outputMode: "content",
      headLimit: 100,
    });
    expect(out).toEqual({ mode: "content", matches: [], truncated: false });
  });

  it("[P1.3] preserves CRLF correctly: strips \\r\\n but keeps interior \\r", () => {
    const out = parseRipgrepJsonLines(
      [
        begin("win.txt"),
        match("win.txt", 1, "hello\r\nworld\r\n", []),
        end("win.txt"),
      ],
      { outputMode: "content", headLimit: 100 },
    );
    // The full match line as ripgrep would have given us is "hello\r\nworld\r\n"
    // (multiline mode). We strip a single trailing CRLF only.
    expect((out as { matches: { text: string }[] }).matches[0]!.text).toBe(
      "hello\r\nworld",
    );
  });

  it("[P1.4] correctly partitions context between prev.after and next.before", () => {
    // Layout (with the rg call: -B 2 -A 2):
    //   line 1 ctx → before of match 3
    //   line 2 ctx → before of match 3
    //   line 3 MATCH
    //   line 4 ctx → after of match 3 AND/OR before of match 7? — partition by window
    //   line 5 ctx → before of match 7 (5 >= 7-2)
    //   line 6 ctx → before of match 7 (6 >= 7-2)
    //   line 7 MATCH
    //   line 8 ctx → after of match 7
    const out = parseRipgrepJsonLines(
      [
        begin("file.ts"),
        ctx("file.ts", 1, "line one\n"),
        ctx("file.ts", 2, "line two\n"),
        match("file.ts", 3, "match three\n"),
        ctx("file.ts", 4, "line four\n"),
        ctx("file.ts", 5, "line five\n"),
        ctx("file.ts", 6, "line six\n"),
        match("file.ts", 7, "match seven\n"),
        ctx("file.ts", 8, "line eight\n"),
        end("file.ts"),
      ],
      {
        outputMode: "content",
        headLimit: 100,
        contextBefore: 2,
        contextAfter: 2,
      },
    );
    const matches = (out as {
      matches: { text: string; before?: string[]; after?: string[] }[];
    }).matches;
    expect(matches).toHaveLength(2);
    // line 1 ∈ [3-2, 3-1] = [1, 2] → before of match 3 ✓
    // line 2 ∈ [1, 2] → before of match 3 ✓
    expect(matches[0]).toEqual({
      file: "file.ts",
      line: 3,
      text: "match three",
      before: ["line one", "line two"],
      // line 4 ∈ [4, 5] (after of 3) → after of match 3
      after: ["line four"],
    });
    // line 5 ∈ [5, 6] (before window of 7) → before of match 7
    // line 6 ∈ [5, 6] → before of match 7
    // line 8 ∈ [8, 9] (after of 7) → after of match 7
    expect(matches[1]).toEqual({
      file: "file.ts",
      line: 7,
      text: "match seven",
      before: ["line five", "line six"],
      after: ["line eight"],
    });
  });

  it("[P1.4b] without context windows, context arriving between matches uses tie-break", () => {
    // No contextBefore/contextAfter passed: every context line is "ambiguous"
    // and tie-broken by line distance to the nearest anchor.
    const out = parseRipgrepJsonLines(
      [
        begin("f.ts"),
        match("f.ts", 1, "m1\n"),
        ctx("f.ts", 2, "c2\n"), // dist after=1, before(=4)=2 → after of 1
        ctx("f.ts", 3, "c3\n"), // dist after=2, before(=4)=1 → before of 4
        match("f.ts", 4, "m4\n"),
        end("f.ts"),
      ],
      { outputMode: "content", headLimit: 100 },
    );
    const matches = (out as { matches: { line: number; before?: string[]; after?: string[] }[] }).matches;
    expect(matches[0]).toMatchObject({ line: 1, after: ["c2"] });
    expect(matches[1]).toMatchObject({ line: 4, before: ["c3"] });
  });

  it("[P1.5] truncates content matches at headLimit but keeps consuming the stream", () => {
    const lines: string[] = [begin("big.ts")];
    for (let i = 1; i <= 250; i++) {
      lines.push(match("big.ts", i, `line ${i}\n`));
    }
    lines.push(end("big.ts"), summary);

    const out = parseRipgrepJsonLines(lines, {
      outputMode: "content",
      headLimit: 100,
    });
    const matches = (out as { matches: unknown[] }).matches;
    expect(matches).toHaveLength(100);
    expect(out.truncated).toBe(true);
  });

  // ── files_with_matches mode ───────────────────────────────────────────────

  it("[P2.1] files_with_matches: lists each file once, in rg traversal order", () => {
    const out = parseRipgrepJsonLines(
      [
        begin("z.ts"),
        match("z.ts", 1, "x\n"),
        match("z.ts", 4, "x\n"),
        end("z.ts"),
        begin("a.ts"),
        match("a.ts", 2, "x\n"),
        end("a.ts"),
        summary,
      ],
      { outputMode: "files_with_matches", headLimit: 100 },
    );
    expect(out).toEqual({
      mode: "files_with_matches",
      files: ["z.ts", "a.ts"],
      truncated: false,
    });
  });

  it("[P2.2] files_with_matches: skips files whose `end` arrives without a `match`", () => {
    // Should be impossible in practice (rg only opens a `begin` on a hit), but
    // we defend against it anyway to avoid phantom entries from upstream noise.
    const out = parseRipgrepJsonLines(
      [
        begin("ghost.ts"),
        end("ghost.ts"),
        begin("real.ts"),
        match("real.ts", 1, "x\n"),
        end("real.ts"),
      ],
      { outputMode: "files_with_matches", headLimit: 100 },
    );
    expect((out as { files: string[] }).files).toEqual(["real.ts"]);
  });

  it("[P2.3] files_with_matches: truncates at headLimit files, sets truncated=true", () => {
    const lines: string[] = [];
    for (let i = 0; i < 7; i++) {
      const f = `f${i}.ts`;
      lines.push(begin(f), match(f, 1, "x\n"), end(f));
    }
    const out = parseRipgrepJsonLines(lines, {
      outputMode: "files_with_matches",
      headLimit: 3,
    });
    expect(out).toEqual({
      mode: "files_with_matches",
      files: ["f0.ts", "f1.ts", "f2.ts"],
      truncated: true,
    });
  });

  // ── count mode ────────────────────────────────────────────────────────────

  it("[P3.1] count: aggregates per-file match counts in traversal order", () => {
    const out = parseRipgrepJsonLines(
      [
        begin("a.ts"),
        match("a.ts", 1, "x\n"),
        match("a.ts", 2, "x\n"),
        match("a.ts", 3, "x\n"),
        end("a.ts"),
        begin("b.ts"),
        match("b.ts", 1, "x\n"),
        end("b.ts"),
      ],
      { outputMode: "count", headLimit: 100 },
    );
    expect(out).toEqual({
      mode: "count",
      counts: [
        { file: "a.ts", count: 3 },
        { file: "b.ts", count: 1 },
      ],
      truncated: false,
    });
  });

  it("[P3.2] count: truncates the file list (not the per-file totals)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = `f${i}.ts`;
      lines.push(
        begin(f),
        match(f, 1, "x\n"),
        match(f, 2, "x\n"),
        end(f),
      );
    }
    const out = parseRipgrepJsonLines(lines, {
      outputMode: "count",
      headLimit: 2,
    });
    expect(out).toEqual({
      mode: "count",
      counts: [
        { file: "f0.ts", count: 2 },
        { file: "f1.ts", count: 2 },
      ],
      truncated: true,
    });
  });

  // ── robustness ────────────────────────────────────────────────────────────

  it("[P4.1] tolerates empty / blank lines without warning", () => {
    const out = parseRipgrepJsonLines(
      ["", begin("x.ts"), match("x.ts", 1, "y\n"), "", end("x.ts"), ""],
      { outputMode: "content", headLimit: 100 },
    );
    expect((out as { matches: unknown[] }).matches).toHaveLength(1);
  });

  it("[P4.2] logs and skips a malformed JSON line, then continues parsing", () => {
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: () => logger,
    } as unknown as import("@lordcode/logger").Logger;

    const out = parseRipgrepJsonLines(
      [
        begin("a.ts"),
        "{not really json",
        match("a.ts", 1, "ok\n"),
        end("a.ts"),
      ],
      { outputMode: "content", headLimit: 100, logger },
    );
    expect((out as { matches: unknown[] }).matches).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("parse error"),
      expect.any(Object),
    );
  });

  it("[P4.3] silently ignores unknown chunk types (forward compat with future rg)", () => {
    const out = parseRipgrepJsonLines(
      [
        JSON.stringify({ type: "future-thing", data: {} }),
        begin("a.ts"),
        match("a.ts", 1, "x\n"),
        end("a.ts"),
      ],
      { outputMode: "content", headLimit: 100 },
    );
    expect((out as { matches: unknown[] }).matches).toHaveLength(1);
  });
});
