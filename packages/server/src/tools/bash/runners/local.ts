import { spawn as defaultSpawn } from "node:child_process";
import type { BashRunner, BashRunnerOptions } from "../execute.js";

/**
 * Local runner: spawns bash directly via `child_process.spawn`.
 *
 * This is the default (and currently only) runner. The `BashRunner` interface
 * exists so sandboxed runners (Docker, Firecracker, etc.) can be swapped in
 * later without changing `executeBash`.
 */
export function createLocalRunner(
  opts?: { spawn?: typeof defaultSpawn },
): BashRunner {
  const spawnFn = opts?.spawn ?? defaultSpawn;

  return {
    run(runOpts: BashRunnerOptions) {
      return new Promise((resolve, reject) => {
        const child = spawnFn("bash", ["-c", runOpts.command], {
          cwd: runOpts.cwd,
          env: runOpts.env,
          stdio: ["ignore", "pipe", "pipe"],
          signal: runOpts.signal,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;

        const maxBytes = runOpts.maxOutputBytes;

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutBytes < maxBytes) {
            const remaining = maxBytes - stdoutBytes;
            stdoutChunks.push(
              chunk.length <= remaining ? chunk : chunk.subarray(0, remaining),
            );
          } else {
            truncated = true;
          }
          stdoutBytes += chunk.length;
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrBytes < maxBytes) {
            const remaining = maxBytes - stderrBytes;
            stderrChunks.push(
              chunk.length <= remaining ? chunk : chunk.subarray(0, remaining),
            );
          } else {
            truncated = true;
          }
          stderrBytes += chunk.length;
        });

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let killedByTimeout = false;

        if (runOpts.timeout > 0) {
          timeoutId = setTimeout(() => {
            killedByTimeout = true;
            child.kill("SIGTERM");
          }, runOpts.timeout);
        }

        child.on("error", (err) => {
          if (timeoutId) clearTimeout(timeoutId);
          reject(err);
        });

        child.on("close", (code, signal) => {
          if (timeoutId) clearTimeout(timeoutId);

          if (stdoutBytes > maxBytes || stderrBytes > maxBytes) {
            truncated = true;
          }

          resolve({
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            exitCode: code ?? (signal ? 128 + signalCode(signal) : 1),
            killed: killedByTimeout || child.killed,
            truncated,
          });
        });
      });
    },
  };
}

function signalCode(signal: string): number {
  const codes: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGTERM: 15,
    SIGKILL: 9,
  };
  return codes[signal] ?? 1;
}
