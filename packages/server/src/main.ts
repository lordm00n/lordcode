import { startServer } from "./server.js";
import type { LogLevel } from "./lib/logger.js";

const port = Number(process.env.LORDCODE_PORT ?? 0);
const host = process.env.LORDCODE_HOST ?? "127.0.0.1";
const logLevel =
  (process.env.LORDCODE_LOG_LEVEL as LogLevel | undefined) ?? "info";

const running = await startServer({ port, host, logLevel });

const shutdown = async (signal: NodeJS.Signals) => {
  console.info(`received ${signal}, shutting down`);
  await running.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
