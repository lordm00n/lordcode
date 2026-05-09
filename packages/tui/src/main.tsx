import React from "react";
import { render } from "ink";
import { createLogger, formatRunHeader } from "@lordcode/logger";
import { fileTransport } from "@lordcode/logger/node";
import {
  ensureLogsDir,
  getDebugLogPath,
  rotateIfHuge,
  VERSION,
} from "@lordcode/server";
import { startServerWorker } from "./server-host.js";
import { createApiClient } from "./api/client.js";
import { App } from "./components/App.js";
import { LoggerProvider } from "./lib/logger-context.js";

async function main() {
  // §3 / §11: a single env var (`LORDCODE_DEBUG`) toggles both verbosity and
  // the run-header `mode` tag. There is deliberately no `silent` env path
  // (§12.4) — to mute logs you have to delete the file or change source.
  const debug = process.env.LORDCODE_DEBUG === "1";
  const level = debug ? "debug" : "info";
  const mode: "dev" | "release" = debug ? "dev" : "release";

  await ensureLogsDir();
  const debugLogPath = getDebugLogPath();
  // Boot-time 50MB cap: rename `debug.log` → `debug.log.old` (overwrites any
  // previous `.old`) so the new run starts fresh. Spec §12.3.
  await rotateIfHuge(debugLogPath);

  const transport = fileTransport(debugLogPath);
  const root = createLogger({ level, transports: [transport] });

  // Spec §6.1 / §10.1: the main thread writes the run header exactly once
  // per process start, BEFORE spawning the worker. The worker reuses
  // `debugLogPath` via O_APPEND but never re-emits a header.
  transport.write(
    formatRunHeader({ mode, pid: process.pid, version: VERSION }) + "\n",
  );

  const tuiLog = root.child("tui");
  const bootLog = tuiLog.child("boot");

  process.on("uncaughtException", (err) => {
    bootLog.error("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    bootLog.error("unhandledRejection", err);
  });

  bootLog.info("starting worker", {
    debugLogPath,
    level,
    mode,
  });

  let handle: Awaited<ReturnType<typeof startServerWorker>>;
  try {
    handle = await startServerWorker({
      port: Number(process.env.LORDCODE_PORT ?? 0),
      host: process.env.LORDCODE_HOST ?? "127.0.0.1",
      debugLogPath,
      level,
      mode,
    });
  } catch (err) {
    bootLog.error("worker startup failed", err);
    await root.close().catch(() => {});
    throw err;
  }

  bootLog.info("worker ready", { baseUrl: handle.baseUrl });

  const api = createApiClient(handle.baseUrl, tuiLog);

  const ink = render(
    <LoggerProvider logger={tuiLog}>
      <App
        api={api}
        baseUrl={handle.baseUrl}
        onExit={() => {
          void handle.shutdown();
        }}
      />
    </LoggerProvider>,
    { exitOnCtrlC: false },
  );

  let cleaningUp = false;
  const cleanup = async (signal?: NodeJS.Signals) => {
    if (cleaningUp) return;
    cleaningUp = true;
    if (signal) bootLog.info("shutting down", { signal });
    ink.unmount();
    try {
      await handle.shutdown();
    } catch (err) {
      bootLog.error("worker shutdown failed", err);
    }
    await root.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void cleanup("SIGINT"));
  process.on("SIGTERM", () => void cleanup("SIGTERM"));

  await ink.waitUntilExit();
  await cleanup();
}

main().catch(async (err) => {
  // We may not yet have a logger (env / mkdir failure), so fall back to
  // stderr. After the TUI is up `cleanup` has already run.
  try {
    process.stderr.write(
      `[lordcode] startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
  } catch {
    // give up
  }
  process.exit(1);
});
