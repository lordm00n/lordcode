import { tool } from "ai";
import { executeWriteFile, type WriteFileDeps } from "./execute.js";
import {
  WRITE_FILE_TOOL_DESCRIPTION,
  WriteFileInputSchema,
  WriteFileOutputSchema,
} from "./schema.js";

export function createWriteFileTool(deps: Omit<WriteFileDeps, "signal">) {
  return tool({
    description: WRITE_FILE_TOOL_DESCRIPTION,
    inputSchema: WriteFileInputSchema,
    outputSchema: WriteFileOutputSchema,
    execute: async (input, { abortSignal }) =>
      executeWriteFile(input, {
        ...deps,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }),
  });
}
