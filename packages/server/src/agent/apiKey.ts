import type { Logger } from "@lordcode/logger";
import type { ModelConfig } from "@lordcode/shared";

/**
 * Resolution rules (per spec):
 *
 * - If `apiKeyEnv` is set:
 *   - Read `process.env[apiKeyEnv]`. If non-empty → return it (env wins).
 *   - If env is unset/empty → fall back to `apiKey` if present.
 * - Else if `apiKey` is set → return it.
 * - Else → return null.
 *
 * Empty-string env vars are treated as missing (Q: B4.6).
 *
 * The `logger` argument is optional so unit tests can call this without
 * standing up a logger. When supplied, we record only the *source* of the
 * key (env / plain / missing) — never the key value itself (logging spec
 * §9, channel `server:agent:apikey`).
 */
export function resolveApiKey(
  cfg: ModelConfig,
  logger?: Logger,
): string | null {
  if (cfg.apiKeyEnv) {
    const v = process.env[cfg.apiKeyEnv];
    if (v != null && v.length > 0) {
      logger?.debug("apiKey resolved", {
        source: "env",
        env: cfg.apiKeyEnv,
        model: cfg.name,
      });
      return v;
    }
  }
  if (cfg.apiKey != null && cfg.apiKey.length > 0) {
    logger?.debug("apiKey resolved", {
      source: "plain",
      ...(cfg.apiKeyEnv ? { env: cfg.apiKeyEnv } : {}),
      model: cfg.name,
    });
    return cfg.apiKey;
  }
  logger?.warn("apiKey missing", {
    model: cfg.name,
    ...(cfg.apiKeyEnv ? { env: cfg.apiKeyEnv } : {}),
  });
  return null;
}
