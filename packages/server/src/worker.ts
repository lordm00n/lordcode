import { parentPort, workerData } from "node:worker_threads";
import { createLogger } from "@lordcode/logger";
import { fileTransport } from "@lordcode/logger/node";
import type {
  MainToWorkerMessage,
  ServerWorkerMessage,
  ServerWorkerOptions,
} from "@lordcode/shared";
import { startServer, type RunningServer } from "./server.js";

if (!parentPort) {
  throw new Error("server/worker must be run inside a worker_thread");
}

const port = parentPort;
const opts = workerData as ServerWorkerOptions | undefined;

if (!opts) {
  // We can't use the logger here — workerData is what tells us where to log.
  // Fall back to crashing the worker so the parent's `worker.on("error")`
  // handler surfaces the misconfiguration.
  throw new Error("server worker started without ServerWorkerOptions");
}

// The worker keeps its own file transport (POSIX O_APPEND lets it share
// `debug.log` with the main thread without an explicit lock). The worker
// MUST NOT write a run header — main.tsx already wrote one and a duplicate
// per launch would clutter the file (spec §5).
const transport = fileTransport(opts.debugLogPath);
const root = createLogger({ level: opts.level, transports: [transport] });
const log = root.child("server");
const bootLog = log.child("boot");

const send = (msg: ServerWorkerMessage) => port.postMessage(msg);

let running: RunningServer | null = null;

try {
  bootLog.debug("worker startup", {
    pid: process.pid,
    mode: opts.mode,
    debugLogPath: opts.debugLogPath,
  });
  running = await startServer({
    logger: log,
    port: opts.port,
    host: opts.host,
  });
  send({ type: "ready", baseUrl: running.baseUrl, port: running.port });
} catch (err) {
  bootLog.error("worker startup failed", err);
  send({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  // Best-effort flush: close the transport before exiting so the parent
  // sees the error line on disk even if it never reads our message.
  await root.close().catch(() => {});
  process.exit(1);
}

port.on("message", async (msg: MainToWorkerMessage) => {
  if (msg?.type === "shutdown") {
    bootLog.info("shutdown requested");
    try {
      await running?.close();
    } catch (err) {
      bootLog.error("shutdown failed", err);
    }
    send({ type: "shutdown" });
    await root.close().catch(() => {});
    process.exit(0);
  }
});
