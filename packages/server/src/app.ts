import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { agentRoute } from "./routes/agent.js";
import { modelsRoute } from "./routes/models.js";
import type { Logger } from "./lib/logger.js";
import type { ConfigStore } from "./config/store.js";

export interface AppDeps {
  logger: Logger;
  startedAt: number;
  version: string;
  configStore: ConfigStore;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use(
    "*",
    logger((message, ...rest) => deps.logger.debug(message, ...rest)),
  );
  app.use("*", cors());

  app.route("/health", healthRoute(deps));
  app.route("/agent", agentRoute(deps));
  app.route("/models", modelsRoute(deps));

  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  app.onError((err, c) => {
    deps.logger.error("Unhandled error", err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
