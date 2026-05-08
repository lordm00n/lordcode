import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureConfigDir, getConfigPath } from "./paths.js";

const mkTmp = async () => mkdtemp(join(tmpdir(), "lordcode-paths-"));

describe("getConfigPath / ensureConfigDir", () => {
  // B2.1
  it("[B2.1] composes <home>/.lordcode/config.json", async () => {
    const tmp = await mkTmp();
    try {
      expect(getConfigPath(tmp)).toBe(join(tmp, ".lordcode", "config.json"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // B2.2
  it("[B2.2] creates the config dir when it does not exist", async () => {
    const tmp = await mkTmp();
    try {
      const dir = await ensureConfigDir(tmp);
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // B2.3
  it("[B2.3] is idempotent when the dir already exists", async () => {
    const tmp = await mkTmp();
    try {
      await ensureConfigDir(tmp);
      await expect(ensureConfigDir(tmp)).resolves.toBeTruthy();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
