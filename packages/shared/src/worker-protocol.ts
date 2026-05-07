/**
 * Messages exchanged between the TUI (main thread) and the server worker.
 * The HTTP server itself is reachable on `baseUrl`; these messages are only
 * used for lifecycle / handshake.
 */

export interface ServerWorkerOptions {
  /** Port to bind, or 0 to let the OS assign one. */
  port: number;
  host: string;
  logLevel: "silent" | "info" | "debug";
}

export type ServerWorkerMessage =
  | { type: "ready"; baseUrl: string; port: number }
  | { type: "error"; message: string }
  | { type: "shutdown" };

export type MainToWorkerMessage = { type: "shutdown" };
