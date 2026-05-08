import { describe, expect, it } from "vitest";
import { ConfigParseError, parseConfig } from "./schema.js";

const baseModel = {
  name: "gpt",
  provider: "openai" as const,
  model: "gpt-4o-mini",
  apiKey: "sk-x",
};

describe("parseConfig", () => {
  // B1.1
  it("[B1.1] parses a legal JSON config", () => {
    const cfg = parseConfig(
      JSON.stringify({
        version: 1,
        currentModel: "gpt",
        models: [baseModel],
      }),
    );
    expect(cfg.version).toBe(1);
    expect(cfg.currentModel).toBe("gpt");
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0]?.name).toBe("gpt");
  });

  // B1.2
  it("[B1.2] accepts JSONC (line+block comments, trailing commas)", () => {
    const text = `{
      // schema version
      "version": 1,
      /* an inline block comment */
      "currentModel": "gpt",
      "models": [
        {
          "name": "gpt",
          "provider": "openai",
          "model": "gpt-4o-mini",
          "apiKey": "sk-x", // trailing comma below is intentional
        },
      ],
    }`;
    const cfg = parseConfig(text);
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0]?.name).toBe("gpt");
  });

  // B1.3
  it("[B1.3] rejects malformed JSONC", () => {
    expect(() => parseConfig("{ this is not json")).toThrow(ConfigParseError);
    expect(() => parseConfig("{ this is not json")).toThrow(/JSONC/);
  });

  // B1.4
  it("[B1.4a] rejects when version is missing", () => {
    expect(() =>
      parseConfig(JSON.stringify({ models: [baseModel] })),
    ).toThrow(ConfigParseError);
  });
  it("[B1.4b] rejects when version != 1", () => {
    expect(() =>
      parseConfig(JSON.stringify({ version: 2, models: [baseModel] })),
    ).toThrow(/version/);
  });

  // B1.5a
  it("[B1.5a] rejects when models is missing", () => {
    expect(() => parseConfig(JSON.stringify({ version: 1 }))).toThrow(
      ConfigParseError,
    );
  });

  // B1.5b
  it("[B1.5b] accepts an empty models array", () => {
    const cfg = parseConfig(JSON.stringify({ version: 1, models: [] }));
    expect(cfg.models).toEqual([]);
  });

  // B1.6
  it("[B1.6] rejects empty model name", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [{ ...baseModel, name: "" }],
        }),
      ),
    ).toThrow(/name/);
  });

  // B1.7
  it("[B1.7] rejects duplicate model names", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [baseModel, { ...baseModel, model: "gpt-4o" }],
        }),
      ),
    ).toThrow(/duplicate/);
  });

  // B1.8
  it("[B1.8] rejects unknown provider", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [{ ...baseModel, provider: "google" }],
        }),
      ),
    ).toThrow(ConfigParseError);
  });

  // B1.8b
  it("[B1.8b] accepts \"openai-compatible\" provider when baseURL is set", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [
            {
              name: "compat",
              provider: "openai-compatible",
              model: "big-pickle",
              baseURL: "https://opencode.ai/zen/v1",
              apiKey: "sk-x",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  // B1.8c
  it("[B1.8c] rejects \"openai-compatible\" provider without baseURL", () => {
    let captured: unknown;
    try {
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [
            {
              name: "compat",
              provider: "openai-compatible",
              model: "big-pickle",
              apiKey: "sk-x",
            },
          ],
        }),
      );
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConfigParseError);
    expect(String((captured as Error).message)).toMatch(/baseURL/);
  });

  // B1.9
  it("[B1.9] rejects empty model id", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [{ ...baseModel, model: "" }],
        }),
      ),
    ).toThrow(/model/);
  });

  // B1.10
  it("[B1.10] rejects when both apiKey and apiKeyEnv are missing", () => {
    const m = {
      name: "gpt",
      provider: "openai" as const,
      model: "gpt-4o-mini",
    };
    expect(() => parseConfig(JSON.stringify({ version: 1, models: [m] }))).toThrow(
      /apiKey/,
    );
  });

  // B1.11
  it("[B1.11] accepts apiKey only", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [
            { name: "x", provider: "openai", model: "gpt-4o-mini", apiKey: "sk" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  // B1.12
  it("[B1.12] accepts apiKeyEnv only", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [
            {
              name: "x",
              provider: "openai",
              model: "gpt-4o-mini",
              apiKeyEnv: "FOO",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  // B1.13
  it("[B1.13] accepts apiKey + apiKeyEnv together", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [
            {
              ...baseModel,
              apiKeyEnv: "FOO",
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  // B1.14
  it("[B1.14] accepts missing currentModel", () => {
    const cfg = parseConfig(
      JSON.stringify({ version: 1, models: [baseModel] }),
    );
    expect(cfg.currentModel).toBeUndefined();
  });

  // B1.15
  it("[B1.15] does NOT enforce currentModel ∈ models at the schema layer", () => {
    const cfg = parseConfig(
      JSON.stringify({
        version: 1,
        currentModel: "phantom",
        models: [baseModel],
      }),
    );
    expect(cfg.currentModel).toBe("phantom");
  });

  // B1.16
  it("[B1.16] rejects non-string baseURL", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [{ ...baseModel, baseURL: 42 }],
        }),
      ),
    ).toThrow(/baseURL/);
  });

  // B1.17
  it("[B1.17] error messages include field paths", () => {
    let captured: unknown;
    try {
      parseConfig(
        JSON.stringify({
          version: 1,
          models: [
            baseModel,
            {
              name: "two",
              provider: "google",
              model: "x",
              apiKey: "y",
            },
          ],
        }),
      );
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConfigParseError);
    expect(String((captured as Error).message)).toMatch(/models\.1\.provider/);
  });
});
