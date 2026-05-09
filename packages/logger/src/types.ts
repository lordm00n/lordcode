/**
 * Severity dial. Only `silent` fully mutes the logger; `info` still emits
 * `warn` / `error`. See spec §7.1.
 */
export type LogLevel = "silent" | "info" | "debug";

/**
 * A single output sink. Implementations own their backing resource (file
 * handle, stream, etc.) and are responsible for appending newlines if needed.
 */
export interface LogTransport {
  /** Write one already-formatted log line. */
  write(line: string): void;
  /** Release resources. May be sync or async; must be idempotent. */
  close(): Promise<void> | void;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  /**
   * `err` may be an `Error`, a string, or anything stringifiable. When it is
   * an `Error`, `err.message` is appended inline as `err="..."` and the stack
   * is emitted as indented continuation lines.
   */
  error(message: string, err?: unknown, meta?: Record<string, unknown>): void;

  /**
   * Append `name` to the channel path. Children share the parent's transports
   * and level; it is a cheap reference, not a copy.
   */
  child(name: string): Logger;

  /**
   * Fan-out: derived logger writes to `[...parent.transports, transport]`.
   * Calling `close()` on the derived logger only releases `transport`; the
   * parent's transports are untouched (transport-handle ownership rule, §4).
   */
  tee(transport: LogTransport): Logger;

  /**
   * Close transports introduced at *this* node:
   * - root logger (from `createLogger`): closes every transport it was built with.
   * - child logger: no-op.
   * - tee'd logger: closes the one transport `tee` added.
   *
   * Idempotent. Safe to call from shutdown paths.
   */
  close(): Promise<void>;
}
