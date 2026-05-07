import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import type {
  MainToWorkerMessage,
  ServerWorkerMessage,
  ServerWorkerOptions,
} from "@lordcode/shared";

export interface ServerHostHandle {
  baseUrl: string;
  port: number;
  shutdown: () => Promise<void>;
}

/**
 * Resolve the worker entry from `@lordcode/server`'s `./worker` export.
 * The worker always runs against the built `dist/worker.js` — `tsx` does not
 * propagate its loader into `worker_threads`, so we keep the worker pure JS
 * and rely on `tsc -b` (run by `pnpm dev`) to keep `dist/` warm.
 */
function resolveWorkerEntry(): URL {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@lordcode/server/package.json");
  const pkg = require(pkgPath) as {
    exports?: Record<string, { import?: string }>;
  };
  const workerExport = pkg.exports?.["./worker"]?.import;
  if (!workerExport) {
    throw new Error("@lordcode/server does not export ./worker");
  }
  return new URL(workerExport, new URL(pkgPath, import.meta.url));
}

export function startServerWorker(
  opts: Partial<ServerWorkerOptions> = {},
): Promise<ServerHostHandle & { worker: Worker }> {
  const workerOptions: ServerWorkerOptions = {
    port: opts.port ?? 0,
    host: opts.host ?? "127.0.0.1",
    logLevel: opts.logLevel ?? "silent",
  };

  const entry = resolveWorkerEntry();
  const worker = new Worker(entry, { workerData: workerOptions });

  return new Promise((resolve, reject) => {
    const onMessage = (msg: ServerWorkerMessage) => {
      if (msg.type === "ready") {
        worker.off("message", onMessage);
        resolve({
          worker,
          baseUrl: msg.baseUrl,
          port: msg.port,
          shutdown: () => shutdownWorker(worker),
        });
      } else if (msg.type === "error") {
        worker.off("message", onMessage);
        reject(new Error(msg.message));
      }
    };
    worker.on("message", onMessage);
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`server worker exited with code ${code}`));
    });
  });
}

function shutdownWorker(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    worker.once("exit", done);
    const msg: MainToWorkerMessage = { type: "shutdown" };
    worker.postMessage(msg);
    setTimeout(() => worker.terminate().finally(done), 2000).unref();
  });
}
