import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { createLogger, type LogLevel } from "./lib/logger.js";
import { VERSION } from "./version.js";

export interface StartServerOptions {
  port?: number;
  host?: string;
  logLevel?: LogLevel;
}

export interface RunningServer {
  baseUrl: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  const port = opts.port ?? 0;
  const host = opts.host ?? "127.0.0.1";
  const logger = createLogger(opts.logLevel ?? "info");
  const startedAt = Date.now();

  const app = createApp({ logger, startedAt, version: VERSION });

  const server = serve({ fetch: app.fetch, port, hostname: host });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const baseUrl = `http://${host}:${boundPort}`;

  logger.info(`server listening on ${baseUrl}`);

  return {
    baseUrl,
    port: boundPort,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
