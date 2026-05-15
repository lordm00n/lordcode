import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import type { Logger } from "@lordcode/logger";
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
  const spawn = deps.spawn ?? defaultSpawn;

  if (deps.signal?.aborted) {
    throw makeAbortError("aborted before spawn");
  }

  const args = buildArgs(input);
  const startedAt = Date.now();
  log?.debug("rg spawn", { args, cwd: deps.cwd });

  let child: ChildProcess;
  try {
    child = spawn(deps.rgPath, args, {
      cwd: deps.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    log?.error("rg spawn failed", err);
    throw new RipgrepError(
      `failed to spawn ripgrep: ${errorMessage(err)}`,
      { spawnError: err },
    );
  }

  // Stream-buffer stdout into JSON Lines; collect stderr verbatim.
  const stdoutLines: string[] = [];
  let stdoutResidual = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutResidual += chunk;
    let nl = stdoutResidual.indexOf("\n");
    while (nl >= 0) {
      stdoutLines.push(stdoutResidual.slice(0, nl));
      stdoutResidual = stdoutResidual.slice(nl + 1);
      nl = stdoutResidual.indexOf("\n");
    }
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // Wire abortSignal → SIGTERM. We rely on the standard `close` event below
  // to translate the resulting non-zero exit into an AbortError.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    log?.debug("rg abort: sending SIGTERM");
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already be gone; nothing to recover.
    }
  };
  if (deps.signal) {
    if (deps.signal.aborted) {
      onAbort();
    } else {
      deps.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Resolve when the process closes (both stdio streams flushed AND exit
  // observed). We deliberately use `close`, not `exit`, so any straggler
  // stdout has been folded into stdoutLines.
  const { exitCode, signalName, error: spawnRuntimeError } = await new Promise<{
    exitCode: number | null;
    signalName: NodeJS.Signals | null;
    error: Error | null;
  }>((resolve) => {
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signalName: null, error: err });
    });
    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, signalName: sig, error: null });
    });
  });

  if (deps.signal) deps.signal.removeEventListener("abort", onAbort);

  // Flush any final residual stdout that didn't end with \n.
  if (stdoutResidual.length > 0) stdoutLines.push(stdoutResidual);

  const elapsedMs = Date.now() - startedAt;

  if (aborted) {
    log?.debug("rg aborted", { elapsedMs });
    throw makeAbortError("ripgrep aborted by signal");
  }

  if (spawnRuntimeError != null) {
    log?.error("rg runtime error", spawnRuntimeError, { elapsedMs });
    throw new RipgrepError(
      `ripgrep crashed: ${errorMessage(spawnRuntimeError)}`,
      { spawnError: spawnRuntimeError, stderr },
    );
  }

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

/**
 * Build a DOMException-style AbortError so callers (the SDK in particular)
 * recognise it and short-circuit the agent loop without surfacing a tool error.
 *
 * We avoid pulling in `node:dom-exception`; constructing an `Error` with
 * `name = "AbortError"` is what `node:fs/promises` and most of the standard
 * library do internally.
 */
function makeAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = "AbortError";
  return err;
}
