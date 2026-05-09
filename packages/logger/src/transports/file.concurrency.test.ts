import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTransport } from "./file.js";
import { createLogger } from "../logger.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const mkTmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "lordcode-logger-conc-"));
  cleanups.push(d);
  return d;
};

/**
 * Spec §12.2 + acceptance: when two writers share a file in `O_APPEND`
 * mode, single `write(2)` calls ≤ PIPE_BUF (Linux 4096 / macOS 512) are
 * atomic w.r.t. each other. Every emitted line must therefore round-trip
 * intact — no interleaved chars, no half-lines.
 *
 * We approximate the worker scenario by opening two `fileTransport`s on the
 * same path (each is its own `WriteStream` → its own FD → its own
 * `write(2)`s) and racing many short writes through them. We then assert
 * every non-empty line parses against the spec §6.2 line shape.
 */
describe("fileTransport — concurrent appenders", () => {
  it("two transports writing short lines to the same file never tear", async () => {
    const tmp = await mkTmp();
    const path = join(tmp, "shared.log");

    // Hold the *root* references so we can `close()` them at the end —
    // children (`.child(...)`) own no transport and would no-op (spec §7.3).
    const rootA = createLogger({
      level: "debug",
      transports: [fileTransport(path)],
    });
    const rootB = createLogger({
      level: "debug",
      transports: [fileTransport(path)],
    });
    const logA = rootA.child("A");
    const logB = rootB.child("B");

    const N = 500;

    const work = (l: typeof logA, prefix: string) =>
      Promise.all(
        Array.from({ length: N }, (_, i) => {
          // Each line stays well under 200B, comfortably inside the macOS
          // 512B PIPE_BUF threshold.
          l.info(`${prefix}-${i}`, { idx: i, tag: "x".repeat(8) });
          return Promise.resolve();
        }),
      );

    await Promise.all([work(logA, "A"), work(logB, "B")]);
    await rootA.close();
    await rootB.close();

    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);

    // Each side wrote N lines.
    expect(lines).toHaveLength(N * 2);

    // Every line must match the spec §6.2 shape.
    const LINE_RE =
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] info  \[[AB]\] [AB]-\d+ idx=\d+ tag=xxxxxxxx$/;
    const bad = lines.filter((l) => !LINE_RE.test(l));
    expect(bad, bad.slice(0, 3).join("\n")).toEqual([]);
  });
});
