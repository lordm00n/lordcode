import type { Logger } from "@lordcode/logger";
import { rgPath } from "@vscode/ripgrep";
import { createBashTool } from "./bash/tool.js";
import {
  createInMemoryFileReadTracker,
  type FileReadTracker,
} from "./file-read-tracker.js";
import { createGlobTool } from "./glob/tool.js";
import { createReadFileTool } from "./read-file/tool.js";
import { createRipgrepTool } from "./ripgrep/tool.js";
import { createWriteFileTool } from "./write-file/tool.js";

/**
 * Dependencies any tool may need from the surrounding agent turn.
 * Caller convention (see `agent/stream.ts`): pass `logger.child("tool")` so
 * each individual tool ends up on its own channel like `server:tool:ripgrep`.
 */
export interface ToolDeps {
  logger?: Logger;
  cwd: string;
  fileReadTracker?: FileReadTracker;
}

/**
 * Build the per-turn tool set handed to `streamText`.
 *
 * Tools live under `tools/<name>/` and register here. Nothing in the agent
 * stream needs to change for new tools; the wire format is open at `unknown`.
 */
export function buildTools(deps: ToolDeps) {
  const tracker = deps.fileReadTracker ?? createInMemoryFileReadTracker();
  return {
    ripgrep: createRipgrepTool({
      rgPath,
      cwd: deps.cwd,
      ...(deps.logger ? { logger: deps.logger.child("ripgrep") } : {}),
    }),
    glob: createGlobTool({
      rgPath,
      cwd: deps.cwd,
      ...(deps.logger ? { logger: deps.logger.child("glob") } : {}),
    }),
    read_file: createReadFileTool({
      cwd: deps.cwd,
      fileReadTracker: tracker,
      ...(deps.logger ? { logger: deps.logger.child("read_file") } : {}),
    }),
    write_file: createWriteFileTool({
      cwd: deps.cwd,
      fileReadTracker: tracker,
      ...(deps.logger ? { logger: deps.logger.child("write_file") } : {}),
    }),
    bash: createBashTool({
      cwd: deps.cwd,
      ...(deps.logger ? { logger: deps.logger.child("bash") } : {}),
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
