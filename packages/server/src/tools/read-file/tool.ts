import { tool } from "ai";
import { executeReadFile, type ReadFileDeps } from "./execute.js";
import {
  READ_FILE_TOOL_DESCRIPTION,
  ReadFileInputSchema,
  ReadFileOutputSchema,
  type ReadFileOutput,
} from "./schema.js";

/**
 * Wrap {@link executeReadFile} as a Vercel AI SDK tool.
 *
 * Two SDK-specific responsibilities live here:
 *
 *   1. Threading the SDK-supplied `abortSignal` into our deps so user-side
 *      cancellation propagates all the way down to `fs.readFile`.
 *
 *   2. {@link toModelOutput} translation: image results take the SDK's
 *      `{type:'content', value:[..., {type:'file-data', ...}]}` route so
 *      vision models actually see the bytes; text results get folded into a
 *      single `text` block (header + numbered content) so the model doesn't
 *      have to JSON.parse line numbers out of escaped strings.
 *
 * The `signal` field of `ReadFileDeps` is intentionally excluded from the
 * factory parameter — it always comes from the SDK at call time.
 */
export function createReadFileTool(deps: Omit<ReadFileDeps, "signal">) {
  return tool({
    description: READ_FILE_TOOL_DESCRIPTION,
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    execute: async (input, { abortSignal }) =>
      executeReadFile(input, {
        ...deps,
        ...(abortSignal ? { signal: abortSignal } : {}),
      }),
    toModelOutput: ({ output }) => toModelOutput(output),
  });
}

/**
 * Convert our internal `ReadFileOutput` into the SDK's `ToolResultOutput`.
 *
 * Default JSON serialisation (the path you get for free when you omit
 * `toModelOutput`) is wrong here for two reasons:
 *   - text content gets `\n` re-escaped and the model has to parse JSON to
 *     even look at line numbers
 *   - image content has no path to vision modalities
 *
 * Both branches now do the right thing explicitly.
 *
 * Exported for unit-test access; not part of the registered tool's public
 * surface but harmless to share.
 */
export function toModelOutput(output: ReadFileOutput) {
  if (output.kind === "text") {
    const flags: string[] = [];
    if (output.truncated) flags.push("more available");
    if (output.lineTruncated) flags.push("some lines truncated");
    const flagStr = flags.length > 0 ? `, ${flags.join(", ")}` : "";
    const header = `<file: ${output.path} [lines ${output.startLine}-${output.endLine} of ${output.totalLines}${flagStr}]>`;
    return { type: "text" as const, value: `${header}\n${output.content}` };
  }
  return {
    type: "content" as const,
    value: [
      {
        type: "text" as const,
        text: `<image: ${output.path} (${output.mediaType}, ${output.byteSize} bytes)>`,
      },
      {
        type: "file-data" as const,
        data: output.base64,
        mediaType: output.mediaType,
      },
    ],
  };
}
