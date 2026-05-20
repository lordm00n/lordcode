import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lordcode/logger";
import type { LogTransport } from "@lordcode/logger";
import { getSessionsLogDir } from "../config/paths.js";
import { SessionRuntime } from "./runtime.js";

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function mkTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lordcode-session-runtime-"));
  cleanups.push(dir);
  return dir;
}

describe("SessionRuntime per-session logging", () => {
  it("[SL-1] writes active session logs to both global and session files", async () => {
    const home = await mkTmp();
    const memory = memoryTransport();
    const root = createLogger({
      level: "debug",
      transports: [memory],
      channel: ["server"],
    });

    const runtime = await SessionRuntime.open({
      home,
      projectPath: "/tmp/project",
      model: "gpt-4o",
      logger: root,
    });
    try {
      runtime.log.info("turn started", { messages: 1 });
      await runtime.flushLog();

      const sessionLog = await readFile(
        join(getSessionsLogDir(home), `${runtime.activeId}.log`),
        "utf8",
      );

      expect(memory.lines.join("\n")).toContain("server:session:");
      expect(memory.lines.join("\n")).toContain("turn started");
      expect(sessionLog).toContain("server:session:");
      expect(sessionLog).toContain("turn started");
    } finally {
      await runtime.close();
      await root.close();
    }
  });

  it("[SL-2] switches the session log file when a new session becomes active", async () => {
    const home = await mkTmp();
    const root = createLogger({
      level: "debug",
      transports: [memoryTransport()],
      channel: ["server"],
    });
    const runtime = await SessionRuntime.open({
      home,
      projectPath: "/tmp/project",
      model: null,
      logger: root,
    });
    try {
      const firstId = runtime.activeId;
      runtime.log.info("first only");
      await runtime.createNew(null);
      const secondId = runtime.activeId;
      runtime.log.info("second only");
      await runtime.flushLog();

      const firstLog = await readFile(
        join(getSessionsLogDir(home), `${firstId}.log`),
        "utf8",
      );
      const secondLog = await readFile(
        join(getSessionsLogDir(home), `${secondId}.log`),
        "utf8",
      );

      expect(firstLog).toContain("first only");
      expect(firstLog).not.toContain("second only");
      expect(secondLog).toContain("second only");
    } finally {
      await runtime.close();
      await root.close();
    }
  });

  it("[SL-3] reattaches the log file for a restored active session", async () => {
    const home = await mkTmp();
    const root = createLogger({
      level: "debug",
      transports: [memoryTransport()],
      channel: ["server"],
    });
    const runtime = await SessionRuntime.open({
      home,
      projectPath: "/tmp/project",
      model: null,
      logger: root,
    });
    try {
      const firstId = runtime.activeId;
      await runtime.createNew(null);
      runtime.log.info("new session line");
      await runtime.activate(firstId);
      runtime.log.info("restored session line");
      await runtime.flushLog();

      const firstLog = await readFile(
        join(getSessionsLogDir(home), `${firstId}.log`),
        "utf8",
      );

      expect(firstLog).toContain("restored session line");
      expect(firstLog).not.toContain("new session line");
    } finally {
      await runtime.close();
      await root.close();
    }
  });
});

describe("SessionRuntime deletion", () => {
  it("[SD-1] deletes an inactive session and its log file", async () => {
    const home = await mkTmp();
    const root = createLogger({
      level: "debug",
      transports: [memoryTransport()],
      channel: ["server"],
    });
    const runtime = await SessionRuntime.open({
      home,
      projectPath: "/tmp/project",
      model: null,
      logger: root,
    });
    try {
      const firstId = runtime.activeId;
      runtime.log.info("first session line");
      await runtime.createNew(null);

      await runtime.deleteSession(firstId);

      await expect(runtime.store.loadSession(firstId)).rejects.toThrow(
        /session not found/,
      );
      await expect(
        readFile(join(getSessionsLogDir(home), `${firstId}.log`), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.close();
      await root.close();
    }
  });

  it("[SD-2] refuses to delete the active session", async () => {
    const home = await mkTmp();
    const root = createLogger({
      level: "debug",
      transports: [memoryTransport()],
      channel: ["server"],
    });
    const runtime = await SessionRuntime.open({
      home,
      projectPath: "/tmp/project",
      model: null,
      logger: root,
    });
    try {
      await expect(runtime.deleteSession(runtime.activeId)).rejects.toThrow(
        /cannot delete active session/,
      );
    } finally {
      await runtime.close();
      await root.close();
    }
  });
});

function memoryTransport(): LogTransport & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
    close() {},
  };
}
