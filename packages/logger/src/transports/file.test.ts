import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTransport } from "./file.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const mkTmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "lordcode-logger-"));
  cleanups.push(d);
  return d;
};

describe("fileTransport", () => {
  it("appends each write() to the target file", async () => {
    const tmp = await mkTmp();
    const path = join(tmp, "out.log");
    const t = fileTransport(path);
    t.write("first\n");
    t.write("second\n");
    await t.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("first\nsecond\n");
  });

  it("does not truncate an existing file (open in append mode)", async () => {
    const tmp = await mkTmp();
    const path = join(tmp, "out.log");
    const a = fileTransport(path);
    a.write("a\n");
    await a.close();
    const b = fileTransport(path);
    b.write("b\n");
    await b.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("a\nb\n");
  });

  it("close() resolves and is idempotent", async () => {
    const tmp = await mkTmp();
    const path = join(tmp, "out.log");
    const t = fileTransport(path);
    t.write("x\n");
    await t.close();
    await t.close();
    const text = await readFile(path, "utf8");
    expect(text).toBe("x\n");
  });
});
