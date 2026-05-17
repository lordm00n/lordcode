import { z } from "zod";

/**
 * Input schema for the `read_file` tool.
 *
 * Designed to be the LLM-facing surface: every field carries a `.describe()`
 * so the model can reason about when each option matters. Defaults are tuned
 * to mirror Claude Code / Cursor's Read tool (spec §3 decisions #4, #5, #6).
 *
 * Fields intentionally left out of the LLM-facing surface:
 *   - encoding (always UTF-8 for text)
 *   - explicit binary-mode escape hatch
 *   - negative offset / "tail -n" semantics
 *   - per-line truncation threshold
 *
 * They live in `execute.ts` as constants so the tool's error surface stays
 * small and the model has fewer ways to hold the tool wrong.
 */
export const ReadFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "File path to read. Relative paths are resolved against the workspace root; absolute paths are used as-is.",
    ),

  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "1-indexed start line. Defaults to 1. Use together with `limit` to page through large files.",
    ),

  limit: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .describe(
      "Maximum number of lines to return starting at `offset`. Defaults to 2000. Hard cap 10000.",
    ),
});

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

/**
 * Text branch of the output: a window of line-numbered content plus enough
 * metadata for the model to know where it is in the file and whether to page
 * for more.
 *
 * `content` is pre-formatted on the server: each returned line carries a
 * right-aligned 6-char line number followed by `|` and the line text. This
 * matches the inline-line-numbers convention the model already sees in user
 * messages (spec §3 decision #6) and saves the model from JSON.parse-ing
 * before it can reason about line numbers.
 */
const TextOutputSchema = z.object({
  kind: z.literal("text"),
  path: z.string().describe("Absolute path of the file that was read."),
  content: z
    .string()
    .describe(
      "Line-numbered content. Each line is prefixed with a right-aligned 6-char line number then `|`, then the line text. Trailing newline preserved.",
    ),
  startLine: z.number().int().positive(),
  endLine: z
    .number()
    .int()
    .nonnegative()
    .describe("Inclusive end line. Equals `startLine - 1` when the window is empty."),
  totalLines: z.number().int().nonnegative(),
  truncated: z
    .boolean()
    .describe("True when `endLine < totalLines`, i.e. more lines exist beyond the window."),
  lineTruncated: z
    .boolean()
    .describe("True when at least one returned line was clipped to MAX_LINE_CHARS."),
});

/**
 * Image branch of the output. The base64 payload is on the wire so the TUI
 * can size up the result, but the SDK-side `toModelOutput` (see `tool.ts`)
 * is what actually feeds the bytes into a vision model.
 */
const ImageOutputSchema = z.object({
  kind: z.literal("image"),
  path: z.string(),
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  byteSize: z.number().int().nonnegative(),
  base64: z
    .string()
    .describe("Raw base64-encoded image data, no `data:` prefix."),
});

/**
 * Discriminated union by `kind`. Mirrors ripgrep's `mode` discriminator: a
 * single tool can return categorically different shapes (text vs image, with
 * room for PDF / audio later) without splitting into N tools.
 */
export const ReadFileOutputSchema = z.discriminatedUnion("kind", [
  TextOutputSchema,
  ImageOutputSchema,
]);

export type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;
export type ReadFileTextOutput = z.infer<typeof TextOutputSchema>;
export type ReadFileImageOutput = z.infer<typeof ImageOutputSchema>;

/**
 * The description handed to the LLM. Kept module-level so it stays in sync
 * with the schema descriptions above and is easy to find from the spec.
 */
export const READ_FILE_TOOL_DESCRIPTION = `Read a file from disk. Returns text content with line numbers, or image content for PNG / JPEG / GIF / WEBP files.

Defaults read the first 2000 lines. For larger files, page through with \`offset\` and \`limit\` (e.g. offset: 2001, limit: 2000). The result reports \`totalLines\` and \`truncated: true\` when more lines exist beyond the window.

Binary files (other than supported images) and files larger than 10 MB are rejected. Single lines longer than 2000 characters are truncated; the result reports \`lineTruncated: true\` when that happens.`;
