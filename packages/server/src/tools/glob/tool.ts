import { tool } from "ai";
import { executeGlob, type GlobDeps } from "./execute.js";
import {
  GLOB_TOOL_DESCRIPTION,
  GlobInputSchema,
  GlobOutputSchema,
} from "./schema.js";

export function createGlobTool(deps: Omit<GlobDeps, "signal">) {
  return tool({
    description: GLOB_TOOL_DESCRIPTION,
    inputSchema: GlobInputSchema,
    outputSchema: GlobOutputSchema,
    execute: async (input, { abortSignal }) =>
      executeGlob(input, {
        ...deps,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }),
  });
}
