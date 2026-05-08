import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, ModelNotFoundError } from "./store.js";

const mkTmp = async () => mkdtemp(join(tmpdir(), "lordcode-store-"));

const writeConfig = async (home: string, contents: string) => {
  await mkdir(join(home, ".lordcode"), { recursive: true });
  await writeFile(join(home, ".lordcode", "config.json"), contents, "utf8");
};

const readConfig = async (home: string): Promise<unknown> => {
  const raw = await readFile(join(home, ".lordcode", "config.json"), "utf8");
  return JSON.parse(raw);
};

const sampleConfig = {
  version: 1,
  currentModel: "gpt",
  models: [
    {
      name: "gpt",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-x",
    },
    {
      name: "claude",
      provider: "anthropic",
      model: "claude-haiku",
      apiKeyEnv: "STORE_TEST_ANTHROPIC_KEY",
    },
  ],
};

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env.STORE_TEST_ANTHROPIC_KEY;
});

describe("ConfigStore", () => {
  // B3.1
  it("[B3.1] writes a skeleton when the file is missing", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);

    const store = await ConfigStore.load({ home: tmp });
    expect(store.list()).toEqual([]);
    const onDisk = await readConfig(tmp);
    expect(onDisk).toEqual({ version: 1, models: [] });
  });

  // B3.2
  it("[B3.2] loads a legal config and exposes list/getCurrent", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });
    expect(store.getCurrentName()).toBe("gpt");
    expect(store.getCurrent()?.name).toBe("gpt");
    expect(store.list().map((m) => m.name)).toEqual(["gpt", "claude"]);
  });

  // B3.3
  it("[B3.3] falls back to models[0] when currentModel is unknown", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(
      tmp,
      JSON.stringify({ ...sampleConfig, currentModel: "phantom" }),
    );
    const store = await ConfigStore.load({ home: tmp });
    expect(store.getCurrentName()).toBe("gpt");
    const onDisk = (await readConfig(tmp)) as { currentModel?: string };
    expect(onDisk.currentModel).toBe("gpt");
  });

  // B3.4
  it("[B3.4] sets currentModel to null when models is empty", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(
      tmp,
      JSON.stringify({ version: 1, currentModel: "phantom", models: [] }),
    );
    const store = await ConfigStore.load({ home: tmp });
    expect(store.getCurrentName()).toBeNull();
    const onDisk = (await readConfig(tmp)) as { currentModel?: string };
    expect(onDisk.currentModel).toBeUndefined();
  });

  // B3.5
  it("[B3.5] does not rewrite the file when currentModel is already valid", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    const text = JSON.stringify(sampleConfig, null, 2);
    await writeConfig(tmp, text);
    const path = join(tmp, ".lordcode", "config.json");
    const before = (await readFile(path, "utf8"));

    await ConfigStore.load({ home: tmp });

    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  // B3.6
  it("[B3.6] throws when the file is malformed JSONC", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, "{ this is not json");
    await expect(ConfigStore.load({ home: tmp })).rejects.toThrow(/JSONC/);
  });

  // B3.7
  it("[B3.7] throws when zod validation fails", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify({ version: 1 })); // models missing
    await expect(ConfigStore.load({ home: tmp })).rejects.toThrow();
  });

  // B3.8
  it("[B3.8] list() never exposes apiKey", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });
    for (const summary of store.list()) {
      expect("apiKey" in summary).toBe(false);
    }
  });

  // B3.9
  it("[B3.9] apiKeySource = 'env' when env has a value", async () => {
    process.env.STORE_TEST_ANTHROPIC_KEY = "real-secret";
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });
    const claude = store.list().find((m) => m.name === "claude")!;
    expect(claude.apiKeySource).toBe("env");
    expect(claude.apiKeyEnv).toBe("STORE_TEST_ANTHROPIC_KEY");
  });

  // B3.10
  it("[B3.10] apiKeySource = 'missing' when env is unset", async () => {
    delete process.env.STORE_TEST_ANTHROPIC_KEY;
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });
    const claude = store.list().find((m) => m.name === "claude")!;
    expect(claude.apiKeySource).toBe("missing");
  });

  // B3.11
  it("[B3.11] apiKeySource = 'plain' for apiKey-only models", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });
    const gpt = store.list().find((m) => m.name === "gpt")!;
    expect(gpt.apiKeySource).toBe("plain");
  });

  // B3.12
  it("[B3.12] getCurrent() returns null when current is null", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(
      tmp,
      JSON.stringify({ version: 1, models: [] }),
    );
    const store = await ConfigStore.load({ home: tmp });
    expect(store.getCurrent()).toBeNull();
  });

  // B3.13
  it("[B3.13] setCurrent persists to disk and updates memory", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });

    await store.setCurrent("claude");
    expect(store.getCurrentName()).toBe("claude");

    const reloaded = await ConfigStore.load({ home: tmp });
    expect(reloaded.getCurrentName()).toBe("claude");
  });

  // B3.14
  it("[B3.14] setCurrent throws and leaves state untouched on unknown name", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });

    const before = (await readConfig(tmp)) as { currentModel: string };
    expect(before.currentModel).toBe("gpt");

    await expect(store.setCurrent("phantom")).rejects.toBeInstanceOf(
      ModelNotFoundError,
    );
    expect(store.getCurrentName()).toBe("gpt");
    const after = (await readConfig(tmp)) as { currentModel: string };
    expect(after.currentModel).toBe("gpt");
  });

  // B3.15
  it("[B3.15] never leaves a .tmp file behind, final file is valid JSON", async () => {
    const tmp = await mkTmp();
    cleanups.push(tmp);
    await writeConfig(tmp, JSON.stringify(sampleConfig));
    const store = await ConfigStore.load({ home: tmp });
    await store.setCurrent("claude");
    const dir = join(tmp, ".lordcode");
    const entries = await readdir(dir);
    expect(entries.find((f) => f.endsWith(".tmp"))).toBeUndefined();
    const final = await readConfig(tmp);
    expect((final as { currentModel: string }).currentModel).toBe("claude");
  });

  // sanity for vi import (avoid lint complaints)
  it("vi.fn import sanity", () => {
    expect(typeof vi.fn).toBe("function");
  });
});
