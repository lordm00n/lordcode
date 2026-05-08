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
 */
export function resolveApiKey(cfg: ModelConfig): string | null {
  if (cfg.apiKeyEnv) {
    const v = process.env[cfg.apiKeyEnv];
    if (v != null && v.length > 0) return v;
  }
  if (cfg.apiKey != null && cfg.apiKey.length > 0) return cfg.apiKey;
  return null;
}
