/**
 * Config + model DTO types shared between server and clients (TUI / web).
 * Pure types only — no runtime imports.
 */

/**
 * Provider tag.
 *
 * - `openai` → `@ai-sdk/openai`, default entry uses the **Responses API**
 *   (`POST /responses`). Use this for OpenAI's own GPT-5 / o-series and any
 *   gateway that speaks Responses.
 * - `openai-compatible` → `@ai-sdk/openai-compatible`, uses the **Chat
 *   Completions API** (`POST /chat/completions`). Use this for the wide
 *   ecosystem of OpenAI-compatible providers (DeepSeek-clones, Kimi, GLM,
 *   ModelScope, OpenCode Zen non-OpenAI models, local Ollama / vLLM, etc.).
 *   `baseURL` is REQUIRED for this provider.
 * - `anthropic` → `@ai-sdk/anthropic`.
 * - `deepseek` → `@ai-sdk/deepseek`.
 */
export type ModelProvider =
  | "openai"
  | "openai-compatible"
  | "anthropic"
  | "deepseek";

/** Raw model config as it appears on disk in `~/.lordcode/config.json`. */
export interface ModelConfig {
  /** User alias; primary key, must be unique within the file. */
  name: string;
  provider: ModelProvider;
  /** The provider-specific model id passed to the Vercel AI SDK. */
  model: string;
  /**
   * Override for the provider's default endpoint.
   * Optional for `openai` / `anthropic` / `deepseek` (they have built-in
   * defaults); REQUIRED for `openai-compatible`.
   */
  baseURL?: string;
  /** Plaintext apiKey, used as a fallback when `apiKeyEnv` is unset / empty. */
  apiKey?: string;
  /** Name of an environment variable to read the apiKey from. Takes precedence over `apiKey`. */
  apiKeyEnv?: string;
}

export interface LordcodeConfig {
  version: 1;
  /** References `models[].name`. When missing, startup falls back to `models[0]?.name ?? null`. */
  currentModel?: string;
  models: ModelConfig[];
}

/**
 * Sanitised view of a model for client consumption.
 * Critically: `apiKey` is NEVER exposed; clients only learn the *source*.
 */
export interface ModelSummary {
  name: string;
  provider: ModelProvider;
  model: string;
  baseURL?: string;
  apiKeySource: "env" | "plain" | "missing";
  apiKeyEnv?: string;
}

export interface ModelsListResponse {
  models: ModelSummary[];
  current: string | null;
}

export interface SetCurrentModelRequest {
  name: string;
}

export interface SetCurrentModelResponse {
  current: string;
}

export interface SetCurrentModelErrorResponse {
  error: string;
  available: string[];
}
