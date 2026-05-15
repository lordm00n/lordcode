import { z } from "zod";

/**
 * Input schema for the `ripgrep` tool.
 *
 * Designed to be the LLM-facing surface: every field carries a `.describe()` so
 * the model can reason about when each option matters. Defaults are tuned for
 * a code-search agent (see spec §3 decisions #10, #12).
 */
export const RipgrepInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Regex pattern in ripgrep syntax. For literal text, plain text still works (it is treated as a regex).",
    ),

  path: z
    .string()
    .optional()
    .describe(
      "File or directory to search in. Relative to the workspace root. Defaults to the workspace root when omitted.",
    ),

  glob: z
    .string()
    .optional()
    .describe(
      "Glob filter, e.g. '*.ts' or '!**/node_modules/**'. Supports negation with leading '!'.",
    ),

  type: z
    .string()
    .optional()
    .describe(
      "ripgrep file-type filter (e.g. 'js', 'py', 'rust'). Cheaper than glob for standard types. See `rg --type-list`.",
    ),

  outputMode: z
    .enum(["content", "files_with_matches", "count"])
    .default("content")
    .describe(
      "'content' returns matched lines (with optional context); 'files_with_matches' returns file paths only; 'count' returns per-file match counts.",
    ),

  caseInsensitive: z
    .boolean()
    .default(false)
    .describe("Case-insensitive search (rg -i)."),

  contextBefore: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe(
      "Lines of context before each match (rg -B). Only meaningful when outputMode='content'.",
    ),

  contextAfter: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe(
      "Lines of context after each match (rg -A). Only meaningful when outputMode='content'.",
    ),

  multiline: z
    .boolean()
    .default(false)
    .describe(
      "Enable multiline mode where '.' matches newlines (rg -U --multiline-dotall).",
    ),

  headLimit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe(
      "Cap result count. For outputMode='content': max matches. For other modes: max files. Default 100, hard cap 1000.",
    ),
});

export type RipgrepInput = z.infer<typeof RipgrepInputSchema>;

/**
 * One match row for `outputMode: "content"`. `line` is 1-indexed.
 * `text` is the full line as ripgrep saw it, with the trailing newline stripped.
 * `before` / `after` are populated only when contextBefore / contextAfter > 0.
 */
const ContentMatchSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  text: z.string(),
  before: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
});

export type RipgrepContentMatch = z.infer<typeof ContentMatchSchema>;

/**
 * Discriminated union by `mode`, mirroring `RipgrepInput.outputMode`.
 * `truncated` indicates that the result was capped at `headLimit` and there
 * may be more matches the model could discover by narrowing the query.
 */
export const RipgrepOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("content"),
    matches: z.array(ContentMatchSchema),
    truncated: z.boolean(),
  }),
  z.object({
    mode: z.literal("files_with_matches"),
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.object({
    mode: z.literal("count"),
    counts: z.array(
      z.object({ file: z.string(), count: z.number().int().nonnegative() }),
    ),
    truncated: z.boolean(),
  }),
]);

export type RipgrepOutput = z.infer<typeof RipgrepOutputSchema>;

/**
 * The description handed to the LLM. Kept module-level so it stays in sync
 * with the schema descriptions above and is easy to find from the spec.
 */
export const RIPGREP_TOOL_DESCRIPTION = `Search file contents using ripgrep. Use this when you need to find code by exact text, regex, or filter by file type / glob.

Output modes:
- "content" (default): return matched lines with optional surrounding context.
- "files_with_matches": return only the list of files containing matches.
- "count": return per-file match counts.

Prefer narrowing with \`type\` (e.g. "ts") or \`glob\` (e.g. "*.tsx") to avoid scanning irrelevant files. Use \`headLimit\` to control output size; results can be truncated, in which case \`truncated: true\` will be set.`;
