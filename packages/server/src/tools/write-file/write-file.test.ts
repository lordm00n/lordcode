import { promises as realFs } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { executeWriteFile, WriteFileError, MAX_CONTENT_BYTES } from "./execute.js";
import { WriteFileInputSchema, type WriteFileInput } from "./schema.js";
import {
  createInMemoryFileReadTracker,
  type FileReadTracker,
} from "../file-read-tracker.js";

let testDir: string;
let tracker: FileReadTracker;

beforeEach(async () => {
  testDir = resolve(tmpdir(), `write-file-test-${randomBytes(6).toString("hex")}`);
  await realFs.mkdir(testDir, { recursive: true });
  tracker = createInMemoryFileReadTracker();
});

afterEach(async () => {
  await realFs.rm(testDir, { recursive: true, force: true }).catch(() => {});
});

const run = (
  input: WriteFileInput,
  opts?: {
    cwd?: string;
    signal?: AbortSignal;
    fileReadTracker?: FileReadTracker | null;
    pathFilter?: (absPath: string) => boolean;
    fs?: Parameters<typeof executeWriteFile>[1]["fs"];
  },
) =>
  executeWriteFile(input, {
    cwd: opts?.cwd ?? testDir,
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.fileReadTracker === null ? {} : { fileReadTracker: opts?.fileReadTracker ?? tracker }),
    ...(opts?.pathFilter ? { pathFilter: opts.pathFilter } : {}),
    ...(opts?.fs ? { fs: opts.fs } : {}),
  });

// ── UT-1 Schema ─────────────────────────────────────────────────────────────

describe("WriteFileInputSchema", () => {
  it("[UT-1.1] accepts minimal input and fills defaults", () => {
    const parsed = WriteFileInputSchema.parse({ path: "x.ts", content: "hello" });
    expect(parsed.path).toBe("x.ts");
    expect(parsed.content).toBe("hello");
    expect(parsed.mode).toBe("overwrite");
    expect(parsed.createDirs).toBe(true);
  });

  it("[UT-1.2] rejects empty path", () => {
    expect(() => WriteFileInputSchema.parse({ path: "", content: "hi" })).toThrow();
  });

  it("[UT-1.3] accepts empty content (writing an empty file)", () => {
    const parsed = WriteFileInputSchema.parse({ path: "x.ts", content: "" });
    expect(parsed.content).toBe("");
  });

  it("[UT-1.4] rejects invalid mode", () => {
    expect(() =>
      WriteFileInputSchema.parse({ path: "x.ts", content: "hi", mode: "invalid" }),
    ).toThrow();
  });
});

// ── UT-2 Happy path ─────────────────────────────────────────────────────────

describe("executeWriteFile — happy path", () => {
  it("[UT-2.1] creates a new file with created: true and previousBytes: null", async () => {
    const out = await run({ path: "new.txt", content: "hello world", mode: "overwrite", createDirs: true });
    expect(out.created).toBe(true);
    expect(out.previousBytes).toBeNull();
    expect(out.bytesWritten).toBe(Buffer.byteLength("hello world", "utf8"));
    expect(out.path).toBe(resolve(testDir, "new.txt"));
    const written = await realFs.readFile(resolve(testDir, "new.txt"), "utf8");
    expect(written).toBe("hello world");
  });

  it("[UT-2.2] overwrites an existing file with matching tracker record", async () => {
    const filePath = resolve(testDir, "existing.txt");
    await realFs.writeFile(filePath, "old content", "utf8");
    const stat = await realFs.stat(filePath);
    tracker.record(filePath, { mtimeMs: stat.mtimeMs, size: Number(stat.size) });

    const out = await run({ path: "existing.txt", content: "new content", mode: "overwrite", createDirs: true });
    expect(out.created).toBe(false);
    expect(out.previousBytes).toBe(Buffer.byteLength("old content", "utf8"));
    const written = await realFs.readFile(filePath, "utf8");
    expect(written).toBe("new content");
  });

  it("[UT-2.3] consecutive writes to the same file succeed (tracker auto-refreshed)", async () => {
    const out1 = await run({ path: "double.txt", content: "first", mode: "overwrite", createDirs: true });
    expect(out1.created).toBe(true);

    const out2 = await run({ path: "double.txt", content: "second", mode: "overwrite", createDirs: true });
    expect(out2.created).toBe(false);
    expect(out2.previousBytes).toBe(Buffer.byteLength("first", "utf8"));
    const written = await realFs.readFile(resolve(testDir, "double.txt"), "utf8");
    expect(written).toBe("second");
  });
});

// ── UT-3 Read-before-write enforcement ──────────────────────────────────────

describe("executeWriteFile — read-before-write enforcement", () => {
  it("[UT-3.1] existing file with no tracker record throws READ_REQUIRED", async () => {
    const filePath = resolve(testDir, "unread.txt");
    await realFs.writeFile(filePath, "content", "utf8");

    let err: unknown;
    try {
      await run({ path: "unread.txt", content: "new", mode: "overwrite", createDirs: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("READ_REQUIRED");
  });

  it("[UT-3.2] existing file with stale mtime throws STALE_READ", async () => {
    const filePath = resolve(testDir, "stale.txt");
    await realFs.writeFile(filePath, "v1", "utf8");
    tracker.record(filePath, { mtimeMs: 0, size: Buffer.byteLength("v1", "utf8") });

    let err: unknown;
    try {
      await run({ path: "stale.txt", content: "v2", mode: "overwrite", createDirs: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("STALE_READ");
  });

  it("[UT-3.3] existing file with stale size (mtime same) throws STALE_READ", async () => {
    const filePath = resolve(testDir, "stale-size.txt");
    await realFs.writeFile(filePath, "v1", "utf8");
    const stat = await realFs.stat(filePath);
    tracker.record(filePath, { mtimeMs: stat.mtimeMs, size: 999 });

    let err: unknown;
    try {
      await run({ path: "stale-size.txt", content: "v2", mode: "overwrite", createDirs: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("STALE_READ");
  });

  it("[UT-3.4] tracker undefined degrades to no check (backward compat)", async () => {
    const filePath = resolve(testDir, "no-tracker.txt");
    await realFs.writeFile(filePath, "old", "utf8");

    const out = await run(
      { path: "no-tracker.txt", content: "new", mode: "overwrite", createDirs: true },
      { fileReadTracker: null },
    );
    expect(out.created).toBe(false);
  });

  it("[UT-3.5] new file (ENOENT) skips read check", async () => {
    const out = await run({ path: "brand-new.txt", content: "hi", mode: "overwrite", createDirs: true });
    expect(out.created).toBe(true);
  });
});

// ── UT-4 mode: "create" ────────────────────────────────────────────────────

describe("executeWriteFile — mode: create", () => {
  it("[UT-4.1] mode=create with non-existing file succeeds", async () => {
    const out = await run({ path: "fresh.txt", content: "new!", mode: "create", createDirs: true });
    expect(out.created).toBe(true);
    const written = await realFs.readFile(resolve(testDir, "fresh.txt"), "utf8");
    expect(written).toBe("new!");
  });

  it("[UT-4.2] mode=create with existing file throws EEXIST", async () => {
    await realFs.writeFile(resolve(testDir, "taken.txt"), "x", "utf8");

    let err: unknown;
    try {
      await run({ path: "taken.txt", content: "y", mode: "create", createDirs: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("EEXIST");
  });
});

// ── UT-5 Atomic write ──────────────────────────────────────────────────────

describe("executeWriteFile — atomic write", () => {
  it("[UT-5.1] writeFile failure cleans tmp and leaves original intact", async () => {
    const filePath = resolve(testDir, "safe.txt");
    await realFs.writeFile(filePath, "original", "utf8");
    const stat = await realFs.stat(filePath);
    tracker.record(filePath, { mtimeMs: stat.mtimeMs, size: Number(stat.size) });

    const fakeFs = {
      stat: realFs.stat.bind(realFs),
      mkdir: realFs.mkdir.bind(realFs),
      rename: realFs.rename.bind(realFs),
      unlink: realFs.unlink.bind(realFs),
      writeFile: async () => {
        throw new Error("disk full");
      },
    };

    let err: unknown;
    try {
      await run(
        { path: "safe.txt", content: "boom", mode: "overwrite", createDirs: true },
        { fs: fakeFs as Parameters<typeof executeWriteFile>[1]["fs"] },
      );
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);

    const preserved = await realFs.readFile(filePath, "utf8");
    expect(preserved).toBe("original");
  });

  it("[UT-5.2] abort signal rejects and cleans up", async () => {
    const ac = new AbortController();
    ac.abort();

    let err: unknown;
    try {
      await run(
        { path: "abort.txt", content: "x", mode: "overwrite", createDirs: true },
        { signal: ac.signal },
      );
    } catch (e) { err = e; }
    expect((err as Error)?.name).toBe("AbortError");
  });
});

// ── UT-6 Dirs & limits ─────────────────────────────────────────────────────

describe("executeWriteFile — dirs & limits", () => {
  it("[UT-6.1] createDirs: true auto-creates parent directories", async () => {
    const out = await run({
      path: "deep/nested/dir/file.txt",
      content: "hi",
      mode: "overwrite",
      createDirs: true,
    });
    expect(out.created).toBe(true);
    const written = await realFs.readFile(resolve(testDir, "deep/nested/dir/file.txt"), "utf8");
    expect(written).toBe("hi");
  });

  it("[UT-6.2] createDirs: false with missing parent throws ENOENT", async () => {
    let err: unknown;
    try {
      await run({
        path: "missing-parent/file.txt",
        content: "hi",
        mode: "overwrite",
        createDirs: false,
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("ENOENT");
  });

  it("[UT-6.3] content exceeding 1 MB throws TOO_LARGE without writing", async () => {
    const bigContent = "x".repeat(MAX_CONTENT_BYTES + 1);
    let err: unknown;
    try {
      await run({ path: "big.txt", content: bigContent, mode: "overwrite", createDirs: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("TOO_LARGE");

    const exists = await realFs.access(resolve(testDir, "big.txt")).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("[UT-6.4] target path is a directory throws EISDIR", async () => {
    await realFs.mkdir(resolve(testDir, "adir"), { recursive: true });

    let err: unknown;
    try {
      await run({ path: "adir", content: "x", mode: "overwrite", createDirs: true });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("EISDIR");
  });
});

// ── UT-7 pathFilter ────────────────────────────────────────────────────────

describe("executeWriteFile — pathFilter", () => {
  it("[UT-7.1] pathFilter returning false throws REJECTED", async () => {
    let err: unknown;
    try {
      await run(
        { path: "blocked.txt", content: "x", mode: "overwrite", createDirs: true },
        { pathFilter: () => false },
      );
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WriteFileError);
    expect((err as WriteFileError).cause.code).toBe("REJECTED");
  });

  it("[UT-7.2] pathFilter returning true allows write", async () => {
    const out = await run(
      { path: "allowed.txt", content: "ok", mode: "overwrite", createDirs: true },
      { pathFilter: () => true },
    );
    expect(out.created).toBe(true);
  });
});

// ── UT-8 FileReadTracker ───────────────────────────────────────────────────

describe("FileReadTracker", () => {
  it("[UT-8.1] record + get returns the recorded snapshot", () => {
    const t = createInMemoryFileReadTracker();
    t.record("/a/b", { mtimeMs: 100, size: 50 });
    expect(t.get("/a/b")).toEqual({ mtimeMs: 100, size: 50 });
  });

  it("[UT-8.2] get on unrecorded path returns undefined", () => {
    const t = createInMemoryFileReadTracker();
    expect(t.get("/nope")).toBeUndefined();
  });

  it("[UT-8.3] forget clears the record", () => {
    const t = createInMemoryFileReadTracker();
    t.record("/a", { mtimeMs: 1, size: 1 });
    t.forget("/a");
    expect(t.get("/a")).toBeUndefined();
  });

  it("[UT-8.4] different paths are independent", () => {
    const t = createInMemoryFileReadTracker();
    t.record("/a", { mtimeMs: 1, size: 10 });
    t.record("/b", { mtimeMs: 2, size: 20 });
    expect(t.get("/a")).toEqual({ mtimeMs: 1, size: 10 });
    expect(t.get("/b")).toEqual({ mtimeMs: 2, size: 20 });
  });
});

// ── UT-9 read_file integration ─────────────────────────────────────────────

describe("read_file tracker integration", () => {
  it("[UT-9.1] read_file records a snapshot in the shared tracker", async () => {
    const { executeReadFile } = await import("../read-file/execute.js");
    const spy = createInMemoryFileReadTracker();
    const calls: Array<{ path: string; snapshot: { mtimeMs: number; size: number } }> = [];
    const recording: FileReadTracker = {
      record: (p, s) => { calls.push({ path: p, snapshot: s }); spy.record(p, s); },
      get: (p) => spy.get(p),
      forget: (p) => spy.forget(p),
    };

    const filePath = resolve(testDir, "track-test.txt");
    await realFs.writeFile(filePath, "hello", "utf8");

    await executeReadFile(
      { path: filePath },
      { cwd: testDir, fileReadTracker: recording },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(filePath);
    expect(calls[0].snapshot.mtimeMs).toBeGreaterThan(0);
    expect(calls[0].snapshot.size).toBe(Buffer.byteLength("hello", "utf8"));
  });
});
