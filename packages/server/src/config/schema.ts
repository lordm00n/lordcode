import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import type { LordcodeConfig } from "@lordcode/shared";

/**
 * zod schema for `~/.lordcode/config.json`.
 *
 * Notes:
 * - `currentModel` is NOT cross-validated against `models` here — that's the
 *   store's responsibility (it implements the "fallback to models[0]" rule).
 * - Each model must declare *some* way to source an apiKey (either `apiKey`
 *   or `apiKeyEnv`). Whether the env var actually has a value is not the
 *   schema's concern; it's checked at chat-time by `resolveApiKey`.
 */
const modelConfigSchema = z
  .object({
    name: z.string().min(1, "name must be a non-empty string"),
    provider: z.enum(["openai", "openai-compatible", "anthropic", "deepseek"]),
    model: z.string().min(1, "model must be a non-empty string"),
    baseURL: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
  })
  .refine((m) => m.apiKey != null || m.apiKeyEnv != null, {
    message: "either apiKey or apiKeyEnv must be set",
    path: ["apiKey"],
  })
  .refine((m) => m.provider !== "openai-compatible" || m.baseURL != null, {
    message: "baseURL is required when provider is \"openai-compatible\"",
    path: ["baseURL"],
  });

export const lordcodeConfigSchema = z
  .object({
    version: z.literal(1),
    currentModel: z.string().min(1).optional(),
    models: z.array(modelConfigSchema),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.models.forEach((m, idx) => {
      if (seen.has(m.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", idx, "name"],
          message: `duplicate model name "${m.name}"`,
        });
      }
      seen.add(m.name);
    });
  });

export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

/**
 * Parse JSONC text → validated LordcodeConfig.
 * Throws `ConfigParseError` with field path information on any failure.
 */
export function parseConfig(rawText: string): LordcodeConfig {
  const parseErrors: import("jsonc-parser").ParseError[] = [];
  const data = parseJsonc(rawText, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (parseErrors.length > 0) {
    const first = parseErrors[0]!;
    throw new ConfigParseError(
      `invalid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }

  const result = lordcodeConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join(".") : "(root)";
      return `${path}: ${iss.message}`;
    });
    throw new ConfigParseError(`invalid config:\n  - ${issues.join("\n  - ")}`);
  }

  return result.data;
}
