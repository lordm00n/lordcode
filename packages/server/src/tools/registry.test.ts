import { describe, expect, it } from "vitest";
import { buildTools } from "./registry.js";
import type { Logger } from "@lordcode/logger";

describe("buildTools", () => {
  it("[UT-6] registers ripgrep, glob, read_file, and bash tools", () => {
    const tools = buildTools({ cwd: process.cwd() });
    expect(Object.keys(tools).sort()).toEqual(["bash", "glob", "read_file", "ripgrep"]);
  });

  it("[UT-6] gives each tool its own logger child", () => {
    const children: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child(name: string) {
        children.push(name);
        return this;
      },
      tee() {
        return this;
      },
      async close() {},
    } satisfies Logger;

    buildTools({ cwd: process.cwd(), logger });

    expect(children).toContain("ripgrep");
    expect(children).toContain("glob");
    expect(children).toContain("read_file");
    expect(children).toContain("bash");
  });
});
