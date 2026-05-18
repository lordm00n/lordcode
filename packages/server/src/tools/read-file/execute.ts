import { promises as defaultFs } from "node:fs";
import { extname, resolve } from "node:path";
import type { Logger } from "@lordcode/logger";
import type { FileReadTracker } from "../file-read-tracker.js";
import type {
  ReadFileImageOutput,
  ReadFileInput,
  ReadFileOutput,
  ReadFileTextOutput,
} from "./schema.js";

/**
 * Dependencies for {@link executeReadFile}. Mirrors the dependency-injection
 * style of `executeRipgrep` / `executeGlob`: cwd / logger / abort signal are
 * threaded in by the caller, and we expose `fs` as a test seam so unit tests
 * can fake oversized files without writing 10 MB to disk.
 */
export interface ReadFileDeps {
  /** Working directory used to resolve relative `input.path`. Typically `process.cwd()`. */
  cwd: string;
  /** Channel-rooted logger. Convention: `…child("tool").child("read_file")`. */
  logger?: Logger;
  /** Cancels the read; rejects with the standard `AbortError`. */
  signal?: AbortSignal;
  /** Test seam: inject a fake `fs/promises`. Defaults to the real one. */
  fs?: Pick<typeof defaultFs, "stat" | "readFile">;
  /** Shared tracker so write_file can enforce read-before-write. */
  fileReadTracker?: FileReadTracker;
}

export type ReadFileErrorCode =
  | "ENOENT"
  | "EISDIR"
  | "EACCES"
  | "TOO_LARGE"
  | "BINARY"
  | "READ_FAILED";

/**
 * Thrown for every "this file can't be served" outcome. The model maps the
 * `code` to a recovery strategy (different path, narrower slice, ripgrep
 * first, etc.); the human-readable `message` is what the TUI shows.
 *
 * Schema-validation failures never reach `execute`: the SDK rejects them
 * before we run.
 */
export class ReadFileError extends Error {
  public override readonly cause: {
    code: ReadFileErrorCode;
    byteSize?: number;
    underlying?: unknown;
  };

  constructor(
    message: string,
    cause: { code: ReadFileErrorCode; byteSize?: number; underlying?: unknown },
  ) {
    super(message);
    this.name = "ReadFileError";
    this.cause = cause;
  }
}

/**
 * Defaults & caps. Centralised so the spec, tests, and the tool description
 * can all point at one place. Spec §3 decisions #2–#4.
 */
export const DEFAULT_LIMIT = 2000;
export const MAX_LINE_CHARS = 2000;
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BINARY_SCAN_BYTES = 8192;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Read a file on the user's behalf and return a structured, LLM-friendly
 * result.
 *
 * Branch decisions (spec §6):
 *   - extension is a known image type AND magic bytes verify  → image branch
 *   - extension is image but magic bytes lie                  → fall back
 *   - first 8 KB contains 0x00                                → BINARY error
 *   - otherwise                                               → text branch
 */
export async function executeReadFile(
  input: ReadFileInput,
  deps: ReadFileDeps,
): Promise<ReadFileOutput> {
  const log = deps.logger;
  const fs = deps.fs ?? defaultFs;
  const startedAt = Date.now();

  const resolvedPath = resolve(deps.cwd, input.path);

  // 1. stat — surface the error code so the model can react quickly.
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (err) {
    throw mapStatError(err, resolvedPath);
  }

  if (stats.isDirectory()) {
    throw new ReadFileError(`path is a directory: ${resolvedPath}`, {
      code: "EISDIR",
    });
  }

  const byteSize = Number(stats.size);
  const ext = extname(resolvedPath).toLowerCase();
  const looksLikeImage = IMAGE_EXTENSIONS.has(ext);

  // 2. size cap — picked per branch so a 6 MB PNG fails fast without reading.
  const sizeCap = looksLikeImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (byteSize > sizeCap) {
    throw new ReadFileError(
      `file too large: ${byteSize} bytes exceeds ${sizeCap}-byte cap`,
      { code: "TOO_LARGE", byteSize },
    );
  }

  // 3. read once into a buffer. We use `signal` here so abort during the
  //    actual I/O surfaces the standard AbortError (Node ≥ 17).
  let buffer: Buffer;
  try {
    const raw = await fs.readFile(resolvedPath, {
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw mapReadError(err, resolvedPath);
  }

  // 4. image branch — only when both extension and magic bytes agree.
  if (looksLikeImage) {
    const detected = detectImageMediaType(buffer);
    if (detected != null) {
      deps.fileReadTracker?.record(resolvedPath, {
        mtimeMs: stats.mtimeMs,
        size: byteSize,
      });
      const out: ReadFileImageOutput = {
        kind: "image",
        path: resolvedPath,
        mediaType: detected,
        byteSize,
        base64: buffer.toString("base64"),
      };
      log?.debug("read_file done", {
        path: resolvedPath,
        kind: "image",
        byteSize,
        mediaType: detected,
        elapsedMs: Date.now() - startedAt,
      });
      return out;
    }
    // Magic bytes lie — fall through to text/binary handling.
  }

  // 5. text branch — first guard against binary content.
  if (containsNullByte(buffer)) {
    throw new ReadFileError(
      `file appears to be binary: ${resolvedPath}`,
      { code: "BINARY", byteSize },
    );
  }

  const text = buffer.toString("utf8");
  const lines = splitLines(text);
  const totalLines = lines.length;

  const startIdx = (input.offset ?? 1) - 1;
  const take = input.limit ?? DEFAULT_LIMIT;
  const slice = lines.slice(startIdx, startIdx + take);

  let lineTruncated = false;
  const clipped = slice.map((line) => {
    if (line.length > MAX_LINE_CHARS) {
      lineTruncated = true;
      return `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
    }
    return line;
  });

  const startLine = startIdx + 1;
  const endLine = clipped.length === 0 ? startLine - 1 : startIdx + clipped.length;
  const truncated = endLine < totalLines;

  deps.fileReadTracker?.record(resolvedPath, {
    mtimeMs: stats.mtimeMs,
    size: byteSize,
  });

  const out: ReadFileTextOutput = {
    kind: "text",
    path: resolvedPath,
    content: formatNumberedLines(clipped, startLine),
    startLine,
    endLine,
    totalLines,
    truncated,
    lineTruncated,
  };

  log?.debug("read_file done", {
    path: resolvedPath,
    kind: "text",
    byteSize,
    totalLines,
    startLine,
    endLine,
    truncated,
    lineTruncated,
    elapsedMs: Date.now() - startedAt,
  });

  return out;
}

/**
 * Right-align line numbers to 6 columns and join with `|`. Width matches the
 * inline-line-numbers convention used elsewhere in the prompt; numbers larger
 * than 999,999 simply expand the column (which is fine — model still parses
 * `<digits>|<line>`).
 *
 * Trailing `\n` so the model can copy a line out without re-adding it.
 */
export function formatNumberedLines(
  lines: string[],
  firstLineNumber: number,
): string {
  if (lines.length === 0) return "";
  return (
    lines
      .map((line, i) => `${String(firstLineNumber + i).padStart(6, " ")}|${line}`)
      .join("\n") + "\n"
  );
}

/**
 * Split on CRLF or LF and drop the trailing empty cell from a trailing
 * newline. Same shape as ripgrep's `stdoutLinesFrom` for consistency. An
 * empty input → empty array (totalLines === 0).
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * `git`/`less`-style binary heuristic: any NUL byte in the first 8 KB means
 * "don't try to decode this as text". Cheap and robust enough for a tool that
 * already rejects everything bigger than 10 MB.
 */
function containsNullByte(buf: Buffer): boolean {
  const upper = Math.min(BINARY_SCAN_BYTES, buf.length);
  for (let i = 0; i < upper; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Identify supported images by their well-known magic bytes. Extension alone
 * is not enough: a `.png` file could have been renamed from anything, and we
 * don't want to feed a vision model a broken payload (spec §6.2).
 */
export function detectImageMediaType(
  buf: Buffer,
): ReadFileImageOutput["mediaType"] | null {
  if (buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12) {
    const riff = buf.subarray(0, 4).toString("ascii");
    const webp = buf.subarray(8, 12).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Map Node's fs error codes onto our own taxonomy. `EACCES` and `ENOENT` are
 * the common cases worth distinguishing; everything else collapses into
 * `READ_FAILED` so the model has a single fallback bucket to handle.
 */
function mapStatError(err: unknown, path: string): ReadFileError {
  const code = readNodeErrorCode(err);
  if (code === "ENOENT") {
    return new ReadFileError(`file not found: ${path}`, {
      code: "ENOENT",
      underlying: err,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ReadFileError(`permission denied: ${path}`, {
      code: "EACCES",
      underlying: err,
    });
  }
  return new ReadFileError(
    `failed to stat ${path}: ${errorMessage(err)}`,
    { code: "READ_FAILED", underlying: err },
  );
}

function mapReadError(err: unknown, path: string): ReadFileError {
  const code = readNodeErrorCode(err);
  if (code === "EACCES" || code === "EPERM") {
    return new ReadFileError(`permission denied: ${path}`, {
      code: "EACCES",
      underlying: err,
    });
  }
  return new ReadFileError(
    `failed to read ${path}: ${errorMessage(err)}`,
    { code: "READ_FAILED", underlying: err },
  );
}

function readNodeErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
