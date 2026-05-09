import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import type { Logger } from "@lordcode/logger";
import type { ModelConfig } from "@lordcode/shared";

/**
 * Instantiate a Vercel AI SDK `LanguageModel` for the given config + apiKey.
 *
 * Wire-protocol mapping:
 * - `openai`            → `@ai-sdk/openai` default entry (Responses API,
 *                         `POST /responses`). For OpenAI's own GPT-5/o-series
 *                         and gateways that speak Responses.
 * - `openai-compatible` → `@ai-sdk/openai-compatible` (Chat Completions,
 *                         `POST /chat/completions`). Schema guarantees
 *                         `baseURL` is set for this provider.
 * - `anthropic`         → `@ai-sdk/anthropic` (Messages API).
 * - `deepseek`          → `@ai-sdk/deepseek`.
 *
 * Defensive only: this function fans out and throws on anything else. Per Q5
 * in test-category, we don't unit-test the happy-path dispatch — that's
 * covered by spec §12 (manual run of each provider).
 *
 * `logger` is optional so tests can omit it; when present, errors are logged
 * on `server:agent:provider` (the caller is responsible for `child("provider")`).
 */
export function resolveLanguageModel(
  cfg: ModelConfig,
  apiKey: string,
  logger?: Logger,
): LanguageModel {
  switch (cfg.provider) {
    case "openai": {
      const provider = createOpenAI({
        apiKey,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      });
      return provider(cfg.model);
    }
    case "openai-compatible": {
      if (!cfg.baseURL) {
        const err = new Error(
          `provider "openai-compatible" requires baseURL (model "${cfg.name}")`,
        );
        logger?.error("missing baseURL", err, { model: cfg.name });
        throw err;
      }
      const provider = createOpenAICompatible({
        name: cfg.name,
        apiKey,
        baseURL: cfg.baseURL,
      });
      return provider.chatModel(cfg.model);
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      });
      return provider(cfg.model);
    }
    case "deepseek": {
      const provider = createDeepSeek({
        apiKey,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      });
      return provider(cfg.model);
    }
    default: {
      const provider = (cfg as { provider: string }).provider;
      const err = new Error(`unsupported provider: ${provider}`);
      logger?.error("unsupported provider", err, {
        provider,
        model: cfg.name,
      });
      throw err;
    }
  }
}
