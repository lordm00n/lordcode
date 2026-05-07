import { Hono } from "hono";
import type { HealthResponse } from "@lordcode/shared";
import type { AppDeps } from "../app.js";

export function healthRoute(deps: AppDeps) {
  const route = new Hono();

  route.get("/", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: deps.version,
      uptimeMs: Date.now() - deps.startedAt,
    };
    return c.json(body);
  });

  return route;
}
