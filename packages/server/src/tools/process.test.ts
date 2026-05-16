import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runRg, RgProcessError } from "./process.js";
import type { spawn } from "node:child_process";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => boolean;
    killedWith?: NodeJS.Signals;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal?: NodeJS.Signals) => {
    child.killedWith = signal;
    setImmediate(() => child.emit("close", null, signal ?? "SIGTERM"));
    return true;
  };
  return child;
}

describe("runRg", () => {
  it("[UT-3] returns stdout, stderr, exit metadata from the rg process", async () => {
    const fakeSpawn = (() => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stdout.write("a.ts\n");
        child.stderr.write("note\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof spawn;

    const out = await runRg({
      rgPath: "/fake/rg",
      cwd: "/tmp",
      args: ["--files"],
      spawn: fakeSpawn,
    });

    expect(out.stdout).toBe("a.ts\n");
    expect(out.stderr).toBe("note\n");
    expect(out.exitCode).toBe(0);
    expect(out.signalName).toBeNull();
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("[UT-3] wraps spawn failures as RgProcessError", async () => {
    const fakeSpawn = (() => {
      throw new Error("missing rg");
    }) as unknown as typeof spawn;

    await expect(
      runRg({
        rgPath: "/fake/rg",
        cwd: "/tmp",
        args: ["--files"],
        spawn: fakeSpawn,
      }),
    ).rejects.toMatchObject({
      name: "RgProcessError",
      message: expect.stringMatching(/spawn/i),
    });
  });

  it("[UT-3] aborting before spawn throws AbortError and does not start rg", async () => {
    const ac = new AbortController();
    ac.abort();
    let spawnCount = 0;
    const fakeSpawn = (() => {
      spawnCount++;
      return makeFakeChild();
    }) as unknown as typeof spawn;

    await expect(
      runRg({
        rgPath: "/fake/rg",
        cwd: "/tmp",
        args: ["--files"],
        signal: ac.signal,
        spawn: fakeSpawn,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnCount).toBe(0);
  });

  it("[UT-3] aborting during a run kills rg and rejects with AbortError", async () => {
    const ac = new AbortController();
    let child: ReturnType<typeof makeFakeChild> | null = null;
    const fakeSpawn = (() => {
      child = makeFakeChild();
      return child;
    }) as unknown as typeof spawn;

    const promise = runRg({
      rgPath: "/fake/rg",
      cwd: "/tmp",
      args: ["--files"],
      signal: ac.signal,
      spawn: fakeSpawn,
    });
    ac.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(child?.killedWith).toBe("SIGTERM");
  });

  it("[UT-3] surfaces runtime child errors as RgProcessError", async () => {
    const fakeSpawn = (() => {
      const child = makeFakeChild();
      setImmediate(() => child.emit("error", new Error("boom")));
      return child;
    }) as unknown as typeof spawn;

    await expect(
      runRg({
        rgPath: "/fake/rg",
        cwd: "/tmp",
        args: ["--files"],
        spawn: fakeSpawn,
      }),
    ).rejects.toBeInstanceOf(RgProcessError);
  });
});
