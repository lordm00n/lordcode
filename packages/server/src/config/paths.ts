import { homedir } from "node:os";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Returns the absolute path to the lordcode config file.
 * Defaults to `~/.lordcode/config.json`. The home directory can be
 * overridden via `LORDCODE_HOME` (used in tests to avoid touching real $HOME).
 */
export function getConfigPath(home: string = resolveHome()): string {
  return join(home, ".lordcode", "config.json");
}

export function getConfigDir(home: string = resolveHome()): string {
  return join(home, ".lordcode");
}

/**
 * `~/.lordcode/logs/` — single root for every log file lordcode emits.
 * Both the global `debug.log` and the per-session files (二期) live here.
 */
export function getLogsDir(home: string = resolveHome()): string {
  return join(home, ".lordcode", "logs");
}

export function getDataDir(home: string = resolveHome()): string {
  return join(home, ".lordcode", "data");
}

export function getSessionsDbPath(home: string = resolveHome()): string {
  return join(getDataDir(home), "sessions.sqlite");
}

/**
 * Default debug-log path. Honors `LORDCODE_DEBUG_LOG` as an absolute override,
 * matching spec §11. The override wins over both `home` and the default name
 * so tests / power users can redirect to e.g. `/tmp/foo.log`.
 */
export function getDebugLogPath(home: string = resolveHome()): string {
  const override = process.env.LORDCODE_DEBUG_LOG;
  if (override && override.length > 0) return override;
  return join(getLogsDir(home), "debug.log");
}

/**
 * `~/.lordcode/logs/sessions/` — only used by 二期 session-log writers; the
 * one-iteration code never `mkdir`s this. Defining the path now keeps spec §13
 * "preservation" promise that two-期 plumbing won't need to touch one-期 code.
 */
export function getSessionsLogDir(home: string = resolveHome()): string {
  return join(getLogsDir(home), "sessions");
}

function resolveHome(): string {
  const override = process.env.LORDCODE_HOME;
  if (override && override.length > 0) return override;
  return homedir();
}

/**
 * Idempotent: creates `<home>/.lordcode/` if it does not already exist.
 */
export async function ensureConfigDir(home?: string): Promise<string> {
  return ensureDir(getConfigDir(home));
}

/**
 * Idempotent: creates `<home>/.lordcode/logs/` if missing. Called once on
 * boot before opening the file transport.
 */
export async function ensureLogsDir(home?: string): Promise<string> {
  return ensureDir(getLogsDir(home));
}

export async function ensureDataDir(home?: string): Promise<string> {
  return ensureDir(getDataDir(home));
}

async function ensureDir(dir: string): Promise<string> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) {
      throw new Error(`path exists but is not a directory: ${dir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dir, { recursive: true });
    } else {
      throw err;
    }
  }
  return dir;
}

/**
 * Boot-time size cap. If `path` already exists and exceeds `maxBytes`, rename
 * it to `<path>.old` (overwriting any previous `.old`) so the next write
 * starts fresh. Spec §12.3: lord-cli stays under ~100 MB total without
 * pulling in a rotator dependency.
 */
export async function rotateIfHuge(
  path: string,
  maxBytes: number = 50 * 1024 * 1024,
): Promise<void> {
  let size: number;
  try {
    const s = await stat(path);
    size = s.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (size > maxBytes) {
    await rename(path, `${path}.old`);
  }
}
