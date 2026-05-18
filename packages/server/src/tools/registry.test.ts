import { describe, expect, it } from "vitest";
import { buildTools } from "./registry.js";
import { createInMemoryFileReadTracker } from "./file-read-tracker.js";
import type { Logger } from "@lordcode/logger";

describe("buildTools", () => {
  it("[UT-10.1] registers ripgrep, glob, read_file, write_file, and bash tools", () => {
    const tools = buildTools({ cwd: process.cwd() });
    expect(Object.keys(tools).sort()).toEqual(["bash", "glob", "read_file", "ripgrep", "write_file"]);
  });

  it("[UT-10.2] gives each tool its own logger child", () => {
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
    expect(children).toContain("write_file");
    expect(children).toContain("bash");
  });

  it("[UT-10.3] creates a default tracker when none is provided", () => {
    const tools = buildTools({ cwd: process.cwd() });
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
  });

  it("[UT-10.4] accepts an externally provided tracker", () => {
    const tracker = createInMemoryFileReadTracker();
    const tools = buildTools({ cwd: process.cwd(), fileReadTracker: tracker });
    expect(tools.read_file).toBeDefined();
    expect(tools.write_file).toBeDefined();
  });
});
