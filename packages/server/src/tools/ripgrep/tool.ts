import { tool } from "ai";
import { executeRipgrep, type RipgrepDeps } from "./execute.js";
import {
  RIPGREP_TOOL_DESCRIPTION,
  RipgrepInputSchema,
  RipgrepOutputSchema,
} from "./schema.js";

/**
 * Wrap {@link executeRipgrep} as a Vercel AI SDK tool.
 *
 * The factory pattern lets us thread per-process deps (rgPath, cwd, logger)
 * into the SDK's `execute` callback while keeping the actual ripgrep logic
 * SDK-agnostic in `execute.ts`. The signal SDK passes us is forwarded to the
 * spawned `rg` so user-side cancellation propagates all the way through.
 *
 * The `signal` field of `RipgrepDeps` is intentionally excluded from the
 * factory parameter — it always comes from the SDK at call time.
 */
export function createRipgrepTool(deps: Omit<RipgrepDeps, "signal">) {
  return tool({
    description: RIPGREP_TOOL_DESCRIPTION,
    inputSchema: RipgrepInputSchema,
    outputSchema: RipgrepOutputSchema,
    execute: async (input, { abortSignal }) =>
      executeRipgrep(input, {
        ...deps,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }),
  });
}
