import type { LogTransport } from "../types.js";

/**
 * Writes log lines to `process.stderr`. We deliberately avoid `stdout` because
 * the TUI renders Ink frames there; stderr is the conventional sink for
 * out-of-band diagnostics. Useful in headless server mode and unit tests.
 *
 * Note: this transport never owns the underlying TTY/pipe — `close()` is a
 * no-op so we don't accidentally tear down the parent process's stderr.
 */
export function consoleTransport(): LogTransport {
  return {
    write(line: string) {
      process.stderr.write(line);
    },
    close() {
      /* no-op: stderr is process-owned */
    },
  };
}
