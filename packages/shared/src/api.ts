/**
 * HTTP API contracts shared between server, TUI, and (future) web UI.
 * Keep this file dependency-free: pure types only.
 */

export interface HealthResponse {
  status: "ok";
  version: string;
  uptimeMs: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AgentChatRequest {
  messages: ChatMessage[];
}

export interface AgentChatResponse {
  message: ChatMessage;
}

export const API_ROUTES = {
  health: "/health",
  agentChat: "/agent/chat",
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
