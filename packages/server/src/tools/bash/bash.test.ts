import { describe, expect, it } from "vitest";
import { executeBash, BashError, MAX_OUTPUT_BYTES } from "./execute.js";
import type { BashRunner, BashRunnerOptions, BashRunnerResult } from "./execute.js";

function mockRunner(result: Partial<BashRunnerResult> = {}): BashRunner {
  return {
    async run() {
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
        killed: result.killed ?? false,
        truncated: result.truncated ?? false,
      };
    },
  };
}

function spyRunner(): { runner: BashRunner; calls: BashRunnerOptions[] } {
  const calls: BashRunnerOptions[] = [];
  const runner: BashRunner = {
    async run(opts) {
      calls.push(opts);
      return { stdout: "", stderr: "", exitCode: 0, killed: false, truncated: false };
    },
  };
  return { runner, calls };
}

describe("executeBash", () => {
  it("passes command and cwd to runner", async () => {
    const { runner, calls } = spyRunner();
    await executeBash(
      { command: "echo hi", timeout: 30_000 },
      { cwd: "/project", runner },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("echo hi");
    expect(calls[0]!.cwd).toBe("/project");
  });

  it("resolves relative cwd against deps.cwd", async () => {
    const { runner, calls } = spyRunner();
    await executeBash(
      { command: "ls", cwd: "sub/dir", timeout: 30_000 },
      { cwd: "/project", runner },
    );

    expect(calls[0]!.cwd).toBe("/project/sub/dir");
  });

  it("returns runner result fields", async () => {
    const runner = mockRunner({
      stdout: "hello\n",
      stderr: "warn\n",
      exitCode: 1,
      killed: false,
      truncated: true,
    });

    const result = await executeBash(
      { command: "test", timeout: 30_000 },
      { cwd: "/", runner },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.truncated).toBe(true);
    expect(result.killed).toBe(false);
  });

  it("rejects command when commandFilter returns false", async () => {
    const runner = mockRunner();
    await expect(
      executeBash(
        { command: "rm -rf /", timeout: 30_000 },
        { cwd: "/", runner, commandFilter: () => false },
      ),
    ).rejects.toThrow(BashError);
  });

  it("allows command when commandFilter returns true", async () => {
    const runner = mockRunner();
    const result = await executeBash(
      { command: "echo ok", timeout: 30_000 },
      { cwd: "/", runner, commandFilter: () => true },
    );
    expect(result.exitCode).toBe(0);
  });

  it("passes timeout to runner", async () => {
    const { runner, calls } = spyRunner();
    await executeBash(
      { command: "sleep 60", timeout: 60_000 },
      { cwd: "/", runner },
    );

    expect(calls[0]!.timeout).toBe(60_000);
  });

  it("passes maxOutputBytes to runner", async () => {
    const { runner, calls } = spyRunner();
    await executeBash(
      { command: "cat bigfile", timeout: 30_000 },
      { cwd: "/", runner },
    );

    expect(calls[0]!.maxOutputBytes).toBe(MAX_OUTPUT_BYTES);
  });

  it("strips sensitive env vars", async () => {
    const { runner, calls } = spyRunner();

    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      PATH: "/usr/bin",
      HOME: "/home/user",
      API_SECRET: "s3cr3t",
      AUTH_TOKEN: "tok",
      DB_PASSWORD: "pw",
      ENCRYPTION_KEY: "k",
      SECRET_ADMIN: "admin",
      TOKEN_XYZ: "xyz",
      NORMAL_VAR: "ok",
    };

    try {
      await executeBash(
        { command: "env", timeout: 30_000 },
        { cwd: "/", runner },
      );

      const env = calls[0]!.env;
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/home/user");
      expect(env.NORMAL_VAR).toBe("ok");
      expect(env.API_SECRET).toBeUndefined();
      expect(env.AUTH_TOKEN).toBeUndefined();
      expect(env.DB_PASSWORD).toBeUndefined();
      expect(env.ENCRYPTION_KEY).toBeUndefined();
      expect(env.SECRET_ADMIN).toBeUndefined();
      expect(env.TOKEN_XYZ).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });
});
