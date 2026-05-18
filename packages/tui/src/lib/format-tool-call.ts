/**
 * Format tool-call / tool-result / tool-error payloads as terse single-line
 * strings for the TUI message area.
 *
 * The format is intentionally minimal (spec §6.3): a richer expandable panel
 * is left to a future iteration. We render:
 *   `→ ripgrep(pattern: "useState", type: "ts")`
 *   `← 12 matches in 7 files`               (or `… (truncated)`)
 *   `× rg failed: regex parse error`
 *
 * Both `input` and `output` arrive on the wire as `unknown` (the server is
 * tool-agnostic). We sniff per-`toolName` and fall back to a JSON-ish summary
 * for any unrecognised tool — keeps us forward-compatible with new tools
 * landing without TUI changes.
 */

const MAX_INPUT_CHARS = 80;

export interface LiveToolInput {
  toolCallId: string;
  toolName: string;
  phase: "preparing" | "executing";
  inputBytes?: number;
  elapsedMs?: number;
}

/** Render the `tool-call` line. */
export function formatToolCall(toolName: string, input: unknown): string {
  return `${toolName}(${formatInputArgs(toolName, input)})`;
}

/** Render the pre-`tool-call` input-generation placeholder line. */
export function formatLiveToolInput(input: LiveToolInput): string {
  if (input.phase === "executing") return `${input.toolName} executing...`;
  const bytes =
    typeof input.inputBytes === "number" ? ` ${humanBytes(input.inputBytes)}` : "";
  return `${input.toolName} preparing input...${bytes}`;
}

/** Render the `tool-result` line. */
export function formatToolResult(toolName: string, output: unknown): string {
  if (toolName === "ripgrep") return formatRipgrepResult(output);
  if (toolName === "glob") return formatGlobResult(output);
  if (toolName === "read_file") return formatReadFileResult(output);
  if (toolName === "write_file") return formatWriteFileResult(output);
  if (toolName === "bash") return formatBashResult(output);
  return safePreview(output);
}

/** Render the `tool-error` line. */
export function formatToolError(toolName: string, message: string): string {
  return `${toolName} failed: ${message}`;
}

// ── ripgrep-specific ────────────────────────────────────────────────────────

function formatRipgrepResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);
  const mode = output.mode;
  const truncated = output.truncated === true;
  const suffix = truncated ? " (truncated)" : "";

  if (mode === "content") {
    const matches = Array.isArray(output.matches) ? output.matches : [];
    const fileCount = new Set(
      matches
        .map((m) => (isRecord(m) && typeof m.file === "string" ? m.file : null))
        .filter((f): f is string => f != null),
    ).size;
    return `${matches.length} match${matches.length === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}${suffix}`;
  }

  if (mode === "files_with_matches") {
    const files = Array.isArray(output.files) ? output.files : [];
    return `${files.length} file${files.length === 1 ? "" : "s"}${suffix}`;
  }

  if (mode === "count") {
    const counts = Array.isArray(output.counts) ? output.counts : [];
    const total = counts.reduce((sum, c) => {
      if (isRecord(c) && typeof c.count === "number") return sum + c.count;
      return sum;
    }, 0);
    return `${total} match${total === 1 ? "" : "es"} across ${counts.length} file${counts.length === 1 ? "" : "s"}${suffix}`;
  }

  return safePreview(output);
}

// ── glob-specific ───────────────────────────────────────────────────────────

function formatGlobResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);
  const files = Array.isArray(output.files) ? output.files : [];
  const suffix = output.truncated === true ? " (truncated)" : "";
  return `${files.length} file${files.length === 1 ? "" : "s"}${suffix}`;
}

// ── read_file-specific ──────────────────────────────────────────────────────

function formatReadFileResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);

  if (output.kind === "image") {
    const size =
      typeof output.byteSize === "number" ? humanBytes(output.byteSize) : "?";
    const media =
      typeof output.mediaType === "string" ? output.mediaType : "image";
    return `image (${size}, ${media})`;
  }

  if (output.kind === "text") {
    const start = typeof output.startLine === "number" ? output.startLine : 0;
    const end = typeof output.endLine === "number" ? output.endLine : 0;
    const total =
      typeof output.totalLines === "number" ? output.totalLines : 0;
    const n = Math.max(0, end - start + 1);
    const flags: string[] = [];
    if (output.truncated === true) flags.push("truncated");
    if (output.lineTruncated === true) flags.push("lines clipped");
    const flagSuffix =
      flags.length > 0 ? ` ${flags.map((f) => `(${f})`).join(" ")}` : "";
    return `${n} line${n === 1 ? "" : "s"} (${start}-${end} of ${total})${flagSuffix}`;
  }

  return safePreview(output);
}

/**
 * Render a byte count in 1024-base units with at most one fractional digit.
 * Mirrors `du -h` / Finder behaviour closely enough for at-a-glance sizing
 * in the TUI summary lines.
 */
function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  if (i === 0) return `${value} ${units[0]}`;
  // 1 decimal place is enough for a single-line preview; trim trailing `.0`.
  const formatted = value.toFixed(1).replace(/\.0$/, "");
  return `${formatted} ${units[i]}`;
}

// ── write_file-specific ─────────────────────────────────────────────────────

function formatWriteFileResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);

  const created = output.created === true;
  const bytes = typeof output.bytesWritten === "number"
    ? humanBytes(output.bytesWritten) : "?";
  const prev = typeof output.previousBytes === "number"
    ? ` (was ${humanBytes(output.previousBytes)})` : "";

  return created
    ? `created · ${bytes}`
    : `overwrote · ${bytes}${prev}`;
}

// ── bash-specific ───────────────────────────────────────────────────────────

function formatBashResult(output: unknown): string {
  if (!isRecord(output)) return safePreview(output);

  const exitCode = typeof output.exitCode === "number" ? output.exitCode : null;
  const killed = output.killed === true;
  const truncated = output.truncated === true;

  const stdout = typeof output.stdout === "string" ? output.stdout : "";
  const stderr = typeof output.stderr === "string" ? output.stderr : "";
  const lines = (stdout + stderr).split("\n").filter(Boolean).length;

  const parts: string[] = [];
  if (killed) parts.push("killed");
  parts.push(`exit ${exitCode ?? "?"}`);
  parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
  if (truncated) parts.push("(truncated)");
  if (killed && !truncated) parts.push("(timeout)");

  return parts.join(" · ");
}

// ── input-arg formatting ────────────────────────────────────────────────────

function formatInputArgs(toolName: string, input: unknown): string {
  if (!isRecord(input)) return safePreview(input);

  // Per-tool key ordering keeps the most informative args first.
  const order =
    toolName === "ripgrep"
      ? ["pattern", "path", "type", "glob", "outputMode", "headLimit"]
      : toolName === "glob"
        ? ["pattern", "path", "exclude", "includeHidden", "headLimit"]
        : toolName === "read_file"
          ? ["path", "offset", "limit"]
          : toolName === "write_file"
            ? ["path", "mode", "createDirs"]
            : toolName === "bash"
              ? ["command", "cwd", "timeout"]
              : Object.keys(input);

  const parts: string[] = [];
  for (const key of order) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value == null) continue;
    // Drop "default-y" values that just clutter the preview.
    if (key === "outputMode" && value === "content") continue;
    if (key === "headLimit" && value === 100) continue;
    if (key === "includeHidden" && value === false) continue;
    if (key === "exclude" && Array.isArray(value) && value.length === 0) continue;
    if (toolName === "read_file" && key === "offset" && value === 1) continue;
    if (toolName === "read_file" && key === "limit" && value === 2000) continue;
    if (toolName === "write_file" && key === "mode" && value === "overwrite") continue;
    if (toolName === "write_file" && key === "createDirs" && value === true) continue;
    if (toolName === "bash" && key === "timeout" && value === 30000) continue;
    parts.push(`${key}: ${formatScalar(value)}`);
  }
  return clip(parts.join(", "));
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return safePreview(v);
}

function safePreview(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s == null ? String(v) : clip(s);
  } catch {
    return String(v);
  }
}

function clip(s: string): string {
  if (s.length <= MAX_INPUT_CHARS) return s;
  return `${s.slice(0, MAX_INPUT_CHARS - 1)}…`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
