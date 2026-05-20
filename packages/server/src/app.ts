import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { cors } from "hono/cors";
import type { Logger } from "@lordcode/logger";
import { healthRoute } from "./routes/health.js";
import { agentRoute } from "./routes/agent.js";
import { modelsRoute } from "./routes/models.js";
import { sessionsRoute } from "./routes/sessions.js";
import type { ConfigStore } from "./config/store.js";
import type { SessionRuntime } from "./session/runtime.js";

export interface AppDeps {
  /**
   * Server-rooted logger. App-internal channels are derived as
   *   `deps.logger.child("http")`         -- hono/logger middleware
   *   `deps.logger.child("route").child("agent")`
   *   `deps.logger.child("agent").child("stream")`
   *   …
   * Callers are expected to hand in something already named with
   * `.child("server")` so the channel paths come out as `server:...`.
   */
  logger: Logger;
  startedAt: number;
  version: string;
  configStore: ConfigStore;
  sessionRuntime: SessionRuntime;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const httpLog = deps.logger.child("http");

  app.use(
    "*",
    honoLogger((message, ...rest) => {
      // hono/logger emits a single human-readable string; we attach the
      // remainder as a single `extra` meta field so structured grep still
      // works on the channel.
      if (rest.length > 0) {
        httpLog.debug(message, { extra: rest });
      } else {
        httpLog.debug(message);
      }
    }),
  );
  app.use("*", cors());

  app.route("/health", healthRoute(deps));
  app.route("/agent", agentRoute(deps));
  app.route("/models", modelsRoute(deps));
  app.route("/sessions", sessionsRoute(deps));

  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  app.onError((err, c) => {
    deps.logger.error("unhandled error", err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
