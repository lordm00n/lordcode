import { spawn as defaultSpawn } from "node:child_process";
import type { Logger } from "@lordcode/logger";
import { RgProcessError, runRg } from "../process.js";
import type { GlobInput, GlobOutput } from "./schema.js";

export interface GlobDeps {
  rgPath: string;
  cwd: string;
  logger?: Logger;
  signal?: AbortSignal;
  spawn?: typeof defaultSpawn;
}

export class GlobError extends Error {
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
    this.name = "GlobError";
    this.cause = cause;
  }
}

export async function executeGlob(
  input: GlobInput,
  deps: GlobDeps,
): Promise<GlobOutput> {
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
    throw new GlobError(`failed to spawn glob search: ${errorMessage(err)}`, {
      spawnError: err.cause.spawnError,
      stderr: err.cause.stderr,
    });
  }

  const { stdout, stderr, exitCode, signalName, elapsedMs } = result;

  if (exitCode == null) {
    const trimmed = stderr.trim() || `terminated by signal ${signalName ?? "?"}`;
    log?.warn("glob exited via signal", { signalName, stderr, elapsedMs });
    throw new GlobError(`glob terminated: ${trimmed}`, { stderr });
  }

  if (exitCode >= 2) {
    const trimmed = stderr.trim() || `exit code ${exitCode}`;
    log?.warn("glob failed", { exitCode, stderr, elapsedMs });
    throw new GlobError(`glob failed (exit ${exitCode}): ${trimmed}`, {
      exitCode,
      stderr,
    });
  }

  if (exitCode === 1) {
    log?.debug("glob done", { exitCode, elapsedMs, files: 0, truncated: false });
    return { files: [], truncated: false };
  }

  const files = stdoutLinesFrom(stdout).filter(
    (file) => input.includeHidden || !hasHiddenSegment(file),
  );
  const truncated = files.length > input.headLimit;
  const out = {
    files: files.slice(0, input.headLimit),
    truncated,
  };
  log?.debug("glob done", {
    exitCode,
    elapsedMs,
    files: out.files.length,
    truncated,
  });
  return out;
}

export function buildArgs(input: GlobInput): string[] {
  const args: string[] = ["--files", "--no-config", "-g", input.pattern];

  for (const pattern of input.exclude) {
    args.push("-g", pattern.startsWith("!") ? pattern : `!${pattern}`);
  }

  if (input.includeHidden) args.push("--hidden");
  if (input.path) args.push(input.path);
  return args;
}

function stdoutLinesFrom(stdout: string): string[] {
  if (stdout.length === 0) return [];
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.filter((line) => line.length > 0);
}

function hasHiddenSegment(file: string): boolean {
  return file.split(/[\\/]+/).some((part) => part.startsWith("."));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
