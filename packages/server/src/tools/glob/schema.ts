import { z } from "zod";

export const GlobInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Glob pattern for file paths, e.g. '**/*.ts' or 'packages/server/**/*.test.ts'.",
    ),

  path: z
    .string()
    .optional()
    .describe(
      "Directory or file to list under. Relative to the workspace root. Defaults to the workspace root.",
    ),

  exclude: z
    .array(z.string().min(1))
    .max(20)
    .default([])
    .describe(
      "Additional glob patterns to exclude. Do not prefix with '!'; the tool maps each item to a negated ripgrep glob.",
    ),

  includeHidden: z
    .boolean()
    .default(false)
    .describe("Include hidden files and directories by passing rg --hidden."),

  headLimit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe("Maximum number of file paths to return. Default 100, hard cap 1000."),
});

export type GlobInput = z.infer<typeof GlobInputSchema>;

export const GlobOutputSchema = z.object({
  files: z.array(z.string()).describe("Matched file paths relative to cwd."),
  truncated: z
    .boolean()
    .describe("True when more matches existed beyond headLimit."),
});

export type GlobOutput = z.infer<typeof GlobOutputSchema>;

export const GLOB_TOOL_DESCRIPTION = `List files by glob pattern using ripgrep's file traversal. Use this when you need to discover files by path, extension, package, or test naming convention before reading or searching file contents.

Examples:
- pattern: "**/*.ts"
- pattern: "packages/server/**/*.test.ts"
- pattern: "**/*.{ts,tsx}", exclude: ["**/node_modules/**", "**/dist/**"]

This tool returns file paths only. Use ripgrep when you need to search inside files.`;
