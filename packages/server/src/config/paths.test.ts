import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureConfigDir,
  ensureLogsDir,
  getConfigPath,
  getDebugLogPath,
  getLogsDir,
  getSessionsLogDir,
  rotateIfHuge,
} from "./paths.js";

const mkTmp = async () => mkdtemp(join(tmpdir(), "lordcode-paths-"));

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env.LORDCODE_DEBUG_LOG;
});

describe("getConfigPath / ensureConfigDir", () => {
  // B2.1
  it("[B2.1] composes <home>/.lordcode/config.json", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    expect(getConfigPath(tmp)).toBe(join(tmp, ".lordcode", "config.json"));
  });

  // B2.2
  it("[B2.2] creates the config dir when it does not exist", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const dir = await ensureConfigDir(tmp);
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
  });

  // B2.3
  it("[B2.3] is idempotent when the dir already exists", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await ensureConfigDir(tmp);
    await expect(ensureConfigDir(tmp)).resolves.toBeTruthy();
  });
});

describe("logs paths", () => {
  it("getLogsDir composes <home>/.lordcode/logs", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    expect(getLogsDir(tmp)).toBe(join(tmp, ".lordcode", "logs"));
  });

  it("getSessionsLogDir composes <home>/.lordcode/logs/sessions", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    expect(getSessionsLogDir(tmp)).toBe(
      join(tmp, ".lordcode", "logs", "sessions"),
    );
  });

  it("getDebugLogPath defaults to <home>/.lordcode/logs/debug.log", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    expect(getDebugLogPath(tmp)).toBe(
      join(tmp, ".lordcode", "logs", "debug.log"),
    );
  });

  it("getDebugLogPath honors LORDCODE_DEBUG_LOG override", async () => {
    process.env.LORDCODE_DEBUG_LOG = "/tmp/custom-debug.log";
    expect(getDebugLogPath("/somewhere")).toBe("/tmp/custom-debug.log");
  });

  it("ensureLogsDir creates the dir and is idempotent", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const dir = await ensureLogsDir(tmp);
    expect((await stat(dir)).isDirectory()).toBe(true);
    await expect(ensureLogsDir(tmp)).resolves.toBe(dir);
  });
});

describe("rotateIfHuge", () => {
  it("is a no-op when the file does not exist", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const path = join(tmp, "ghost.log");
    await expect(rotateIfHuge(path, 10)).resolves.toBeUndefined();
    const entries = await readdir(tmp);
    expect(entries).toEqual([]);
  });

  it("leaves a small file alone", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const path = join(tmp, "small.log");
    await writeFile(path, "hi");
    await rotateIfHuge(path, 100);
    const entries = await readdir(tmp);
    expect(entries.sort()).toEqual(["small.log"]);
  });

  it("renames the file to <path>.old when it exceeds the threshold", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const path = join(tmp, "big.log");
    await writeFile(path, "x".repeat(1024));
    await rotateIfHuge(path, 100);
    const entries = await readdir(tmp);
    expect(entries.sort()).toEqual(["big.log.old"]);
  });

  it("overwrites a previous .old file", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const path = join(tmp, "rotate.log");
    await writeFile(`${path}.old`, "ancient");
    await writeFile(path, "x".repeat(1024));
    await rotateIfHuge(path, 100);
    const entries = await readdir(tmp);
    expect(entries.sort()).toEqual(["rotate.log.old"]);
    // (we don't assert on contents of the .old, only that the rename succeeded)
  });

  it("propagates non-ENOENT stat errors", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    // Create a directory and try to rotate it as if it were a file: rename
    // succeeds but stat works, so simulate a typical real failure mode by
    // pointing at a deliberately-impossible path under a regular file.
    const file = join(tmp, "regular");
    await writeFile(file, "x");
    const bogus = join(file, "nested.log"); // ENOTDIR
    await expect(rotateIfHuge(bogus, 1)).rejects.toBeTruthy();
  });
});

describe("ensureConfigDir / ensureLogsDir error paths", () => {
  it("throws if the target path exists but is a regular file", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    // Create a *file* where the dir should go.
    await mkdir(join(tmp, ".lordcode"), { recursive: true });
    const fakeLogs = join(tmp, ".lordcode", "logs");
    await writeFile(fakeLogs, "not a dir");
    await expect(ensureLogsDir(tmp)).rejects.toThrow(
      /not a directory/,
    );
  });
});
