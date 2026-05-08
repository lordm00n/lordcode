import { afterEach, describe, expect, it } from "vitest";
import type { ModelConfig } from "@lordcode/shared";
import { resolveApiKey } from "./apiKey.js";

const ENV_NAME = "API_KEY_RESOLVE_TEST";

afterEach(() => {
  delete process.env[ENV_NAME];
});

const cfg = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  name: "x",
  provider: "openai",
  model: "gpt-4o-mini",
  ...over,
});

describe("resolveApiKey", () => {
  // B4.1
  it("[B4.1] returns plain apiKey when only that is set", () => {
    expect(resolveApiKey(cfg({ apiKey: "X" }))).toBe("X");
  });

  // B4.2
  it("[B4.2] reads from env when only apiKeyEnv is set and env has a value", () => {
    process.env[ENV_NAME] = "Y";
    expect(resolveApiKey(cfg({ apiKeyEnv: ENV_NAME }))).toBe("Y");
  });

  // B4.3
  it("[B4.3] returns null when only apiKeyEnv is set and env is unset", () => {
    expect(resolveApiKey(cfg({ apiKeyEnv: ENV_NAME }))).toBeNull();
  });

  // B4.4
  it("[B4.4] env wins when both apiKey and apiKeyEnv are present and env has a value", () => {
    process.env[ENV_NAME] = "Y";
    expect(resolveApiKey(cfg({ apiKey: "X", apiKeyEnv: ENV_NAME }))).toBe("Y");
  });

  // B4.5
  it("[B4.5] falls back to apiKey when env has no value", () => {
    expect(resolveApiKey(cfg({ apiKey: "X", apiKeyEnv: ENV_NAME }))).toBe("X");
  });

  // B4.6
  it("[B4.6] empty-string env is treated as missing", () => {
    process.env[ENV_NAME] = "";
    expect(resolveApiKey(cfg({ apiKeyEnv: ENV_NAME }))).toBeNull();
    expect(resolveApiKey(cfg({ apiKey: "X", apiKeyEnv: ENV_NAME }))).toBe("X");
  });

  // B4.7
  it("[B4.7] returns null when neither field is set", () => {
    expect(resolveApiKey(cfg())).toBeNull();
  });
});
