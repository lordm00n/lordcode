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

  // 1. Size cap check
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new WriteFileError(
      `content too large: ${bytes} bytes exceeds ${MAX_CONTENT_BYTES}-byte cap`,
      { code: "TOO_LARGE", byteSize: bytes },
    );
  }

  // 2. Resolve path
  const resolvedPath = resolve(deps.cwd, input.path);

  // 3. Path filter
  if (deps.pathFilter && !deps.pathFilter(resolvedPath)) {
    throw new WriteFileError(
      `path rejected by filter: ${resolvedPath}`,
      { code: "REJECTED" },
    );
  }

  // 4. Stat existing file
  let existing: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    existing = await fs.stat(resolvedPath);
  } catch (err) {
    if (readNodeErrorCode(err) !== "ENOENT") throw mapStatError(err, resolvedPath);
  }

  // 5. Mode check
  if (existing && existing.isDirectory()) {
    throw new WriteFileError(
      `path is a directory: ${resolvedPath}`,
      { code: "EISDIR" },
    );
  }
  if (existing && input.mode === "create") {
    throw new WriteFileError(
      `file already exists: ${resolvedPath}`,
      { code: "EEXIST" },
    );
  }

  // 6. Read-before-write check (only for existing files)
  if (existing && deps.fileReadTracker) {
    const recorded = deps.fileReadTracker.get(resolvedPath);

    if (!recorded) {
      throw new WriteFileError(
        "file exists but has not been read in this session — call read_file first",
        { code: "READ_REQUIRED" },
      );
    }

    if (recorded.mtimeMs !== existing.mtimeMs || recorded.size !== Number(existing.size)) {
      throw new WriteFileError(
        "file modified since last read — re-read before writing",
        { code: "STALE_READ" },
      );
    }
  }

  // 7. Create parent dirs
  if (input.createDirs !== false) {
    await fs.mkdir(dirname(resolvedPath), { recursive: true });
  }

  // 8. Atomic write: tmp + rename
  const tmpPath = `${resolvedPath}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, input.content, {
      encoding: "utf8",
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    await fs.rename(tmpPath, resolvedPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    if (isAbortError(err)) throw err;
    throw mapWriteError(err, resolvedPath);
  }

  // 9. Update tracker with new snapshot
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
