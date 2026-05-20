import type { ModelMessage, SessionSummary } from "@lordcode/shared";
import type { Logger } from "@lordcode/logger";
import { fileTransport } from "@lordcode/logger/node";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDbPath, getSessionsLogDir } from "../config/paths.js";
import { SqliteSessionStore, deriveProjectId } from "./store.js";
import type {
  SessionEventInput,
  SessionEventRecord,
  SessionRecord,
} from "./types.js";

export class SessionRuntime {
  private constructor(
    readonly store: SqliteSessionStore,
    readonly projectPath: string,
    private readonly rootLogger: Logger,
    private readonly sessionsLogDir: string,
    private activeSessionId: string,
    private activeLog: Logger,
  ) {}

  static async open(input: {
    home?: string;
    projectPath: string;
    model: string | null;
    logger: Logger;
  }): Promise<SessionRuntime> {
    const sessionsLogDir = getSessionsLogDir(input.home);
    await mkdir(sessionsLogDir, { recursive: true });
    const store = await SqliteSessionStore.open({
      path: getSessionsDbPath(input.home),
    });
    const session = await store.createSession({
      projectPath: input.projectPath,
      model: input.model,
    });
    const activeLog = createSessionLogger(
      input.logger,
      sessionsLogDir,
      session.id,
    );
    activeLog.info("session started", {
      sessionId: session.id,
      projectPath: session.projectPath,
    });
    return new SessionRuntime(
      store,
      session.projectPath,
      input.logger,
      sessionsLogDir,
      session.id,
      activeLog,
    );
  }

  get activeId(): string {
    return this.activeSessionId;
  }

  get log(): Logger {
    return this.activeLog;
  }

  async createNew(model: string | null): Promise<{
    session: SessionSummary;
    history: ModelMessage[];
  }> {
    const session = await this.store.createSession({
      projectPath: this.projectPath,
      model,
    });
    await this.switchActiveLog(session.id, "session started");
    return { session: await this.summaryFor(session), history: [] };
  }

  async list(limit = 50): Promise<SessionSummary[]> {
    return this.store.listSessions({ projectPath: this.projectPath, limit });
  }

  async activate(sessionId: string): Promise<{
    session: SessionSummary;
    history: ModelMessage[];
  }> {
    const loaded = await this.store.loadSession(sessionId);
    if (loaded.session.projectId !== deriveProjectId(this.projectPath)) {
      throw new Error("session does not belong to the current project");
    }
    await this.switchActiveLog(sessionId, "session resumed");
    return {
      session: await this.summaryFor(loaded.session),
      history: eventsToModelMessages(loaded.events),
    };
  }

  async renameActive(title: string): Promise<SessionSummary> {
    const session = await this.store.renameSession(this.activeSessionId, title);
    return this.summaryFor(session);
  }

  async appendActive(event: SessionEventInput): Promise<void> {
    await this.store.appendEvent(this.activeSessionId, event);
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (sessionId === this.activeSessionId) {
      throw new Error("cannot delete active session");
    }
    const loaded = await this.store.loadSession(sessionId);
    if (loaded.session.projectId !== deriveProjectId(this.projectPath)) {
      throw new Error("session does not belong to the current project");
    }
    await this.store.deleteSession(sessionId);
    try {
      await unlink(join(this.sessionsLogDir, `${sessionId}.log`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async flushLog(): Promise<void> {
    await this.switchActiveLog(this.activeSessionId);
  }

  async close(): Promise<void> {
    await this.activeLog.close();
    this.store.close();
  }

  private async switchActiveLog(
    sessionId: string,
    message?: "session started" | "session resumed",
  ): Promise<void> {
    await this.activeLog.close();
    this.activeSessionId = sessionId;
    this.activeLog = createSessionLogger(
      this.rootLogger,
      this.sessionsLogDir,
      sessionId,
    );
    if (message != null) {
      this.activeLog.info(message, {
        sessionId,
        projectPath: this.projectPath,
      });
    }
  }

  private async summaryFor(session: SessionRecord): Promise<SessionSummary> {
    const summaries = await this.list(100);
    const found = summaries.find((summary) => summary.id === session.id);
    if (found != null) return found;
    return {
      id: session.id,
      title: session.title,
      titleSource: session.titleSource,
      projectPath: session.projectPath,
      updatedAt: session.updatedAt,
      messageCount: 0,
      model: session.model,
    };
  }
}

function createSessionLogger(
  rootLogger: Logger,
  sessionsLogDir: string,
  sessionId: string,
): Logger {
  return rootLogger
    .child("session")
    .child(sessionId)
    .tee(fileTransport(join(sessionsLogDir, `${sessionId}.log`)));
}

export function eventsToModelMessages(
  events: SessionEventRecord[],
): ModelMessage[] {
  const history: ModelMessage[] = [];
  for (const event of events) {
    if (event.type === "message") {
      if (event.role === "user") {
        const payload = event.payload as { content?: unknown };
        history.push({ role: "user", content: payload.content as never });
      } else if (event.role === "assistant") {
        const payload = event.payload as { content?: unknown };
        history.push({
          role: "assistant",
          content: typeof payload.content === "string" ? payload.content : "",
        });
      } else if (event.role === "system") {
        const payload = event.payload as { content?: unknown };
        history.push({
          role: "system",
          content: typeof payload.content === "string" ? payload.content : "",
        });
      }
      continue;
    }
    if (event.type === "tool_call") {
      const payload = event.payload as {
        toolCallId: string;
        toolName: string;
        input: unknown;
      };
      history.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            input: payload.input,
          },
        ],
      });
      continue;
    }
    if (event.type === "tool_result") {
      const payload = event.payload as {
        toolCallId: string;
        toolName: string;
        result?: unknown;
        isError?: boolean;
      };
      history.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            output: payload.isError
              ? { type: "error-json", value: payload.result as never }
              : { type: "json", value: payload.result as never },
          },
        ],
      });
    }
  }
  return history;
}
