import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rgPath } from "@vscode/ripgrep";
import { buildArgs, executeGlob, GlobError } from "./execute.js";
import { GlobInputSchema, type GlobInput } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, "../../../tests/fixtures/glob-corpus");

const baseInput = (over: Partial<GlobInput> = {}): GlobInput => ({
  pattern: "**/*.ts",
  exclude: [],
  includeHidden: false,
  headLimit: 100,
  ...over,
});

const run = (input: GlobInput, opts?: { rgPath?: string; signal?: AbortSignal }) =>
  executeGlob(input, {
    rgPath: opts?.rgPath ?? rgPath,
    cwd: FIXTURE_DIR,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });

describe("GlobInputSchema", () => {
  it("[UT-1] applies defaults for optional inputs", () => {
    expect(GlobInputSchema.parse({ pattern: "**/*.ts" })).toEqual({
      pattern: "**/*.ts",
      exclude: [],
      includeHidden: false,
      headLimit: 100,
    });
  });

  it("[UT-1] rejects empty pattern, huge headLimit, and too many excludes", () => {
    expect(() => GlobInputSchema.parse({ pattern: "" })).toThrow();
    expect(() =>
      GlobInputSchema.parse({ pattern: "**/*.ts", headLimit: 1001 }),
    ).toThrow();
    expect(() =>
      GlobInputSchema.parse({
        pattern: "**/*.ts",
        exclude: Array.from({ length: 21 }, (_, i) => `x-${i}`),
      }),
    ).toThrow();
  });
});

describe("buildArgs", () => {
  it("[UT-2] builds minimal rg --files args", () => {
    expect(buildArgs(baseInput())).toEqual([
      "--files",
      "--no-config",
      "-g",
      "**/*.ts",
    ]);
  });

  it("[UT-2] adds excludes, hidden flag, and trailing path", () => {
    expect(
      buildArgs(
        baseInput({
          path: "src",
          exclude: ["**/*.test.ts", "**/dist/**"],
          includeHidden: true,
        }),
      ),
    ).toEqual([
      "--files",
      "--no-config",
      "-g",
      "**/*.ts",
      "-g",
      "!**/*.test.ts",
      "-g",
      "!**/dist/**",
      "--hidden",
      "src",
    ]);
  });
});

describe("executeGlob", () => {
  it("[UT-4] returns matching files from the fixture corpus", async () => {
    const out = await run(baseInput());
    expect(out.truncated).toBe(false);
    expect(out.files).toContain("src/app.ts");
    expect(out.files).toContain("src/util.ts");
    expect(out.files).toContain("nested/deep.test.ts");
    expect(out.files).not.toContain("dist/generated.ts");
  });

  it("[UT-4] treats no matches as an empty result instead of an error", async () => {
    await expect(
      run(baseInput({ pattern: "definitely-no-match-xyz-*" })),
    ).resolves.toEqual({ files: [], truncated: false });
  });

  it("[UT-4] truncates results at headLimit", async () => {
    const out = await run(baseInput({ headLimit: 2 }));
    expect(out.files).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("[UT-4] excludes additional glob patterns", async () => {
    const out = await run(baseInput({ exclude: ["**/*.test.ts"] }));
    expect(out.files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect(out.files).toContain("src/app.ts");
  });

  it("[UT-4] only includes hidden files when includeHidden is true", async () => {
    const hiddenOff = await run(baseInput());
    expect(hiddenOff.files.some((f) => f.includes(".hidden"))).toBe(false);

    const hiddenOn = await run(baseInput({ includeHidden: true }));
    expect(hiddenOn.files).toContain(".hidden.ts");
    expect(hiddenOn.files).toContain(".hidden-dir/secret.ts");
  });

  it("[UT-4] wraps real rg failures as GlobError", async () => {
    let err: unknown = null;
    try {
      await run(baseInput({ pattern: "[" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GlobError);
    expect((err as GlobError).cause.exitCode).toBe(2);
  });

  it("[UT-4] spawn failure with a bogus rgPath throws GlobError", async () => {
    await expect(
      run(baseInput(), { rgPath: "/this/path/definitely/does/not/exist/rg" }),
    ).rejects.toBeInstanceOf(GlobError);
  });
});
