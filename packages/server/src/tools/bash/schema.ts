import { z } from "zod";

export const BashInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe("The bash command to execute."),

  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory override. Relative paths are resolved against the project root; absolute paths are used as-is.",
    ),

  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .default(30_000)
    .describe("Max execution time in milliseconds before the process is sent SIGTERM. Defaults to 30 000."),
});

export type BashInput = z.infer<typeof BashInputSchema>;

export const BashOutputSchema = z.object({
  exitCode: z
    .number()
    .int()
    .describe("Process exit code; 0 means success."),
  stdout: z
    .string()
    .describe("Captured stdout (may be truncated if it exceeds the byte cap)."),
  stderr: z
    .string()
    .describe("Captured stderr (may be truncated if it exceeds the byte cap)."),
  truncated: z
    .boolean()
    .describe("True when combined output exceeded the byte cap and was trimmed."),
  killed: z
    .boolean()
    .describe("True when the process was killed due to timeout or abort signal."),
});

export type BashOutput = z.infer<typeof BashOutputSchema>;

export const BASH_TOOL_DESCRIPTION = `Execute a bash command in the user's workspace.

The command runs non-interactively (no stdin). Use for file operations, builds, tests, git, package managers, and other CLI tasks.

Defaults to a 30-second timeout. Long-running commands (builds, large installs) should pass a higher \`timeout\`. The process is killed with SIGTERM if the timeout expires.

Output (stdout + stderr combined) is capped; the result reports \`truncated: true\` when clipping occurs.`;
