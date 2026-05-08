import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  LordcodeConfig,
  ModelConfig,
  ModelSummary,
  ModelsListResponse,
} from "@lordcode/shared";
import { parseConfig } from "./schema.js";
import { ensureConfigDir, getConfigPath } from "./paths.js";

const SKELETON: LordcodeConfig = { version: 1, models: [] };

/**
 * Single source of truth for the model config in memory.
 *
 * Lifecycle:
 * 1. `ConfigStore.load()` is called once at server boot. It:
 *    - ensures `~/.lordcode/` exists
 *    - reads + parses + validates the file (writes a skeleton if missing)
 *    - normalises `currentModel` (fallback to `models[0]?.name ?? null`)
 *    - persists the normalised config back if it changed
 * 2. Subsequent `setCurrent(name)` calls update memory and atomically write
 *    the file (`config.json.tmp` → `rename`).
 *
 * The store does NOT watch the file. Hot-reload is explicitly out of scope.
 */
export class ConfigStore {
  private constructor(
    private state: { config: LordcodeConfig; current: string | null },
    private readonly filePath: string,
  ) {}

  static async load(opts: { home?: string } = {}): Promise<ConfigStore> {
    const filePath = getConfigPath(opts.home);
    await ensureConfigDir(opts.home);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await atomicWriteJson(filePath, SKELETON);
        const store = new ConfigStore(
          { config: structuredClone(SKELETON), current: null },
          filePath,
        );
        return store;
      }
      throw err;
    }

    const parsed = parseConfig(raw);
    const { normalised, changed } = normaliseCurrent(parsed);
    if (changed) {
      await atomicWriteJson(filePath, normalised);
    }
    return new ConfigStore(
      { config: normalised, current: normalised.currentModel ?? null },
      filePath,
    );
  }

  list(): ModelSummary[] {
    return this.state.config.models.map((m) => toSummary(m));
  }

  toListResponse(): ModelsListResponse {
    return { models: this.list(), current: this.state.current };
  }

  /** Returns the current ModelConfig (with apiKey) — server-internal use only. */
  getCurrent(): ModelConfig | null {
    if (!this.state.current) return null;
    return (
      this.state.config.models.find((m) => m.name === this.state.current) ??
      null
    );
  }

  getCurrentName(): string | null {
    return this.state.current;
  }

  /** Returns all configured names (used for nice error messages). */
  availableNames(): string[] {
    return this.state.config.models.map((m) => m.name);
  }

  async setCurrent(name: string): Promise<ModelConfig> {
    const found = this.state.config.models.find((m) => m.name === name);
    if (!found) {
      throw new ModelNotFoundError(name, this.availableNames());
    }
    const next: LordcodeConfig = {
      ...this.state.config,
      currentModel: name,
    };
    await atomicWriteJson(this.filePath, next);
    this.state = { config: next, current: name };
    return found;
  }
}

export class ModelNotFoundError extends Error {
  override readonly name = "ModelNotFoundError";
  constructor(
    public readonly modelName: string,
    public readonly available: string[],
  ) {
    super(
      `no such model: ${modelName} (available: ${
        available.length > 0 ? available.join(", ") : "<none>"
      })`,
    );
  }
}

function toSummary(m: ModelConfig): ModelSummary {
  let apiKeySource: ModelSummary["apiKeySource"];
  if (m.apiKeyEnv) {
    const v = process.env[m.apiKeyEnv];
    apiKeySource = v && v.length > 0 ? "env" : "missing";
  } else if (m.apiKey) {
    apiKeySource = "plain";
  } else {
    apiKeySource = "missing";
  }
  const summary: ModelSummary = {
    name: m.name,
    provider: m.provider,
    model: m.model,
    apiKeySource,
  };
  if (m.baseURL) summary.baseURL = m.baseURL;
  if (m.apiKeyEnv) summary.apiKeyEnv = m.apiKeyEnv;
  return summary;
}

function normaliseCurrent(cfg: LordcodeConfig): {
  normalised: LordcodeConfig;
  changed: boolean;
} {
  const validNames = new Set(cfg.models.map((m) => m.name));

  if (cfg.currentModel && validNames.has(cfg.currentModel)) {
    return { normalised: cfg, changed: false };
  }

  const fallback = cfg.models[0]?.name;
  if (fallback) {
    return {
      normalised: { ...cfg, currentModel: fallback },
      changed: cfg.currentModel !== fallback,
    };
  }

  if (cfg.currentModel == null) {
    return { normalised: cfg, changed: false };
  }

  const next: LordcodeConfig = { ...cfg };
  delete next.currentModel;
  return { normalised: next, changed: true };
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.tmp`;
  const json = JSON.stringify(data, null, 2) + "\n";
  try {
    await writeFile(tmp, json, "utf8");
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup; rename may have already consumed it.
    }
    void dir;
    throw err;
  }
}
