/**
 * Messages exchanged between the TUI (main thread) and the server worker.
 * The HTTP server itself is reachable on `baseUrl`; these messages are only
 * used for lifecycle / handshake.
 */

export type LogLevel = "silent" | "info" | "debug";

export interface ServerWorkerOptions {
  /** Port to bind, or 0 to let the OS assign one. */
  port: number;
  host: string;
  /**
   * @deprecated Superseded by `level`; kept to avoid breaking older callers
   * during the transition. Will be removed once all consumers pass `level`.
   */
  logLevel?: LogLevel;
  /**
   * Absolute path the worker will append its log file to. The main thread
   * writes the run header before spawning the worker; the worker just
   * `createWriteStream(path, { flags: "a" })`s the same file (POSIX
   * `O_APPEND` keeps short writes from interleaving — see logging spec §4).
   */
  debugLogPath: string;
  /** Severity dial inside the worker. Mirrors the TUI's level. */
  level: LogLevel;
  /**
   * Build identity, used only for diagnostic output inside the worker
   * (e.g. annotating crash logs). The worker MUST NOT re-emit the run header
   * — that is the main thread's job.
   */
  mode: "dev" | "release";
}

export type ServerWorkerMessage =
  | { type: "ready"; baseUrl: string; port: number }
  | { type: "error"; message: string }
  | { type: "shutdown" };

export type MainToWorkerMessage = { type: "shutdown" };
