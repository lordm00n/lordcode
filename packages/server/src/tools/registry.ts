import type { Logger } from "@lordcode/logger";
import { rgPath } from "@vscode/ripgrep";
import { createRipgrepTool } from "./ripgrep/tool.js";

/**
 * Dependencies any tool may need from the surrounding agent turn.
 * Caller convention (see `agent/stream.ts`): pass `logger.child("tool")` so
 * each individual tool ends up on its own channel like `server:tool:ripgrep`.
 */
export interface ToolDeps {
  logger?: Logger;
  cwd: string;
}

/**
 * Build the per-turn tool set handed to `streamText`.
 *
 * First wave is just `ripgrep`. Adding a second tool means: (a) implement it
 * under `tools/<name>/`, (b) register it here. Nothing in the agent stream or
 * TUI needs to change for new tools; the wire format is open at `unknown`.
 */
export function buildTools(deps: ToolDeps) {
  return {
    ripgrep: createRipgrepTool({
      rgPath,
      cwd: deps.cwd,
      ...(deps.logger ? { logger: deps.logger.child("ripgrep") } : {}),
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
