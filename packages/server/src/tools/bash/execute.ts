import { resolve } from "node:path";
import type { Logger } from "@lordcode/logger";
import type { BashInput, BashOutput } from "./schema.js";
import { createLocalRunner } from "./runners/local.js";

/** Maximum bytes collected per stream (stdout / stderr) before truncation. */
export const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB

/** Environment variable name patterns to strip before spawning. */
const SENSITIVE_PATTERNS = [
  /_SECRET$/,
  /_TOKEN$/,
  /_KEY$/,
  /_PASSWORD$/,
  /^SECRET_/,
  /^TOKEN_/,
];

/**
 * Abstraction over how a command actually runs.
 * Swap in a Docker/Firecracker/remote runner for sandboxing.
 */
export interface BashRunnerOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface BashRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
  truncated: boolean;
}

export interface BashRunner {
  run(opts: BashRunnerOptions): Promise<BashRunnerResult>;
}

export interface BashDeps {
  /** Working directory used to resolve relative `input.cwd`. */
  cwd: string;
  /** Channel-rooted logger. Convention: `…child("tool").child("bash")`. */
  logger?: Logger;
  /** Cancels the spawn; on abort the child is sent SIGTERM. */
  signal?: AbortSignal;
  /** Execution strategy. Defaults to local spawn. Swap for sandboxed runner later. */
  runner?: BashRunner;
  /** Optional filter — return false to reject a command. */
  commandFilter?: (cmd: string) => boolean;
}

export class BashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BashError";
  }
}

export async function executeBash(
  input: BashInput,
  deps: BashDeps,
): Promise<BashOutput> {
  const log = deps.logger;
  const startedAt = Date.now();

  if (deps.commandFilter && !deps.commandFilter(input.command)) {
    throw new BashError(`Command rejected by filter: ${input.command}`);
  }

  const resolvedCwd = input.cwd
    ? resolve(deps.cwd, input.cwd)
    : deps.cwd;

  const env = sanitizeEnv(process.env);
  const runner = deps.runner ?? createLocalRunner();

  const result = await runner.run({
    command: input.command,
    cwd: resolvedCwd,
    env,
    timeout: input.timeout,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    signal: deps.signal,
  });

  log?.debug("bash done", {
    command: input.command,
    cwd: resolvedCwd,
    exitCode: result.exitCode,
    killed: result.killed,
    truncated: result.truncated,
    stdoutLen: result.stdout.length,
    stderrLen: result.stderr.length,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    killed: result.killed,
  };
}

function sanitizeEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    if (SENSITIVE_PATTERNS.some((p) => p.test(key))) continue;
    result[key] = value;
  }
  return result;
}
