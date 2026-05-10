/**
 * Identify whether a string received from `usePaste` represents an image, and
 * if so, materialize it as base64.
 *
 * Why this is non-trivial: the terminal's bracketed paste only carries text.
 * When a user "pastes an image" we therefore see one of three forms:
 *
 *   A. A `data:image/...;base64,...` URL (or raw base64) — user manually
 *      assembled it themselves.
 *   B. A filesystem path (e.g. from Finder/Files), possibly wrapped as
 *      `file://...`, quoted, or with shell-escaped spaces.
 *   C. An empty string — common when copying from Chrome / a screenshot tool:
 *      the OS clipboard holds image bytes but no text payload, so the terminal
 *      delivers an empty paste event. To recover the bytes we must bypass the
 *      terminal and read the system clipboard directly.
 *
 * `tryParsePastedImage` checks A → B → (optionally) C and returns `null` if
 * none of them yields an image.
 */
import { readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export interface PastedImage {
  /** Raw base64, no `data:` prefix. */
  base64: string;
  mimeType: string;
  /** Where the image was recovered from. */
  source: "data-url" | "path" | "clipboard";
  /** Convenience: full `data:<mime>;base64,<...>` ready to send. */
  dataUrl: string;
}

export interface ParseOptions {
  /**
   * When the pasted text isn't itself a data URL or image path, fall back to
   * reading image bytes directly from the system clipboard. This is the only
   * way to recover screenshots / browser-copied images, but it shells out to
   * `osascript` / `wl-paste` / `xclip` / `powershell.exe` so it has a small
   * latency cost (~50–200ms). Caller decides when to pay it.
   */
  fallbackToClipboard?: boolean;
}

const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export async function tryParsePastedImage(
  pasted: string,
  opts: ParseOptions = {},
): Promise<PastedImage | null> {
  const fromDataUrl = parseDataUrl(pasted);
  if (fromDataUrl) return fromDataUrl;

  const fromPath = await parseImagePath(pasted);
  if (fromPath) return fromPath;

  if (opts.fallbackToClipboard && pasted.trim() === "") {
    return readImageFromSystemClipboard();
  }
  return null;
}

// ---------- A. data URL / raw base64 ----------

const DATA_URL_RE =
  /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

function parseDataUrl(text: string): PastedImage | null {
  const trimmed = text.trim();
  const m = DATA_URL_RE.exec(trimmed);
  if (!m) return null;
  const mimeType = m[1];
  const base64 = (m[2] ?? "").replace(/\s+/g, "");
  if (!mimeType || base64.length === 0) return null;
  return {
    base64,
    mimeType,
    source: "data-url",
    dataUrl: `data:${mimeType};base64,${base64}`,
  };
}

// ---------- B. filesystem path ----------

async function parseImagePath(text: string): Promise<PastedImage | null> {
  const path = normalizePastedPath(text);
  if (path == null) return null;

  const ext = extname(path).toLowerCase();
  const mimeType = IMAGE_EXTS[ext];
  if (!mimeType) return null;

  try {
    const buf = await readFile(path);
    if (buf.length === 0) return null;
    return {
      base64: buf.toString("base64"),
      mimeType,
      source: "path",
      dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort: turn pasted text into a local filesystem path. Handles
 * `file://` URLs, single/double-quoted wrapping, and the macOS "drag &
 * drop into terminal" form that backslash-escapes spaces. Multi-line input
 * (multiple paths, or a path with a trailing message) returns `null` —
 * we treat those as ordinary text rather than guessing.
 */
export function normalizePastedPath(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.includes("\n")) return null;

  if (s.startsWith("file://")) {
    try {
      return fileURLToPath(s);
    } catch {
      return null;
    }
  }

  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1);
  }

  s = s.replace(/\\ /g, " ");

  const isPosix = s.startsWith("/") || s.startsWith("~/");
  const isWindows = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");
  return isPosix || isWindows ? s : null;
}

// ---------- C. system clipboard ----------

async function readImageFromSystemClipboard(): Promise<PastedImage | null> {
  const buf = await readClipboardImageBytes();
  if (!buf || buf.length === 0) return null;
  const base64 = buf.toString("base64");
  return {
    base64,
    mimeType: "image/png",
    source: "clipboard",
    dataUrl: `data:image/png;base64,${base64}`,
  };
}

async function readClipboardImageBytes(): Promise<Buffer | null> {
  switch (process.platform) {
    case "darwin":
      return readMacClipboardImage();
    case "linux":
      return readLinuxClipboardImage();
    case "win32":
      return readWindowsClipboardImage();
    default:
      return null;
  }
}

/**
 * macOS: AppleScript can pluck PNG data off the clipboard, but writing binary
 * to stdout via `osascript` is fragile (newline / encoding interference).
 * Instead, have AppleScript dump the PNG to a temp file and read it back.
 */
async function readMacClipboardImage(): Promise<Buffer | null> {
  const tmp = join(tmpdir(), `lordcode-paste-${process.pid}-${Date.now()}.png`);
  const script = [
    "try",
    `  set pngData to the clipboard as «class PNGf»`,
    `  set fp to open for access POSIX file "${tmp}" with write permission`,
    "  set eof of fp to 0",
    "  write pngData to fp",
    "  close access fp",
    `  return "ok"`,
    "on error errMsg",
    "  try",
    `    close access POSIX file "${tmp}"`,
    "  end try",
    `  return ""`,
    "end try",
  ].join("\n");

  const out = await runText("osascript", ["-e", script]);
  if (out == null || out.trim() !== "ok") return null;
  try {
    const buf = await readFile(tmp);
    return buf;
  } catch {
    return null;
  } finally {
    void unlink(tmp).catch(() => {});
  }
}

/**
 * Linux: try Wayland (`wl-paste`) first, then X11 (`xclip`). Both write the
 * raw PNG to stdout. If neither tool is installed we silently fall through.
 */
async function readLinuxClipboardImage(): Promise<Buffer | null> {
  const wayland = await runBinary("wl-paste", ["--type", "image/png"]);
  if (wayland && wayland.length > 0) return wayland;

  const x11 = await runBinary("xclip", [
    "-selection",
    "clipboard",
    "-t",
    "image/png",
    "-o",
  ]);
  return x11 && x11.length > 0 ? x11 : null;
}

/**
 * Windows: same trick as macOS — PowerShell writes the clipboard image to a
 * temp PNG and prints the path. We don't trust binary-on-stdout from
 * powershell.exe.
 */
async function readWindowsClipboardImage(): Promise<Buffer | null> {
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    "$img=Get-Clipboard -Format Image;" +
    "if($img -ne $null){" +
    "$p=[IO.Path]::GetTempFileName();" +
    "$p=[IO.Path]::ChangeExtension($p,'png');" +
    "$img.Save($p,[System.Drawing.Imaging.ImageFormat]::Png);" +
    "Write-Output $p" +
    "}";
  for (const cmd of ["powershell.exe", "pwsh", "powershell"]) {
    const out = await runText(cmd, ["-NoProfile", "-Command", script]);
    if (out == null) continue;
    const path = out.trim();
    if (path.length === 0) continue;
    try {
      const buf = await readFile(path);
      void unlink(path).catch(() => {});
      if (buf.length > 0) return buf;
    } catch {
      // try next shell variant
    }
  }
  return null;
}

// ---------- subprocess helpers ----------

function runBinary(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
  });
}

async function runText(cmd: string, args: string[]): Promise<string | null> {
  const buf = await runBinary(cmd, args);
  return buf == null ? null : buf.toString("utf8");
}
