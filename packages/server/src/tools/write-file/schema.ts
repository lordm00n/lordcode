import { z } from "zod";

export const WriteFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Target file path. Relative paths are resolved against the workspace root; absolute paths are used as-is.",
    ),

  content: z
    .string()
    .describe(
      "Complete file content (UTF-8 text). This is a whole-file replace, not a patch.",
    ),

  mode: z
    .enum(["overwrite", "create"])
    .default("overwrite")
    .describe(
      '`"overwrite"` (default) creates or replaces the file. `"create"` fails with EEXIST if the file already exists.',
    ),

  createDirs: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), parent directories are created automatically (mkdir -p).",
    ),
});

export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;

export const WriteFileOutputSchema = z.object({
  path: z.string().describe("Absolute path of the file that was written."),
  bytesWritten: z.number().int().nonnegative().describe("Bytes written to disk."),
  created: z
    .boolean()
    .describe("True when the file was newly created; false when an existing file was overwritten."),
  previousBytes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Byte size of the previous file when overwriting; null when creating a new file."),
});

export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>;

export const WRITE_FILE_TOOL_DESCRIPTION = `Write content to a file. Creates new files or overwrites existing ones (whole-file replace).

For existing files: you MUST read_file first in this session. The tool verifies the file has not been modified since your last read — if it has, you'll get a STALE_READ error and must re-read before retrying.

For new files: no prior read is required. Parent directories are created automatically by default.

Content is the complete file — this is NOT a patch/diff tool. For small edits to existing files.

Content is capped at 1 MB. Encoding is always UTF-8.`;
