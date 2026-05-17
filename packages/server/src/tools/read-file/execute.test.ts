import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectImageMediaType,
  executeReadFile,
  formatNumberedLines,
  ReadFileError,
} from "./execute.js";
import { ReadFileInputSchema, type ReadFileInput } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../../../tests/fixtures/read-file-corpus");

const baseInput = (over: Partial<ReadFileInput> = {}): ReadFileInput => ({
  path: "small.txt",
  ...over,
});

const run = (
  input: ReadFileInput,
  opts?: { signal?: AbortSignal; cwd?: string; fs?: Parameters<typeof executeReadFile>[1]["fs"] },
) =>
  executeReadFile(input, {
    cwd: opts?.cwd ?? FIXTURE_DIR,
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.fs ? { fs: opts.fs } : {}),
  });

// ── UT-1 schema ─────────────────────────────────────────────────────────────

describe("ReadFileInputSchema", () => {
  it("[UT-1.1] accepts the minimum input and leaves offset/limit undefined", () => {
    expect(ReadFileInputSchema.parse({ path: "x.ts" })).toEqual({
      path: "x.ts",
    });
  });

  it("[UT-1.2] rejects empty path", () => {
    expect(() => ReadFileInputSchema.parse({ path: "" })).toThrow();
  });

  it("[UT-1.3] rejects non-positive offset", () => {
    expect(() => ReadFileInputSchema.parse({ path: "x", offset: 0 })).toThrow();
    expect(() => ReadFileInputSchema.parse({ path: "x", offset: -1 })).toThrow();
  });

  it("[UT-1.4] rejects limit > 10000", () => {
    expect(() =>
      ReadFileInputSchema.parse({ path: "x", limit: 10001 }),
    ).toThrow();
  });

  it("[UT-1.5] rejects non-integer offset/limit", () => {
    expect(() => ReadFileInputSchema.parse({ path: "x", offset: 1.5 })).toThrow();
    expect(() => ReadFileInputSchema.parse({ path: "x", limit: 2.5 })).toThrow();
  });
});

// ── UT-2 text path ──────────────────────────────────────────────────────────

describe("executeReadFile — text path", () => {
  it("[UT-2.1] reads a small file with line numbers and full metadata", async () => {
    const out = await run(baseInput());
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.startLine).toBe(1);
    expect(out.endLine).toBe(3);
    expect(out.totalLines).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.lineTruncated).toBe(false);
    expect(out.path).toBe(resolve(FIXTURE_DIR, "small.txt"));
    expect(out.content).toBe("     1|alpha\n     2|beta\n     3|gamma\n");
  });

  it("[UT-2.2] honours offset + limit and reports truncated when more lines exist", async () => {
    const out = await run({ path: "multiline.ts", offset: 10, limit: 5 });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.startLine).toBe(10);
    expect(out.endLine).toBe(14);
    expect(out.totalLines).toBe(30);
    expect(out.truncated).toBe(true);
    expect(out.lineTruncated).toBe(false);
    const lines = out.content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    expect(lines[0].startsWith("    10|")).toBe(true);
    expect(lines[4].startsWith("    14|")).toBe(true);
  });

  it("[UT-2.3] offset past EOF returns an empty window without throwing", async () => {
    const out = await run({ path: "small.txt", offset: 100 });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.startLine).toBe(100);
    expect(out.endLine).toBe(99);
    expect(out.content).toBe("");
    expect(out.truncated).toBe(false);
    expect(out.totalLines).toBe(3);
  });

  it("[UT-2.4] empty file: totalLines = 0, endLine = 0, content empty", async () => {
    const out = await run({ path: "empty.txt" });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.totalLines).toBe(0);
    expect(out.startLine).toBe(1);
    expect(out.endLine).toBe(0);
    expect(out.content).toBe("");
    expect(out.truncated).toBe(false);
  });

  it("[UT-2.5] long-line: clipped to MAX_LINE_CHARS, lineTruncated = true, ends with `…`", async () => {
    const out = await run({ path: "long-line.txt" });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.lineTruncated).toBe(true);
    expect(out.totalLines).toBe(3);
    const middle = out.content.split("\n")[1];
    expect(middle).toBeDefined();
    expect(middle!.endsWith("…")).toBe(true);
    const stripped = middle!.replace(/^\s+\d+\|/, "");
    expect(stripped.length).toBe(2000);
  });

  it("[UT-2.6] file with no trailing newline: no extra blank line at the end", async () => {
    const out = await run({ path: "no-trailing-newline.txt" });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.totalLines).toBe(3);
    expect(out.endLine).toBe(3);
    expect(out.content).toBe("     1|first\n     2|second\n     3|third\n");
  });

  it("[UT-2.7] CRLF line endings: counted as one line each", async () => {
    const out = await run({ path: "crlf.txt" });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.totalLines).toBe(3);
    expect(out.content).toBe("     1|one\n     2|two\n     3|three\n");
  });

  it("[UT-2.8] absolute path is honoured directly (cwd is ignored)", async () => {
    const abs = resolve(FIXTURE_DIR, "small.txt");
    const out = await executeReadFile({ path: abs }, { cwd: "/" });
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.path).toBe(abs);
    expect(out.totalLines).toBe(3);
  });
});

// ── UT-3 image path ─────────────────────────────────────────────────────────

describe("executeReadFile — image path", () => {
  it("[UT-3.1] real PNG returns kind=image with mediaType + base64 round-trip", async () => {
    const out = await run({ path: "image.png" });
    if (out.kind !== "image") throw new Error("expected image");
    expect(out.mediaType).toBe("image/png");
    expect(out.byteSize).toBeGreaterThan(0);
    const raw = await fs.readFile(resolve(FIXTURE_DIR, "image.png"));
    expect(out.byteSize).toBe(raw.byteLength);
    expect(Buffer.from(out.base64, "base64").equals(raw)).toBe(true);
  });

  it("[UT-3.2] .png extension but text content falls back to text branch", async () => {
    const out = await run({ path: "fake-image.png" });
    if (out.kind !== "text") throw new Error("expected text fallback");
    expect(out.totalLines).toBe(2);
    expect(out.content).toContain("not really a png");
  });

  it("[UT-3.3] image > MAX_IMAGE_BYTES throws TOO_LARGE without reading", async () => {
    const fakeFs = {
      stat: async (_path: string) =>
        ({
          size: 6 * 1024 * 1024,
          isDirectory: () => false,
        }) as unknown as Awaited<ReturnType<typeof fs.stat>>,
      readFile: async () => {
        throw new Error("readFile must NOT be called when stat already reports oversized image");
      },
    };
    let err: unknown = null;
    try {
      await executeReadFile(
        { path: "huge.png" },
        { cwd: FIXTURE_DIR, fs: fakeFs },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadFileError);
    expect((err as ReadFileError).cause.code).toBe("TOO_LARGE");
    expect((err as ReadFileError).cause.byteSize).toBe(6 * 1024 * 1024);
  });
});

// ── UT-4 error path ─────────────────────────────────────────────────────────

describe("executeReadFile — error path", () => {
  it("[UT-4.1] missing file → ReadFileError ENOENT", async () => {
    let err: unknown = null;
    try {
      await run({ path: "does-not-exist.txt" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadFileError);
    expect((err as ReadFileError).cause.code).toBe("ENOENT");
  });

  it("[UT-4.2] directory path → ReadFileError EISDIR", async () => {
    let err: unknown = null;
    try {
      await run({ path: "." });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadFileError);
    expect((err as ReadFileError).cause.code).toBe("EISDIR");
  });

  it("[UT-4.3] non-image binary file → ReadFileError BINARY", async () => {
    let err: unknown = null;
    try {
      await run({ path: "binary.bin" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadFileError);
    expect((err as ReadFileError).cause.code).toBe("BINARY");
  });

  it("[UT-4.4] text file > MAX_TEXT_BYTES → ReadFileError TOO_LARGE", async () => {
    const fakeFs = {
      stat: async (_path: string) =>
        ({
          size: 11 * 1024 * 1024,
          isDirectory: () => false,
        }) as unknown as Awaited<ReturnType<typeof fs.stat>>,
      readFile: async () => {
        throw new Error("readFile must NOT be called when stat reports oversized text");
      },
    };
    let err: unknown = null;
    try {
      await executeReadFile(
        { path: "huge.txt" },
        { cwd: FIXTURE_DIR, fs: fakeFs },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadFileError);
    expect((err as ReadFileError).cause.code).toBe("TOO_LARGE");
  });

  it("[UT-4.5] readFile EACCES → ReadFileError EACCES", async () => {
    const fakeFs = {
      stat: async (_path: string) =>
        ({
          size: 100,
          isDirectory: () => false,
        }) as unknown as Awaited<ReturnType<typeof fs.stat>>,
      readFile: async (): Promise<Buffer> => {
        const e = new Error("permission denied") as Error & { code: string };
        e.code = "EACCES";
        throw e;
      },
    };
    let err: unknown = null;
    try {
      await executeReadFile(
        { path: "secret.txt" },
        { cwd: FIXTURE_DIR, fs: fakeFs },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReadFileError);
    expect((err as ReadFileError).cause.code).toBe("EACCES");
  });
});

// ── UT-5 abort ──────────────────────────────────────────────────────────────

describe("executeReadFile — abort", () => {
  it("[UT-5.1] aborted-before-call signal rejects with AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    let err: unknown = null;
    try {
      await run(baseInput(), { signal: ac.signal });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.name).toBe("AbortError");
  });

  it("[UT-5.2] abort during readFile rejects with AbortError", async () => {
    const ac = new AbortController();
    const fakeFs = {
      stat: async (_path: string) =>
        ({
          size: 100,
          isDirectory: () => false,
        }) as unknown as Awaited<ReturnType<typeof fs.stat>>,
      readFile: async (
        _path: string,
        opts?: { signal?: AbortSignal },
      ): Promise<Buffer> => {
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted") as Error & { name: string };
            e.name = "AbortError";
            reject(e);
          });
        });
      },
    };
    setTimeout(() => ac.abort(), 5);
    let err: unknown = null;
    try {
      await executeReadFile(
        { path: "small.txt" },
        { cwd: FIXTURE_DIR, fs: fakeFs, signal: ac.signal },
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.name).toBe("AbortError");
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

describe("formatNumberedLines", () => {
  it("[UT-H1] right-aligns line numbers to 6 columns and joins with `|`", () => {
    expect(formatNumberedLines(["a", "b"], 1)).toBe("     1|a\n     2|b\n");
    expect(formatNumberedLines(["x"], 99)).toBe("    99|x\n");
  });

  it("[UT-H2] empty input returns empty string (no trailing newline)", () => {
    expect(formatNumberedLines([], 1)).toBe("");
  });
});

describe("detectImageMediaType", () => {
  it("[UT-H3] PNG signature is recognised", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    expect(detectImageMediaType(png)).toBe("image/png");
  });

  it("[UT-H4] JPEG SOI is recognised", () => {
    expect(detectImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
  });

  it("[UT-H5] GIF87a/GIF89a are recognised", () => {
    expect(detectImageMediaType(Buffer.from("GIF87a............"))).toBe(
      "image/gif",
    );
    expect(detectImageMediaType(Buffer.from("GIF89a............"))).toBe(
      "image/gif",
    );
  });

  it("[UT-H6] WEBP RIFF/.../WEBP is recognised", () => {
    const buf = Buffer.alloc(20);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(12, 4);
    buf.write("WEBP", 8, "ascii");
    expect(detectImageMediaType(buf)).toBe("image/webp");
  });

  it("[UT-H7] returns null for unrecognised bytes", () => {
    expect(detectImageMediaType(Buffer.from("not an image"))).toBeNull();
  });
});
