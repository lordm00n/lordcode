export type SessionTitleSource = "none" | "auto" | "user";
export type SessionStatus = "active" | "idle" | "archived";
export type SessionEventType =
  | "message"
  | "tool_call"
  | "tool_result"
  | "system_event";
export type SessionEventRole = "user" | "assistant" | "system";

export interface SessionRecord {
  id: string;
  projectId: string;
  projectPath: string;
  title: string | null;
  titleSource: SessionTitleSource;
  model: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionInput {
  projectPath: string;
  model: string | null;
}

export interface SessionEventInput {
  type: SessionEventType;
  role?: SessionEventRole;
  payload: unknown;
}

export interface SessionEventRecord extends SessionEventInput {
  id: number;
  sessionId: string;
  seq: number;
  createdAt: number;
}

export interface ListSessionsInput {
  projectPath: string;
  limit: number;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  titleSource: SessionTitleSource;
  projectPath: string;
  updatedAt: number;
  messageCount: number;
  model: string | null;
}

export interface LoadedSession {
  session: SessionRecord;
  events: SessionEventRecord[];
}
