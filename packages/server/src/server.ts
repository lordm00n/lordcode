import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Logger } from "@lordcode/logger";
import { createApp } from "./app.js";
import { VERSION } from "./version.js";
import { ConfigStore } from "./config/store.js";

export interface StartServerOptions {
  port?: number;
  host?: string;
  /**
   * Required. Caller (worker / server-only `main.ts`) opens the file
   * transport and roots the logger; we just route deeper. Passing a logger
   * already child-named with `.child("server")` is the convention so all
   * channels surface as `server:...`.
   */
  logger: Logger;
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
  opts: StartServerOptions,
): Promise<RunningServer> {
  const port = opts.port ?? 0;
  const host = opts.host ?? "127.0.0.1";
  const logger = opts.logger;
  const bootLog = logger.child("boot");
  const startedAt = Date.now();

  const configStore = await ConfigStore.load({
    ...(opts.home ? { home: opts.home } : {}),
    logger,
  });

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

  bootLog.info("server listening", { url: baseUrl });

  return {
    baseUrl,
    port: boundPort,
    host,
    configStore,
    close: () =>
      new Promise<void>((resolve, reject) => {
        bootLog.debug("server closing");
        server.close((err) => {
          if (err) {
            bootLog.error("server close failed", err);
            reject(err);
          } else {
            bootLog.info("server closed");
            resolve();
          }
        });
      }),
  };
}
