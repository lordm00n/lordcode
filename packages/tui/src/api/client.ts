import {
  API_ROUTES,
  type AgentChatRequest,
  type AgentChatResponse,
  type HealthResponse,
} from "@lordcode/shared";

export interface ApiClient {
  health(): Promise<HealthResponse>;
  chat(req: AgentChatRequest): Promise<AgentChatResponse>;
}

export function createApiClient(baseUrl: string): ApiClient {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${path}: ${text}`);
    }
    return (await res.json()) as T;
  };

  return {
    health: () => json<HealthResponse>(API_ROUTES.health),
    chat: (req) =>
      json<AgentChatResponse>(API_ROUTES.agentChat, {
        method: "POST",
        body: JSON.stringify(req),
      }),
  };
}
