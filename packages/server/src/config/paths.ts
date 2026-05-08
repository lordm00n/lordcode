import { homedir } from "node:os";
import { mkdir, stat } from "node:fs/promises";
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

function resolveHome(): string {
  const override = process.env.LORDCODE_HOME;
  if (override && override.length > 0) return override;
  return homedir();
}

/**
 * Idempotent: creates `<home>/.lordcode/` if it does not already exist.
 */
export async function ensureConfigDir(home?: string): Promise<string> {
  const dir = getConfigDir(home);
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) {
      throw new Error(`config dir path exists but is not a directory: ${dir}`);
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
