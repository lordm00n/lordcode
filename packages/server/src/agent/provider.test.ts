import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@lordcode/shared";
import { resolveLanguageModel } from "./provider.js";

describe("resolveLanguageModel", () => {
  // B5.1
  it("[B5.1] throws on an unsupported provider", () => {
    const cfg = {
      name: "x",
      provider: "google" as unknown as ModelConfig["provider"],
      model: "y",
    } as ModelConfig;
    expect(() => resolveLanguageModel(cfg, "key")).toThrow(/google/);
  });
});
