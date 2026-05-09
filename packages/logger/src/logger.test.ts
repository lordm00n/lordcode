import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import type { LogTransport } from "./types.js";

interface RecordedTransport extends LogTransport {
  lines: string[];
  closed: number;
}

const makeTransport = (): RecordedTransport => {
  const lines: string[] = [];
  let closed = 0;
  return {
    lines,
    get closed() {
      return closed;
    },
    write(line) {
      lines.push(line);
    },
    close() {
      closed += 1;
    },
  } as RecordedTransport;
};

describe("createLogger — level filtering", () => {
  it("`silent` mutes every method", () => {
    const t = makeTransport();
    const log = createLogger({ level: "silent", transports: [t] });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(t.lines).toEqual([]);
  });

  it("`info` emits info/warn/error but suppresses debug", () => {
    const t = makeTransport();
    const log = createLogger({ level: "info", transports: [t] });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(t.lines.map((l) => l.match(/\] (\S+)/)?.[1])).toEqual([
      "info",
      "warn",
      "error",
    ]);
  });

  it("`debug` emits everything", () => {
    const t = makeTransport();
    const log = createLogger({ level: "debug", transports: [t] });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(t.lines).toHaveLength(4);
  });
});

describe("createLogger — channel via child()", () => {
  it("appends channel segments and shares parent transports", () => {
    const t = makeTransport();
    const root = createLogger({ level: "debug", transports: [t] });
    const a = root.child("server");
    const b = a.child("agent").child("stream");
    b.info("hello");
    expect(t.lines.at(-1)).toContain("[server:agent:stream]");
  });

  it("root with empty channel emits no `[]`", () => {
    const t = makeTransport();
    const root = createLogger({ level: "info", transports: [t] });
    root.info("ping");
    expect(t.lines[0]).not.toContain("[]");
  });
});

describe("createLogger — tee()", () => {
  it("fan-outs subsequent writes to parent transports + the new one", () => {
    const a = makeTransport();
    const b = makeTransport();
    const root = createLogger({ level: "info", transports: [a] });
    const tee = root.tee(b);
    tee.info("x");
    expect(a.lines).toHaveLength(1);
    expect(b.lines).toHaveLength(1);
  });

  it("does not retroactively send root writes to the tee'd transport", () => {
    const a = makeTransport();
    const b = makeTransport();
    const root = createLogger({ level: "info", transports: [a] });
    root.tee(b); // not used
    root.info("from root only");
    expect(a.lines).toHaveLength(1);
    expect(b.lines).toHaveLength(0);
  });

  it("close() on the tee'd logger only closes the new transport", async () => {
    const a = makeTransport();
    const b = makeTransport();
    const root = createLogger({ level: "info", transports: [a] });
    const tee = root.tee(b);
    await tee.close();
    expect(b.closed).toBe(1);
    expect(a.closed).toBe(0);
    // The shared transport must remain usable after the tee is closed.
    root.info("still alive");
    expect(a.lines).toHaveLength(1);
  });

  it("close() on the root closes every transport it was built with", async () => {
    const a = makeTransport();
    const b = makeTransport();
    const root = createLogger({ level: "info", transports: [a, b] });
    await root.close();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
  });

  it("close() on a child() logger is a no-op (child owns no transport)", async () => {
    const a = makeTransport();
    const root = createLogger({ level: "info", transports: [a] });
    const child = root.child("c");
    await child.close();
    expect(a.closed).toBe(0);
  });

  it("close() is idempotent", async () => {
    const a = makeTransport();
    const root = createLogger({ level: "info", transports: [a] });
    await root.close();
    await root.close();
    expect(a.closed).toBe(1);
  });
});

describe("createLogger — meta + error handling", () => {
  it("attaches `err=...` for error()", () => {
    const t = makeTransport();
    const log = createLogger({ level: "info", transports: [t] }).child("c");
    log.error("failed", new Error("nope"));
    expect(t.lines[0]).toContain('err="nope"');
  });

  it("preserves additional meta passed alongside err", () => {
    const t = makeTransport();
    const log = createLogger({ level: "info", transports: [t] }).child("c");
    log.error("failed", new Error("nope"), { route: "/agent/chat" });
    const head = t.lines[0]!.split("\n")[0]!;
    // `/agent/chat` has no whitespace / `=` / quotes / backslash, so it is
    // emitted unquoted per spec §6.2.
    expect(head).toContain("route=/agent/chat");
    // `err` is always quoted regardless of message contents (spec example
    // pattern `err="<message>"`).
    expect(head).toContain('err="nope"');
  });

  it("surfaces transport errors via console.error but keeps other transports working", () => {
    const ok = makeTransport();
    const bad: LogTransport = {
      write() {
        throw new Error("disk full");
      },
      close() {},
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger({ level: "info", transports: [bad, ok] });
    log.info("hi");
    expect(ok.lines).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
