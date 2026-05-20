import type { LogLevel } from "./types.js";

/**
 * Render the meta object into a sequence of `key=value` tokens, suitable for
 * appending to a log line. The encoding rules match spec §6.2:
 *
 * - Strings, numbers, booleans, null, undefined render naturally.
 * - Anything else is JSON-stringified.
 * - If the resulting value contains a space, `=`, `"`, or `\`, the whole value
 *   is wrapped in double quotes with backslash-escapes (so `grep` for
 *   `key=...` still works).
 * - On serialization failure (circular refs, etc.) we fall back to
 *   `<unserializable>` rather than throwing — logging must never crash.
 */
function encodeMetaValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  let raw: string;
  switch (typeof v) {
    case "string":
      raw = v;
      break;
    case "number":
    case "boolean":
    case "bigint":
      raw = String(v);
      break;
    default: {
      try {
        raw = JSON.stringify(v) ?? "<unserializable>";
      } catch {
        raw = "<unserializable>";
      }
    }
  }
  if (/[\s="\\]/.test(raw)) {
    return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return raw;
}

/**
 * Force-quote the `err=` value: spec §6.2 examples always render it as
 * `err="<message>"` regardless of whether the message contains spaces. The
 * extra quotes also make stack-trace continuation lines easier to spot when
 * grepping by error message.
 */
function encodeErrValue(v: unknown): string {
  const raw = v == null ? String(v) : String(v);
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function encodeMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    const encoded = k === "err" ? encodeErrValue(v) : encodeMetaValue(v);
    parts.push(`${k}=${encoded}`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

const LEVEL_LABEL: Record<LogLevel | "warn" | "error", string> = {
  silent: "silent",
  // 5-char wide: "debug", "info ", "warn ", "error" (per spec §6.2)
  debug: "debug",
  info: "info ",
  warn: "warn ",
  error: "error",
};

export type FormatLevel = "debug" | "info" | "warn" | "error";

const UTC_PLUS_8_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatUtcPlus8Timestamp(date: Date): string {
  return new Date(date.getTime() + UTC_PLUS_8_OFFSET_MS)
    .toISOString()
    .replace("Z", "+08:00");
}

/**
 * Format a single log line. Output never contains a trailing newline; the
 * transport adds it (so transports can choose their own line terminators if
 * needed in the future).
 *
 * Per spec §6.2:
 *   `[<iso>] <level> [<channel>] <message> [<key>=<value> ...]`
 *
 * - `<message>` has any embedded `\n` flattened to a single space; this keeps
 *   one logical event = one physical line in the file (continuation rules in
 *   §6.2 only apply to error stack traces, which are emitted as a follow-up
 *   block, not as part of `<message>`).
 * - When the channel path is empty (root logger), the `[]` is omitted.
 */
export function formatLine(opts: {
  level: FormatLevel;
  channel: string[];
  message: string;
  meta?: Record<string, unknown>;
  err?: unknown;
}): string {
  const { level, channel, message, meta, err } = opts;
  const ts = formatUtcPlus8Timestamp(new Date());
  const lvl = LEVEL_LABEL[level];
  const ch = channel.length > 0 ? ` [${channel.join(":")}]` : "";
  const msg = String(message ?? "").replace(/\n/g, " ");

  let metaWithErr = meta;
  let stack: string | null = null;
  if (err !== undefined) {
    const errMsg =
      err instanceof Error ? err.message : err == null ? String(err) : String(err);
    metaWithErr = { ...(meta ?? {}), err: errMsg };
    if (err instanceof Error && err.stack) {
      stack = err.stack;
    }
  }

  let line = `[${ts}] ${lvl}${ch} ${msg}${encodeMeta(metaWithErr)}`;

  if (stack) {
    // Continuation lines: each line of the stack indented by 2 spaces. Spec
    // §6.2 doesn't require these to be atomic — readers re-align by spotting
    // the next `[<iso>] level` prefix.
    const indented = stack
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    line += "\n" + indented;
  }

  return line;
}

/**
 * Render the per-run header line written exactly once at the top of a run.
 * No trailing newline.
 */
export function formatRunHeader(opts: {
  mode: "dev" | "release";
  pid: number;
  version: string;
  /** Defaults to `now` — only injected for testing. */
  startedAt?: Date;
}): string {
  const ts = formatUtcPlus8Timestamp(opts.startedAt ?? new Date());
  return `=== run start ${ts} mode=${opts.mode} pid=${opts.pid} version=${opts.version} ===`;
}
