import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import type {
  CreateSessionInput,
  ListSessionsInput,
  LoadedSession,
  SessionEventInput,
  SessionEventRecord,
  SessionRecord,
  SessionSummary,
} from "./types.js";

type SqlParam = number | string | Uint8Array | null;

export class JsonSessionPayloadError extends Error {
  override readonly name = "JsonSessionPayloadError";
  constructor(sessionId: string, seq: number, cause: unknown) {
    super(`failed to parse session event payload: ${sessionId} seq ${seq}`);
    this.cause = cause;
  }
}

interface SessionRow {
  id: string;
  project_id: string;
  project_path: string;
  title: string | null;
  title_source: SessionRecord["titleSource"];
  model: string | null;
  status: SessionRecord["status"];
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  type: SessionEventRecord["type"];
  role: SessionEventRecord["role"] | null;
  payload: string;
  created_at: number;
}

export class SqliteSessionStore {
  private lastNow = 0;

  private constructor(
    readonly rawDb: SqlJsDatabase,
    private readonly path: string,
  ) {}

  static async open(opts: { path: string }): Promise<SqliteSessionStore> {
    await mkdir(dirname(opts.path), { recursive: true });
    const SQL = await getSqlJs();
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readFile(opts.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const store = new SqliteSessionStore(new SQL.Database(bytes), opts.path);
    store.configureConnection();
    store.migrate();
    await store.flush();
    return store;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = this.now();
    const projectPath = resolve(input.projectPath);
    const row: SessionRow = {
      id: `ses_${randomUUID()}`,
      project_id: deriveProjectId(projectPath),
      project_path: projectPath,
      title: null,
      title_source: "none",
      model: input.model,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    this.rawDb.run(
      `INSERT INTO sessions
        (id, project_id, project_path, title, title_source, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.project_id,
        row.project_path,
        row.title,
        row.title_source,
        row.model,
        row.status,
        row.created_at,
        row.updated_at,
      ],
    );
    await this.flush();
    return toSessionRecord(row);
  }

  async appendEvent(
    sessionId: string,
    event: SessionEventInput,
  ): Promise<void> {
    const session = this.getSessionRow(sessionId);
    const now = this.now();
    const nextSeq =
      (selectOne<{ max_seq: number | null }>(
        this.rawDb,
        "SELECT MAX(seq) AS max_seq FROM session_events WHERE session_id = ?",
        [sessionId],
      )?.max_seq ?? 0) + 1;

    this.rawDb.run("BEGIN");
    try {
      this.rawDb.run(
        `INSERT INTO session_events
          (session_id, seq, type, role, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          nextSeq,
          event.type,
          event.role ?? null,
          JSON.stringify(event.payload),
          now,
        ],
      );

      const autoTitle = automaticTitleFor(session, event);
      if (autoTitle != null) {
        this.rawDb.run(
          "UPDATE sessions SET title = ?, title_source = ?, updated_at = ? WHERE id = ?",
          [autoTitle, "auto", now, sessionId],
        );
      } else {
        this.rawDb.run("UPDATE sessions SET updated_at = ? WHERE id = ?", [
          now,
          sessionId,
        ]);
      }
      this.rawDb.run("COMMIT");
    } catch (err) {
      this.rawDb.run("ROLLBACK");
      throw err;
    }
    await this.flush();
  }

  async listSessions(input: ListSessionsInput): Promise<SessionSummary[]> {
    const projectPath = resolve(input.projectPath);
    const rows = selectAll<
      SessionRow & { message_count: number }
    >(
      this.rawDb,
      `SELECT s.*,
        COALESCE(SUM(CASE WHEN e.type = 'message' THEN 1 ELSE 0 END), 0) AS message_count
       FROM sessions s
       LEFT JOIN session_events e ON e.session_id = s.id
       WHERE s.project_id = ?
       GROUP BY s.id
       ORDER BY s.updated_at DESC
       LIMIT ?`,
      [deriveProjectId(projectPath), input.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      titleSource: row.title_source,
      projectPath: row.project_path,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
      model: row.model,
    }));
  }

  async loadSession(sessionId: string): Promise<LoadedSession> {
    const session = this.getSessionRow(sessionId);
    const rows = selectAll<EventRow>(
      this.rawDb,
      "SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC",
      [sessionId],
    );
    return {
      session: toSessionRecord(session),
      events: rows.map((row) => toEventRecord(row)),
    };
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<SessionRecord> {
    this.getSessionRow(sessionId);
    const now = this.now();
    this.rawDb.run(
      "UPDATE sessions SET title = ?, title_source = ?, updated_at = ? WHERE id = ?",
      [title, "user", now, sessionId],
    );
    await this.flush();
    return toSessionRecord(this.getSessionRow(sessionId));
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.rawDb.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    await this.flush();
  }

  async flush(): Promise<void> {
    await writeFile(this.path, this.rawDb.export());
  }

  close(): void {
    this.rawDb.close();
  }

  private configureConnection(): void {
    this.rawDb.run("PRAGMA journal_mode = WAL");
    this.rawDb.run("PRAGMA foreign_keys = ON");
    this.rawDb.run("PRAGMA busy_timeout = 5000");
  }

  private migrate(): void {
    this.rawDb.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const current =
      selectOne<{ version: number }>(
        this.rawDb,
        "SELECT MAX(version) AS version FROM schema_migrations",
      )?.version ?? 0;
    if (current < 1) {
      this.rawDb.run("BEGIN");
      try {
        this.rawDb.run(`CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          title TEXT,
          title_source TEXT NOT NULL,
          model TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`);
        this.rawDb.run(`CREATE INDEX idx_sessions_project_updated
          ON sessions(project_id, updated_at DESC)`);
        this.rawDb.run(`CREATE TABLE session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          role TEXT,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          UNIQUE (session_id, seq)
        )`);
        this.rawDb.run(`CREATE INDEX idx_session_events_session_seq
          ON session_events(session_id, seq)`);
        this.rawDb.run(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          [1, this.now()],
        );
        this.rawDb.run("COMMIT");
      } catch (err) {
        this.rawDb.run("ROLLBACK");
        throw err;
      }
    }
  }

  private getSessionRow(sessionId: string): SessionRow {
    const row = selectOne<SessionRow>(
      this.rawDb,
      "SELECT * FROM sessions WHERE id = ?",
      [sessionId],
    );
    if (row == null) throw new Error(`session not found: ${sessionId}`);
    return row;
  }

  private now(): number {
    const current = Date.now();
    this.lastNow = current <= this.lastNow ? this.lastNow + 1 : current;
    return this.lastNow;
  }
}

export function deriveProjectId(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex");
}

let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

function getSqlJs(): ReturnType<typeof initSqlJs> {
  sqlJsPromise ??= initSqlJs();
  return sqlJsPromise;
}

function selectOne<T>(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParam[] = [],
): T | null {
  return selectAll<T>(db, sql, params)[0] ?? null;
}

function selectAll<T>(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParam[] = [],
): T[] {
  const result = db.exec(sql, params);
  const first = result[0];
  if (first == null) return [];
  return first.values.map((row) =>
    Object.fromEntries(first.columns.map((column, i) => [column, row[i]])),
  ) as T[];
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    projectPath: row.project_path,
    title: row.title,
    titleSource: row.title_source,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEventRecord(row: EventRow): SessionEventRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch (err) {
    throw new JsonSessionPayloadError(row.session_id, row.seq, err);
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    ...(row.role == null ? {} : { role: row.role }),
    payload,
    createdAt: row.created_at,
  };
}

function automaticTitleFor(
  session: SessionRow,
  event: SessionEventInput,
): string | null {
  if (session.title_source !== "none") return null;
  if (event.type !== "message" || event.role !== "user") return null;
  if (event.payload == null || typeof event.payload !== "object") return null;
  const content = (event.payload as { content?: unknown }).content;
  if (typeof content !== "string") return null;
  const normalised = content.trim().replace(/\s+/g, " ");
  if (normalised.length === 0) return null;
  return normalised.length > 40 ? `${normalised.slice(0, 40)}...` : normalised;
}
