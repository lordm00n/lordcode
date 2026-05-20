import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonSessionPayloadError,
  SqliteSessionStore,
  deriveProjectId,
} from "./store.js";
import type { SessionEventInput } from "./types.js";

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lordcode-sessions-"));
  cleanups.push(dir);
  return join(dir, "sessions.sqlite");
}

async function createStore(): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open({ path: await tempDbPath() });
}

describe("SqliteSessionStore migrations", () => {
  it("[UT-1] creates the required tables and indexes", async () => {
    const path = await tempDbPath();
    const store = await SqliteSessionStore.open({ path });

    try {
      const objects = selectRows<{ name: string; type: string }>(
        store,
        "SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?)",
        [
          "schema_migrations",
          "sessions",
          "session_events",
          "idx_sessions_project_updated",
          "idx_session_events_session_seq",
        ],
      );

      expect(objects).toEqual(
        expect.arrayContaining([
          { name: "schema_migrations", type: "table" },
          { name: "sessions", type: "table" },
          { name: "session_events", type: "table" },
          { name: "idx_sessions_project_updated", type: "index" },
          { name: "idx_session_events_session_seq", type: "index" },
        ]),
      );
      expect(
        selectRows<{ version: number }>(
          store,
          "SELECT version FROM schema_migrations",
        ),
      ).toEqual([{ version: 1 }]);
    } finally {
      store.close();
    }
  });
});

describe("SqliteSessionStore sessions and events", () => {
  it("[UT-2] creates sessions without a title", async () => {
    const store = await createStore();
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: "gpt-4o",
      });

      expect(session.title).toBeNull();
      expect(session.titleSource).toBe("none");
      expect(session.projectId).toBe(deriveProjectId("/tmp/project"));
      expect(session.model).toBe("gpt-4o");
    } finally {
      store.close();
    }
  });

  it("[UT-3] auto-titles a session from the first user message", async () => {
    const store = await createStore();
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: null,
      });

      await store.appendEvent(session.id, {
        type: "message",
        role: "user",
        payload: {
          content:
            "  实现   session\n持久化并确保这个标题超过四十个字符用于截断并添加更多内容来触发省略号  ",
          attachments: [],
        },
      });

      const loaded = await store.loadSession(session.id);
      expect(loaded.session.title).toBe(
        "实现 session 持久化并确保这个标题超过四十个字符用于截断并添加更多内容来...",
      );
      expect(loaded.session.titleSource).toBe("auto");
    } finally {
      store.close();
    }
  });

  it("[UT-4] does not overwrite a user-renamed title", async () => {
    const store = await createStore();
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: null,
      });

      await store.renameSession(session.id, "Hand picked");
      await store.appendEvent(session.id, userEvent("first generated title"));

      const loaded = await store.loadSession(session.id);
      expect(loaded.session.title).toBe("Hand picked");
      expect(loaded.session.titleSource).toBe("user");
    } finally {
      store.close();
    }
  });

  it("[UT-5] appends events with stable unique sequence numbers", async () => {
    const store = await createStore();
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: null,
      });

      await store.appendEvent(session.id, userEvent("one"));
      await store.appendEvent(session.id, assistantEvent("two"));
      await store.appendEvent(session.id, userEvent("three"));

      const loaded = await store.loadSession(session.id);
      expect(loaded.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    } finally {
      store.close();
    }
  });

  it("[UT-6] deletes related events when a session is deleted", async () => {
    const store = await createStore();
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: null,
      });
      await store.appendEvent(session.id, userEvent("one"));

      await store.deleteSession(session.id);

      await expect(store.loadSession(session.id)).rejects.toThrow(
        /session not found/,
      );
    } finally {
      store.close();
    }
  });
});

describe("SqliteSessionStore loading and listing", () => {
  it("[UT-7] loads message, tool call, and tool result events in sequence order", async () => {
    const store = await createStore();
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: "gpt-4o",
      });
      await store.appendEvent(session.id, userEvent("inspect files"));
      await store.appendEvent(session.id, {
        type: "tool_call",
        payload: {
          toolCallId: "call_1",
          toolName: "read_file",
          input: { path: "README.md" },
        },
      });
      await store.appendEvent(session.id, {
        type: "tool_result",
        payload: {
          toolCallId: "call_1",
          toolName: "read_file",
          result: { content: "hello" },
          isError: false,
        },
      });

      const loaded = await store.loadSession(session.id);

      expect(loaded.events.map((event) => event.type)).toEqual([
        "message",
        "tool_call",
        "tool_result",
      ]);
      expect(loaded.events[1]?.payload).toEqual({
        toolCallId: "call_1",
        toolName: "read_file",
        input: { path: "README.md" },
      });
    } finally {
      store.close();
    }
  });

  it("[UT-8] fails clearly when an event payload is malformed JSON", async () => {
    const path = await tempDbPath();
    const store = await SqliteSessionStore.open({ path });
    try {
      const session = await store.createSession({
        projectPath: "/tmp/project",
        model: null,
      });
      store.rawDb.run(
        "INSERT INTO session_events (session_id, seq, type, role, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [session.id, 1, "message", "user", "{not-json", Date.now()],
      );
      await store.flush();

      await expect(store.loadSession(session.id)).rejects.toBeInstanceOf(
        JsonSessionPayloadError,
      );
    } finally {
      store.close();
    }
  });

  it("[UT-9] lists only sessions for the requested project by recency", async () => {
    const store = await createStore();
    try {
      const first = await store.createSession({
        projectPath: "/tmp/project-a",
        model: "gpt-4o",
      });
      const other = await store.createSession({
        projectPath: "/tmp/project-b",
        model: "claude",
      });
      const second = await store.createSession({
        projectPath: "/tmp/project-a",
        model: "deepseek",
      });
      await store.appendEvent(first.id, userEvent("older"));
      await store.appendEvent(other.id, userEvent("hidden"));
      await store.appendEvent(second.id, userEvent("newer"));

      const summaries = await store.listSessions({
        projectPath: "/tmp/project-a",
        limit: 10,
      });

      expect(summaries.map((summary) => summary.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(summaries).toEqual([
        expect.objectContaining({
          messageCount: 1,
          model: "deepseek",
          projectPath: "/tmp/project-a",
        }),
        expect.objectContaining({
          messageCount: 1,
          model: "gpt-4o",
          projectPath: "/tmp/project-a",
        }),
      ]);
    } finally {
      store.close();
    }
  });
});

function userEvent(content: string): SessionEventInput {
  return {
    type: "message",
    role: "user",
    payload: { content, attachments: [] },
  };
}

function assistantEvent(content: string): SessionEventInput {
  return {
    type: "message",
    role: "assistant",
    payload: { content, finishReason: "stop" },
  };
}

function selectRows<T>(
  store: SqliteSessionStore,
  sql: string,
  params: (number | string | Uint8Array | null)[] = [],
): T[] {
  const result = store.rawDb.exec(sql, params);
  const first = result[0];
  if (first == null) return [];
  return first.values.map((row) =>
    Object.fromEntries(first.columns.map((column, i) => [column, row[i]])),
  ) as T[];
}
