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

  route.get("/", (c) => {
    const body: ModelsListResponse = deps.configStore.toListResponse();
    return c.json(body);
  });

  route.post("/current", async (c) => {
    let body: SetCurrentModelRequest;
    try {
      body = (await c.req.json()) as SetCurrentModelRequest;
    } catch {
      const err: SetCurrentModelErrorResponse = {
        error: "request body must be JSON",
        available: deps.configStore.availableNames(),
      };
      return c.json(err, 400);
    }

    if (!body || typeof body.name !== "string" || body.name.length === 0) {
      const err: SetCurrentModelErrorResponse = {
        error: "name must be a non-empty string",
        available: deps.configStore.availableNames(),
      };
      return c.json(err, 400);
    }

    try {
      const cfg = await deps.configStore.setCurrent(body.name);
      const ok: SetCurrentModelResponse = { current: cfg.name };
      return c.json(ok);
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        const out: SetCurrentModelErrorResponse = {
          error: err.message,
          available: err.available,
        };
        return c.json(out, 400);
      }
      throw err;
    }
  });

  return route;
}
