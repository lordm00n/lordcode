import { randomBytes } from "node:crypto";
import { promises as defaultFs } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Logger } from "@lordcode/logger";
import type { FileReadTracker } from "../file-read-tracker.js";
import type { WriteFileInput, WriteFileOutput } from "./schema.js";

/** Max content size in bytes. Rejects before writing to disk. */
export const MAX_CONTENT_BYTES = 1 * 1024 * 1024; // 1 MB

export type WriteFileErrorCode =
  | "EEXIST"
  | "EISDIR"
  | "EACCES"
  | "ENOENT"
  | "TOO_LARGE"
  | "REJECTED"
  | "READ_REQUIRED"
  | "STALE_READ"
  | "WRITE_FAILED";

export class WriteFileError extends Error {
  public override readonly cause: {
    code: WriteFileErrorCode;
    byteSize?: number;
    underlying?: unknown;
  };

  constructor(
    message: string,
    cause: { code: WriteFileErrorCode; byteSize?: number; underlying?: unknown },
  ) {
    super(message);
    this.name = "WriteFileError";
    this.cause = cause;
  }
}

export interface WriteFileDeps {
  /** Working directory used to resolve relative `input.path`. */
  cwd: string;
  /** Channel-rooted logger. Convention: `…child("tool").child("write_file")`. */
  logger?: Logger;
  /** Cancels the write; on abort the tmp file is cleaned up. */
  signal?: AbortSignal;
  /** Test seam: inject a fake `fs/promises`. */
  fs?: Pick<typeof defaultFs, "stat" | "writeFile" | "rename" | "mkdir" | "unlink">;
  /** Shared tracker for read-before-write enforcement. */
  fileReadTracker?: FileReadTracker;
  /** Optional filter — return false to reject a path. */
  pathFilter?: (absPath: string) => boolean;
}

export async function executeWriteFile(
  input: WriteFileInput,
  deps: WriteFileDeps,
): Promise<WriteFileOutput> {
  const log = deps.logger;
  const fs = deps.fs ?? defaultFs;
  const startedAt = Date.now();

  const bytes = Buffer.byteLength(input.content, "utf8");
  const resolvedPath = resolve(deps.cwd, input.path);

  // Single-line entry trace. Pairs with `write_file done` (success) or
  // `write_file failed` / `write_file aborted` so a single grep on
  // `server:tool:write_file` reconstructs the full lifecycle of the call.
  log?.debug("write_file start", {
    path: resolvedPath,
    mode: input.mode,
    createDirs: input.createDirs,
    bytes,
  });

  /**
   * Centralised throw site so every `WriteFileError` is preceded by one
   * `write_file failed` warn line carrying the error `code` (which the
   * upstream `chunk: tool-error` log loses — it only sees `message`).
   */
  const fail = (
    code: WriteFileErrorCode,
    message: string,
    extra?: { byteSize?: number; underlying?: unknown },
  ): never => {
    log?.warn("write_file failed", {
      code,
      path: resolvedPath,
      ...(extra?.byteSize !== undefined ? { byteSize: extra.byteSize } : {}),
    });
    throw new WriteFileError(message, {
      code,
      ...(extra?.byteSize !== undefined ? { byteSize: extra.byteSize } : {}),
      ...(extra?.underlying !== undefined ? { underlying: extra.underlying } : {}),
    });
  };

  // 1. Size cap check
  if (bytes > MAX_CONTENT_BYTES) {
    fail(
      "TOO_LARGE",
      `content too large: ${bytes} bytes exceeds ${MAX_CONTENT_BYTES}-byte cap`,
      { byteSize: bytes },
    );
  }

  // 2. Path filter
  if (deps.pathFilter && !deps.pathFilter(resolvedPath)) {
    fail("REJECTED", `path rejected by filter: ${resolvedPath}`);
  }

  // 3. Stat existing file
  let existing: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    existing = await fs.stat(resolvedPath);
  } catch (err) {
    if (readNodeErrorCode(err) !== "ENOENT") {
      const mapped = mapStatError(err, resolvedPath);
      log?.warn("write_file failed", { code: mapped.cause.code, path: resolvedPath });
      throw mapped;
    }
  }

  // 4. Mode check
  if (existing && existing.isDirectory()) {
    fail("EISDIR", `path is a directory: ${resolvedPath}`);
  }
  if (existing && input.mode === "create") {
    fail("EEXIST", `file already exists: ${resolvedPath}`);
  }

  // 5. Read-before-write check (only for existing files)
  if (existing && deps.fileReadTracker) {
    const recorded = deps.fileReadTracker.get(resolvedPath);

    if (!recorded) {
      fail(
        "READ_REQUIRED",
        "file exists but has not been read in this session — call read_file first",
      );
    } else if (
      recorded.mtimeMs !== existing.mtimeMs ||
      recorded.size !== Number(existing.size)
    ) {
      fail("STALE_READ", "file modified since last read — re-read before writing");
    }
  }

  // 6. Create parent dirs
  if (input.createDirs !== false) {
    await fs.mkdir(dirname(resolvedPath), { recursive: true });
  }

  // 7. Atomic write: tmp + rename
  const tmpPath = `${resolvedPath}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, input.content, {
      encoding: "utf8",
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    await fs.rename(tmpPath, resolvedPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    if (isAbortError(err)) {
      log?.debug("write_file aborted", {
        path: resolvedPath,
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
    const mapped = mapWriteError(err, resolvedPath);
    log?.warn("write_file failed", { code: mapped.cause.code, path: resolvedPath });
    throw mapped;
  }

  // 8. Update tracker with new snapshot
  const after = await fs.stat(resolvedPath);
  deps.fileReadTracker?.record(resolvedPath, {
    mtimeMs: after.mtimeMs,
    size: Number(after.size),
  });

  const result: WriteFileOutput = {
    path: resolvedPath,
    bytesWritten: bytes,
    created: existing === null,
    previousBytes: existing ? Number(existing.size) : null,
  };

  log?.debug("write_file done", {
    path: resolvedPath,
    bytesWritten: bytes,
    created: result.created,
    previousBytes: result.previousBytes,
    elapsedMs: Date.now() - startedAt,
  });

  return result;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function readNodeErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = (err as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : undefined;
}

function mapStatError(err: unknown, path: string): WriteFileError {
  const code = readNodeErrorCode(err);
  if (code === "EACCES" || code === "EPERM") {
    return new WriteFileError(`permission denied: ${path}`, {
      code: "EACCES",
      underlying: err,
    });
  }
  return new WriteFileError(
    `failed to stat ${path}: ${errorMessage(err)}`,
    { code: "WRITE_FAILED", underlying: err },
  );
}

function mapWriteError(err: unknown, path: string): WriteFileError {
  const code = readNodeErrorCode(err);
  if (code === "EACCES" || code === "EPERM") {
    return new WriteFileError(`permission denied: ${path}`, {
      code: "EACCES",
      underlying: err,
    });
  }
  if (code === "ENOENT") {
    return new WriteFileError(`parent directory does not exist: ${path}`, {
      code: "ENOENT",
      underlying: err,
    });
  }
  return new WriteFileError(
    `failed to write ${path}: ${errorMessage(err)}`,
    { code: "WRITE_FAILED", underlying: err },
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
