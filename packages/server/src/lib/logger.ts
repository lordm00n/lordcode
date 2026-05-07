export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type LogLevel = "silent" | "info" | "debug";

const levelOrder: Record<LogLevel, number> = {
  silent: 0,
  info: 1,
  debug: 2,
};

export function createLogger(level: LogLevel = "info"): Logger {
  const enabled = (target: LogLevel) => levelOrder[level] >= levelOrder[target];
  const stamp = () => new Date().toISOString();
  return {
    debug: (...args) => {
      if (enabled("debug")) console.debug(`[${stamp()}] [debug]`, ...args);
    },
    info: (...args) => {
      if (enabled("info")) console.info(`[${stamp()}] [info ]`, ...args);
    },
    warn: (...args) => {
      if (enabled("info")) console.warn(`[${stamp()}] [warn ]`, ...args);
    },
    error: (...args) => {
      if (enabled("info")) console.error(`[${stamp()}] [error]`, ...args);
    },
  };
}
