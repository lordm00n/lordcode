import { spawn as defaultSpawn } from "node:child_process";
import type { Logger } from "@lordcode/logger";

export interface RunRgInput {
  rgPath: string;
  cwd: string;
  args: string[];
  logger?: Logger;
  signal?: AbortSignal;
  spawn?: typeof defaultSpawn;
}

export interface RunRgResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalName: NodeJS.Signals | null;
  elapsedMs: number;
}

export class RgProcessError extends Error {
  public override readonly cause: {
    exitCode?: number;
    stderr?: string;
    spawnError?: unknown;
    signalName?: NodeJS.Signals | null;
  };

  constructor(
    message: string,
    cause: {
      exitCode?: number;
      stderr?: string;
      spawnError?: unknown;
      signalName?: NodeJS.Signals | null;
    },
  ) {
    super(message);
    this.name = "RgProcessError";
    this.cause = cause;
  }
}

export async function runRg(input: RunRgInput): Promise<RunRgResult> {
  const spawn = input.spawn ?? defaultSpawn;
  const log = input.logger;

  if (input.signal?.aborted) {
    throw makeAbortError("aborted before spawn");
  }

  const startedAt = Date.now();
  log?.debug("rg spawn", { args: input.args, cwd: input.cwd });

  let child: ReturnType<typeof defaultSpawn>;
  try {
    child = spawn(input.rgPath, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    log?.error("rg spawn failed", err);
    throw new RgProcessError(`failed to spawn rg: ${errorMessage(err)}`, {
      spawnError: err,
    });
  }

  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    log?.debug("rg abort: sending SIGTERM");
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may have already exited.
    }
  };

  if (input.signal) {
    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const { exitCode, signalName, error } = await new Promise<{
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

  if (input.signal) input.signal.removeEventListener("abort", onAbort);

  const elapsedMs = Date.now() - startedAt;

  if (aborted) {
    log?.debug("rg aborted", { elapsedMs });
    throw makeAbortError("rg aborted by signal");
  }

  if (error != null) {
    log?.error("rg runtime error", error, { elapsedMs });
    throw new RgProcessError(`rg crashed: ${errorMessage(error)}`, {
      spawnError: error,
      stderr,
    });
  }

  return { stdout, stderr, exitCode, signalName, elapsedMs };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function makeAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = "AbortError";
  return err;
}
