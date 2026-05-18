import { tool } from "ai";
import { executeBash, type BashDeps } from "./execute.js";
import {
  BASH_TOOL_DESCRIPTION,
  BashInputSchema,
  BashOutputSchema,
} from "./schema.js";

export function createBashTool(deps: Omit<BashDeps, "signal">) {
  return tool({
    description: BASH_TOOL_DESCRIPTION,
    inputSchema: BashInputSchema,
    outputSchema: BashOutputSchema,
    execute: async (input, { abortSignal }) =>
      executeBash(input, {
        ...deps,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }),
  });
}
