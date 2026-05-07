import { parentPort, workerData } from "node:worker_threads";
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
const opts = (workerData as ServerWorkerOptions | undefined) ?? {
  port: 0,
  host: "127.0.0.1",
  logLevel: "info",
};

const send = (msg: ServerWorkerMessage) => port.postMessage(msg);

let running: RunningServer | null = null;

try {
  running = await startServer({
    port: opts.port,
    host: opts.host,
    logLevel: opts.logLevel,
  });
  send({ type: "ready", baseUrl: running.baseUrl, port: running.port });
} catch (err) {
  send({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

port.on("message", async (msg: MainToWorkerMessage) => {
  if (msg?.type === "shutdown") {
    await running?.close();
    send({ type: "shutdown" });
    process.exit(0);
  }
});
