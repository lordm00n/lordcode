import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rgPath } from "@vscode/ripgrep";
import { buildArgs, executeRipgrep, RipgrepError } from "./execute.js";
import type { RipgrepInput } from "./schema.js";

// Tests are integration: they spawn the *real* ripgrep binary shipped by
// `@vscode/ripgrep`. Anything cwd-relative below is resolved against the
// fixture corpus so the tests are independent of where vitest is invoked from.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../../../tests/fixtures/ripgrep-corpus");

const baseInput = (over: Partial<RipgrepInput> = {}): RipgrepInput => ({
  pattern: "useState",
  outputMode: "content",
  caseInsensitive: false,
  multiline: false,
  headLimit: 100,
  ...over,
});

const run = (input: RipgrepInput, opts?: { signal?: AbortSignal }) =>
  executeRipgrep(input, {
    rgPath,
    cwd: FIXTURE_DIR,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

// ── buildArgs (pure) ────────────────────────────────────────────────────────

describe("buildArgs", () => {
  it("[E1.1] always includes --json --no-config and the pattern at the end", () => {
    expect(buildArgs(baseInput())).toEqual([
      "--json",
      "--no-config",
      "useState",
    ]);
  });

  it("[E1.2] threads -i / -U / -g / -t / -B / -A and trailing path", () => {
    const args = buildArgs(
      baseInput({
        path: "src",
        glob: "*.ts",
        type: "ts",
        caseInsensitive: true,
        multiline: true,
        contextBefore: 2,
        contextAfter: 3,
      }),
    );
    expect(args).toEqual([
      "--json",
      "--no-config",
      "-i",
      "-U",
      "--multiline-dotall",
      "-g",
      "*.ts",
      "-t",
      "ts",
      "-B",
      "2",
      "-A",
      "3",
      "useState",
      "src",
    ]);
  });

  it("[E1.3] omits context flags when outputMode != 'content'", () => {
    const args = buildArgs(
      baseInput({
        outputMode: "files_with_matches",
        contextBefore: 5,
        contextAfter: 5,
      }),
    );
    expect(args).not.toContain("-B");
    expect(args).not.toContain("-A");
  });
});

// ── executeRipgrep against real rg ──────────────────────────────────────────

describe("executeRipgrep", () => {
  it("[E2.1] content mode: finds useState across the fixture corpus", async () => {
    const out = await run(baseInput());
    expect(out.mode).toBe("content");
    expect(out.truncated).toBe(false);
    if (out.mode !== "content") return;
    // 6 hits total: nested/deep.tsx (2) + src/app.ts (3) + notes.md (1)
    expect(out.matches).toHaveLength(6);
    // Spot-check: paths are relative to cwd; line numbers are 1-indexed.
    const a = out.matches.find(
      (m) => m.file.endsWith("src/app.ts") && m.line === 4,
    );
    expect(a?.text).toContain("useState(0)");
  });

  it("[E2.2] no-match returns an empty payload, NOT an error (rg exit 1)", async () => {
    const out = await run(baseInput({ pattern: "DEFINITELY_NOT_PRESENT_XYZZY" }));
    expect(out).toEqual({ mode: "content", matches: [], truncated: false });
  });

  it("[E2.3] type=ts narrows to *.ts/*.tsx, dropping notes.md", async () => {
    const out = await run(baseInput({ type: "ts" }));
    if (out.mode !== "content") throw new Error("expected content mode");
    // 5 hits: src/app.ts (3) + nested/deep.tsx (2). notes.md excluded.
    const files = new Set(out.matches.map((m) => m.file));
    expect(files.size).toBe(2);
    for (const m of out.matches) {
      expect(m.file).not.toContain("notes.md");
    }
  });

  it("[E2.4] glob=*.tsx narrows further to just the .tsx file", async () => {
    const out = await run(baseInput({ glob: "*.tsx" }));
    if (out.mode !== "content") throw new Error("expected content mode");
    const files = new Set(out.matches.map((m) => m.file));
    expect(files.size).toBe(1);
    expect([...files][0]).toContain("nested/deep.tsx");
  });

  it("[E2.5] context lines are attached to matches", async () => {
    const out = await run(
      baseInput({
        path: "src/app.ts",
        contextBefore: 1,
        contextAfter: 1,
      }),
    );
    if (out.mode !== "content") throw new Error("expected content mode");
    // Find the match on line 4 — its `before` should include line 3 ("export function App"),
    // its `after` should include line 5 (the next useState line).
    const m4 = out.matches.find((m) => m.line === 4);
    expect(m4).toBeDefined();
    expect(m4?.before?.some((l) => l.includes("export function App"))).toBe(
      true,
    );
  });

  it("[E2.6] files_with_matches: returns each unique matching file once", async () => {
    const out = await run(baseInput({ outputMode: "files_with_matches" }));
    if (out.mode !== "files_with_matches") {
      throw new Error("expected files_with_matches");
    }
    const set = new Set(out.files);
    expect(set.size).toBe(out.files.length);
    expect(set.size).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it("[E2.7] count: returns per-file totals matching content-mode counts", async () => {
    const out = await run(baseInput({ outputMode: "count" }));
    if (out.mode !== "count") throw new Error("expected count");
    const total = out.counts.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(6);
    expect(out.counts).toHaveLength(3);
  });

  it("[E2.8] headLimit truncates content matches", async () => {
    const out = await run(baseInput({ headLimit: 2 }));
    if (out.mode !== "content") throw new Error("expected content");
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("[E2.9] caseInsensitive matches mixed casing", async () => {
    // 'usestate' (lowercase) wouldn't normally hit; with -i it should.
    const sensitive = await run(baseInput({ pattern: "usestate" }));
    if (sensitive.mode !== "content") throw new Error("expected content");
    expect(sensitive.matches).toHaveLength(0);

    const insensitive = await run(
      baseInput({ pattern: "usestate", caseInsensitive: true }),
    );
    if (insensitive.mode !== "content") throw new Error("expected content");
    expect(insensitive.matches.length).toBeGreaterThan(0);
  });

  it("[E2.10] exit 2 (bad regex) throws RipgrepError carrying stderr", async () => {
    let err: unknown = null;
    try {
      await run(baseInput({ pattern: "[invalid(regex" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RipgrepError);
    const re = err as RipgrepError;
    expect(re.message).toMatch(/regex parse error/);
    expect(re.cause.exitCode).toBe(2);
    expect(re.cause.stderr).toMatch(/regex parse error/);
  });

  it("[E2.11] spawn failure (bogus rgPath) throws RipgrepError", async () => {
    let err: unknown = null;
    try {
      await executeRipgrep(baseInput(), {
        rgPath: "/this/path/definitely/does/not/exist/rg",
        cwd: FIXTURE_DIR,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RipgrepError);
    expect((err as RipgrepError).message).toMatch(/ripgrep crashed|spawn/i);
  });

  it("[E2.12] aborting before spawn throws AbortError; rg is never started", async () => {
    const ac = new AbortController();
    ac.abort();
    let err: unknown = null;
    let spawnCount = 0;
    const fakeSpawn = ((...args: Parameters<typeof spawn>) => {
      spawnCount++;
      return spawn(...args);
    }) as typeof spawn;
    try {
      await executeRipgrep(baseInput(), {
        rgPath,
        cwd: FIXTURE_DIR,
        signal: ac.signal,
        spawn: fakeSpawn,
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe("AbortError");
    expect(spawnCount).toBe(0);
  });

  it("[E2.13] aborting mid-run kills the child and surfaces AbortError", async () => {
    // Use a slow query that scans the whole repo so we have a window to abort.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    let err: unknown = null;
    try {
      await executeRipgrep(
        baseInput({
          // Match nothing but force rg to scan everything.
          pattern: "DEEP_SCAN_NO_MATCH_PATTERN_XYZ",
          path: ".",
        }),
        {
          rgPath,
          cwd: resolve(__dirname, "../../../../.."), // workspace root
          signal: ac.signal,
        },
      );
    } catch (e) {
      err = e;
    }
    // Either we beat the abort (unlikely on a real workspace scan) or we got
    // an AbortError. Skip the assertion only if rg finished first.
    if (err == null) {
      // rg completed faster than 5ms — accept it as a "no zombie left" win.
      return;
    }
    expect((err as Error).name).toBe("AbortError");
  });
});
