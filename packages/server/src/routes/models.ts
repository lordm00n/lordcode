import { Hono } from "hono";
import type {
  ModelsListResponse,
  SetCurrentModelErrorResponse,
  SetCurrentModelRequest,
  SetCurrentModelResponse,
} from "@lordcode/shared";
import type { AppDeps } from "../app.js";
import { ModelNotFoundError } from "../config/store.js";

export function modelsRoute(deps: AppDeps) {
  const route = new Hono();
  const log = deps.logger.child("route").child("models");

  route.get("/", (c) => {
    const body: ModelsListResponse = deps.configStore.toListResponse();
    log.debug("list models", { count: body.models.length });
    return c.json(body);
  });

  route.post("/current", async (c) => {
    let body: SetCurrentModelRequest;
    try {
      body = (await c.req.json()) as SetCurrentModelRequest;
    } catch {
      log.warn("invalid body: not JSON");
      const err: SetCurrentModelErrorResponse = {
        error: "request body must be JSON",
        available: deps.configStore.availableNames(),
      };
      return c.json(err, 400);
    }

    if (!body || typeof body.name !== "string" || body.name.length === 0) {
      log.warn("invalid body: missing/empty name");
      const err: SetCurrentModelErrorResponse = {
        error: "name must be a non-empty string",
        available: deps.configStore.availableNames(),
      };
      return c.json(err, 400);
    }

    try {
      const cfg = await deps.configStore.setCurrent(body.name);
      log.info("set current model", { name: cfg.name });
      const ok: SetCurrentModelResponse = { current: cfg.name };
      return c.json(ok);
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        log.warn("set current: not found", {
          name: body.name,
          available: err.available,
        });
        const out: SetCurrentModelErrorResponse = {
          error: err.message,
          available: err.available,
        };
        return c.json(out, 400);
      }
      log.error("set current failed", err, { name: body.name });
      throw err;
    }
  });

  return route;
}
