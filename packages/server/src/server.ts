import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { createLogger, type LogLevel } from "./lib/logger.js";
import { VERSION } from "./version.js";
import { ConfigStore } from "./config/store.js";

export interface StartServerOptions {
  port?: number;
  host?: string;
  logLevel?: LogLevel;
  /** Override `~` for the config file lookup. Used by tests. */
  home?: string;
}

export interface RunningServer {
  baseUrl: string;
  port: number;
  host: string;
  configStore: ConfigStore;
  close: () => Promise<void>;
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<RunningServer> {
  const port = opts.port ?? 0;
  const host = opts.host ?? "127.0.0.1";
  const logger = createLogger(opts.logLevel ?? "info");
  const startedAt = Date.now();

  const configStore = await ConfigStore.load(
    opts.home ? { home: opts.home } : {},
  );

  const app = createApp({
    logger,
    startedAt,
    version: VERSION,
    configStore,
  });

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
    configStore,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
