import { formatLine, type FormatLevel } from "./format.js";
import type { Logger, LogLevel, LogTransport } from "./types.js";

/**
 * Severity ordering. `level` decides which calls actually reach the
 * transports — see spec §7.1 (warn/error still fire on `info`).
 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  info: 1,
  debug: 2,
};

function shouldEmit(level: LogLevel, target: FormatLevel): boolean {
  if (level === "silent") return false;
  if (target === "debug") return LEVEL_ORDER[level] >= LEVEL_ORDER.debug;
  // info / warn / error all emit on both `info` and `debug`.
  return true;
}

interface InternalLoggerState {
  level: LogLevel;
  channel: string[];
  transports: readonly LogTransport[];
  /**
   * The transports this node *owns*. Closing this node only closes these.
   *
   * - root logger: owns everything passed to `createLogger`.
   * - `child(name)` derivation: owns nothing (empty array).
   * - `tee(t)` derivation: owns just `[t]`.
   */
  ownedTransports: readonly LogTransport[];
}

function emit(
  state: InternalLoggerState,
  level: FormatLevel,
  message: string,
  meta?: Record<string, unknown>,
  err?: unknown,
): void {
  if (!shouldEmit(state.level, level)) return;
  let line: string;
  try {
    line = formatLine({
      level,
      channel: state.channel,
      message,
      ...(meta !== undefined ? { meta } : {}),
      ...(err !== undefined ? { err } : {}),
    });
  } catch (formatErr) {
    // Last-resort: format itself failed. Don't take down the caller.
    try {
      // eslint-disable-next-line no-console
      console.error("[lordcode logger] format failed:", formatErr);
    } catch {
      // can't even console.error — give up silently
    }
    return;
  }

  for (const t of state.transports) {
    try {
      t.write(line + "\n");
    } catch (writeErr) {
      try {
        // eslint-disable-next-line no-console
        console.error("[lordcode logger] transport write failed:", writeErr);
      } catch {
        // give up
      }
    }
  }
}

function makeLogger(state: InternalLoggerState): Logger {
  let closed = false;

  const self: Logger = {
    debug(message, meta) {
      emit(state, "debug", message, meta);
    },
    info(message, meta) {
      emit(state, "info", message, meta);
    },
    warn(message, meta) {
      emit(state, "warn", message, meta);
    },
    error(message, err, meta) {
      emit(state, "error", message, meta, err);
    },

    child(name) {
      return makeLogger({
        level: state.level,
        channel: [...state.channel, name],
        transports: state.transports,
        ownedTransports: [],
      });
    },

    tee(transport) {
      return makeLogger({
        level: state.level,
        channel: state.channel,
        transports: [...state.transports, transport],
        ownedTransports: [transport],
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const t of state.ownedTransports) {
        try {
          await t.close();
        } catch (err) {
          try {
            // eslint-disable-next-line no-console
            console.error("[lordcode logger] transport close failed:", err);
          } catch {
            // give up
          }
        }
      }
    },
  };

  return self;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  transports: LogTransport[];
  /** Default `[]` — root has no channel. Pre-seeded only when reattaching. */
  channel?: string[];
}

/**
 * Build a root `Logger`. The root owns the transports it was built with: when
 * you `await logger.close()` on the root, every transport here is released.
 * Derive sub-loggers via `.child(name)` (extends the channel path) and
 * `.tee(transport)` (adds another sink).
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  return makeLogger({
    level: opts.level,
    channel: opts.channel ? [...opts.channel] : [],
    transports: [...opts.transports],
    ownedTransports: [...opts.transports],
  });
}
