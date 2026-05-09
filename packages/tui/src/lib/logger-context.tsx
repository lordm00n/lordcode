import React, { createContext, useContext, type ReactNode } from "react";
import type { Logger, LogTransport } from "@lordcode/logger";
import { createLogger } from "@lordcode/logger";

/**
 * Default Provider value: a logger backed by a no-op transport. Mounting a
 * `<LoggerProvider>` is the *recommended* path, but components rendered
 * outside one (notably tests for `App` that don't care about logs) won't
 * crash — they'll just discard messages.
 */
const noopTransport: LogTransport = {
  write() {
    /* no-op */
  },
  close() {
    /* no-op */
  },
};

const noopLogger: Logger = createLogger({
  level: "silent",
  transports: [noopTransport],
});

const LoggerContext = createContext<Logger>(noopLogger);

export interface LoggerProviderProps {
  logger: Logger;
  children: ReactNode;
}

/**
 * Inject a logger into the React tree so deep components can call `useLogger()`
 * without prop-drilling. Convention: wrap the entire `<App>` once, in `main.tsx`,
 * with the TUI-rooted logger (`root.child("tui")`).
 */
export function LoggerProvider({
  logger,
  children,
}: LoggerProviderProps): React.ReactElement {
  return (
    <LoggerContext.Provider value={logger}>{children}</LoggerContext.Provider>
  );
}

/**
 * Resolve the nearest provided `Logger`. Returns the silent fallback when no
 * provider is mounted (e.g. inside an isolated component test) so call sites
 * never need to null-check.
 */
export function useLogger(): Logger {
  return useContext(LoggerContext);
}
