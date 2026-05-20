import { Hono } from "hono";
import type {
  ActivateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  ListSessionsResponse,
  RenameSessionRequest,
} from "@lordcode/shared";
import type { AppDeps } from "../app.js";

export function sessionsRoute(deps: AppDeps) {
  const route = new Hono();

  route.get("/", async (c) => {
    const body: ListSessionsResponse = {
      sessions: await deps.sessionRuntime.list(),
    };
    return c.json(body);
  });

  route.post("/", async (c) => {
    const created = await deps.sessionRuntime.createNew(
      deps.configStore.getCurrentName(),
    );
    const body: CreateSessionResponse = created;
    deps.sessionRuntime.log
      .child("route")
      .child("sessions")
      .info("created new active session", { sessionId: body.session.id });
    return c.json(body);
  });

  route.post("/active", async (c) => {
    let body: ActivateSessionRequest;
    try {
      body = (await c.req.json()) as ActivateSessionRequest;
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }
    if (!body || typeof body.sessionId !== "string" || body.sessionId === "") {
      return c.json({ error: "sessionId must be a non-empty string" }, 400);
    }
    try {
      const activated = await deps.sessionRuntime.activate(body.sessionId);
      deps.sessionRuntime.log
        .child("route")
        .child("sessions")
        .info("activated session", { sessionId: body.sessionId });
      return c.json(activated satisfies CreateSessionResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /current project/.test(message) ? 403 : 404;
      return c.json({ error: message }, status);
    }
  });

  route.post("/current/rename", async (c) => {
    let body: RenameSessionRequest;
    try {
      body = (await c.req.json()) as RenameSessionRequest;
    } catch {
      return c.json({ error: "request body must be JSON" }, 400);
    }
    const title = body?.title?.trim();
    if (!title) {
      return c.json({ error: "title must be a non-empty string" }, 400);
    }
    const renamed = await deps.sessionRuntime.renameActive(title);
    deps.sessionRuntime.log
      .child("route")
      .child("sessions")
      .info("renamed active session", { sessionId: renamed.id });
    return c.json(renamed);
  });

  route.delete("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) {
      return c.json({ error: "sessionId must be a non-empty string" }, 400);
    }
    try {
      await deps.sessionRuntime.deleteSession(sessionId);
      const body: DeleteSessionResponse = { deletedSessionId: sessionId };
      deps.sessionRuntime.log
        .child("route")
        .child("sessions")
        .info("deleted session", { sessionId });
      return c.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /active session/.test(message)
        ? 409
        : /current project/.test(message)
          ? 403
          : 404;
      return c.json({ error: message }, status);
    }
  });

  return route;
}
