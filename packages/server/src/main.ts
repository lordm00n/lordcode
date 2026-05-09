import { createLogger } from "@lordcode/logger";
import { fileTransport } from "@lordcode/logger/node";
import { formatRunHeader } from "@lordcode/logger";
import { startServer } from "./server.js";
import {
  ensureLogsDir,
  getDebugLogPath,
  rotateIfHuge,
} from "./config/paths.js";
import { VERSION } from "./version.js";

const port = Number(process.env.LORDCODE_PORT ?? 0);
const host = process.env.LORDCODE_HOST ?? "127.0.0.1";

// Per spec §3 (decisions 3+5): `LORDCODE_DEBUG=1` is the single switch for
// both verbosity and the run-header `mode` tag. We don't read
// `LORDCODE_LOG_LEVEL` anymore — it was the previous knob and is removed.
const debug = process.env.LORDCODE_DEBUG === "1";
const level = debug ? "debug" : "info";
const mode = debug ? "dev" : "release";

await ensureLogsDir();
const debugLogPath = getDebugLogPath();
await rotateIfHuge(debugLogPath);

const transport = fileTransport(debugLogPath);
const root = createLogger({ level, transports: [transport] });

// Main thread writes the run header exactly once per process launch (spec
// §6.1). Worker startups never re-emit it; in server-only mode there's no
// worker, so this is the single source.
transport.write(
  formatRunHeader({ mode, pid: process.pid, version: VERSION }) + "\n",
);

const log = root.child("server");
const bootLog = log.child("boot");

process.on("uncaughtException", (err) => {
  bootLog.error("uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  bootLog.error("unhandledRejection", err);
});

const running = await startServer({ port, host, logger: log });

const shutdown = async (signal: NodeJS.Signals) => {
  bootLog.info("shutting down", { signal });
  try {
    await running.close();
  } catch (err) {
    bootLog.error("running.close failed", err);
  }
  await root.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
