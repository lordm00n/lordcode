/**
 * Node-only entrypoint. The base entry (`@lordcode/logger`) is
 * runtime-agnostic; anything that pulls in `node:fs` lives here so non-Node
 * targets (browser tests, edge runtimes) can still depend on the core
 * `Logger` interface.
 */
export { fileTransport } from "./transports/file.js";
