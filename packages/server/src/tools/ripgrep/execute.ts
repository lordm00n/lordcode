import { spawn as defaultSpawn } from "node:child_process";
import type { Logger } from "@lordcode/logger";
import { RgProcessError, runRg } from "../process.js";
import { parseRipgrepJsonLines, type ParseOptions } from "./parse.js";
import type { RipgrepInput, RipgrepOutput } from "./schema.js";

/**
 * Dependencies for {@link executeRipgrep}. Mirrors the dependency-injection
 * style of the rest of the server package (see `agent/stream.ts`'s test seams):
 * everything callers might want to fake — the binary path, the cwd, the
 * abort signal, and even `child_process.spawn` itself — is parameterised.
 */
export interface RipgrepDeps {
  /** Absolute path to the ripgrep binary. Provide via `@vscode/ripgrep`'s `rgPath`. */
  rgPath: string;
  /** Working directory passed to the spawned `rg`. Typically `process.cwd()`. */
  cwd: string;
  /** Channel-rooted logger. Convention: `…child("tool").child("ripgrep")`. */
  logger?: Logger;
  /** Cancels the spawn; on abort the child is sent SIGTERM and `executeRipgrep` rejects with the standard AbortError. */
  signal?: AbortSignal;
  /** Test seam: substitute `child_process.spawn`. Defaults to the real one. */
  spawn?: typeof defaultSpawn;
}

/**
 * Thrown for *real* ripgrep failures (exit code ≥ 2, spawn error, missing
 * binary). NOT thrown for "no matches" — that's a normal empty result with
 * exit code 1.
 *
 * The original cause is attached so the SDK / logs can surface stderr or the
 * underlying spawn error without losing context.
 */
export class RipgrepError extends Error {
  /**
   * Structured details about the failure. We override `Error.cause` (rather
   * than introducing a sibling field) so it round-trips through JSON.stringify
   * the same way the standard property would, but with our richer payload.
   */
  public override readonly cause: {
    exitCode?: number;
    stderr?: string;
    spawnError?: unknown;
  };

  constructor(
    message: string,
    cause: { exitCode?: number; stderr?: string; spawnError?: unknown },
  ) {
    super(message);
    this.name = "RipgrepError";
    this.cause = cause;
  }
}

/**
 * Run `rg` on the user's behalf and return a structured, LLM-friendly result.
 *
 * Exit-code mapping (spec §3 decision #9, §9):
 *   - 0       → matches found        → return populated `RipgrepOutput`
 *   - 1       → no matches found     → return empty `RipgrepOutput` (NOT an error)
 *   - 2+      → real failure         → throw `RipgrepError`
 *   - signal  → killed by SIGTERM    → throw the standard AbortError, so the
 *               SDK does NOT emit a tool-result and the whole stream terminates
 *               cleanly (matches the rest of the agent's abort plumbing).
 */
export async function executeRipgrep(
  input: RipgrepInput,
  deps: RipgrepDeps,
): Promise<RipgrepOutput> {
  const log = deps.logger;

  const args = buildArgs(input);
  let result: Awaited<ReturnType<typeof runRg>>;
  try {
    result = await runRg({
      rgPath: deps.rgPath,
      cwd: deps.cwd,
      args,
      ...(log ? { logger: log } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    });
  } catch (err) {
    if (!(err instanceof RgProcessError)) throw err;
    throw new RipgrepError(
      `failed to spawn ripgrep: ${errorMessage(err.cause.spawnError ?? err)}`,
      { spawnError: err.cause.spawnError, stderr: err.cause.stderr },
    );
  }

  const { stdout, stderr, exitCode, signalName, elapsedMs } = result;

  // Non-zero exit codes other than 1 are real errors. SIGTERM-from-us was
  // already handled above; any other signal means the OS killed it.
  if (exitCode == null) {
    const trimmed = stderr.trim() || `terminated by signal ${signalName ?? "?"}`;
    log?.warn("rg exited via signal", { signalName, stderr, elapsedMs });
    throw new RipgrepError(`ripgrep terminated: ${trimmed}`, {
      stderr,
    });
  }
  if (exitCode >= 2) {
    const trimmed = stderr.trim() || `exit code ${exitCode}`;
    log?.warn("rg failed", { exitCode, stderr, elapsedMs });
    throw new RipgrepError(`rg failed (exit ${exitCode}): ${trimmed}`, {
      exitCode,
      stderr,
    });
  }

  const stdoutLines = stdoutLinesFrom(stdout);
  const parseOpts: ParseOptions = {
    outputMode: input.outputMode,
    headLimit: input.headLimit,
    ...(input.contextBefore != null ? { contextBefore: input.contextBefore } : {}),
    ...(input.contextAfter != null ? { contextAfter: input.contextAfter } : {}),
    ...(log ? { logger: log } : {}),
  };
  const out = parseRipgrepJsonLines(stdoutLines, parseOpts);
  log?.debug("rg done", {
    exitCode,
    elapsedMs,
    mode: out.mode,
    truncated: out.truncated,
  });
  return out;
}

/**
 * Translate {@link RipgrepInput} into ripgrep argv. Kept as a pure helper so
 * it's trivially testable and the integration test can lock down the shape.
 *
 * NOTE: We intentionally avoid `-l` and `-c`; both flags suppress JSON output
 * and force ripgrep into a plain-text mode (verified empirically against rg
 * 15.0.0). Instead we always ask for `--json` and fold matches ourselves in
 * `parse.ts`. See the comment at the top of `parse.ts` for the longer story.
 */
export function buildArgs(input: RipgrepInput): string[] {
  const args: string[] = ["--json", "--no-config"];

  if (input.caseInsensitive) args.push("-i");
  if (input.multiline) args.push("-U", "--multiline-dotall");
  if (input.glob) args.push("-g", input.glob);
  if (input.type) args.push("-t", input.type);

  // Context lines — only meaningful when we're surfacing match content.
  if (input.outputMode === "content") {
    if (input.contextBefore != null && input.contextBefore > 0) {
      args.push("-B", String(input.contextBefore));
    }
    if (input.contextAfter != null && input.contextAfter > 0) {
      args.push("-A", String(input.contextAfter));
    }
  }

  args.push(input.pattern);
  if (input.path) args.push(input.path);
  return args;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function stdoutLinesFrom(stdout: string): string[] {
  if (stdout.length === 0) return [];
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
