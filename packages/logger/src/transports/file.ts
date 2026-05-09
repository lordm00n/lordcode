import { createWriteStream, type WriteStream } from "node:fs";
import type { LogTransport } from "../types.js";

/**
 * Append-mode file transport. `O_APPEND` (`flags: "a"`) is what lets two
 * threads / two processes share the same `debug.log` without an explicit
 * lock — a single `write(2)` ≤ `PIPE_BUF` is atomic w.r.t. other appenders
 * (spec §4 "POSIX atomic append").
 *
 * Failure mode: when the underlying `WriteStream` errors (disk full, EBADF,
 * EROFS, …) we degrade to writing the failed line and all subsequent lines to
 * `process.stderr` and remember we're broken. The TUI never sees an exception
 * thrown from `.write()` (spec §12.1).
 *
 * Caller responsibilities:
 * - Parent directory must exist (use `ensureLogsDir` upstream).
 * - Call `close()` exactly once at shutdown to flush + release the FD.
 */
export function fileTransport(path: string): LogTransport {
  let stream: WriteStream | null = createWriteStream(path, { flags: "a" });
  let broken = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const fallback = (line: string, why?: unknown) => {
    if (!broken) {
      broken = true;
      try {
        const reason = why instanceof Error ? why.message : String(why ?? "");
        process.stderr.write(
          `[lordcode logger] file write failed (${path}): ${reason}\n`,
        );
      } catch {
        // give up
      }
    }
    try {
      process.stderr.write(line);
    } catch {
      // give up
    }
  };

  if (stream) {
    stream.on("error", (err) => {
      // Spec §12.1: degrade silently rather than crash the host process.
      fallback("", err);
    });
  }

  return {
    write(line: string) {
      if (closed || broken || !stream) {
        fallback(line);
        return;
      }
      try {
        stream.write(line);
      } catch (err) {
        fallback(line, err);
      }
    },

    close() {
      if (closed) return closePromise ?? Promise.resolve();
      closed = true;

      const s = stream;
      stream = null;
      if (!s) return Promise.resolve();

      // Resolve on `'close'` (FD fully released) rather than `'finish'`
      // (writable side just flushed). Stronger guarantee — any follow-up
      // `readFile()` is guaranteed to see the persisted bytes.
      closePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        s.once("close", done);
        s.once("error", done);
        s.end();
      });
      return closePromise;
    },
  };
}
