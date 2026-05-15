import type { Logger } from "@lordcode/logger";
import type {
  RipgrepContentMatch,
  RipgrepInput,
  RipgrepOutput,
} from "./schema.js";

/**
 * Pure folder over the JSON Lines stream emitted by `rg --json`.
 *
 * The chunk vocabulary we care about is `begin` / `match` / `context` / `end`
 * (see https://docs.rs/grep-printer/latest/grep_printer/struct.JSON.html).
 * `summary` is intentionally dropped — exposing per-call rg statistics to the
 * LLM is more noise than signal.
 *
 * Notes vs the spec (§7.1, §7.4):
 * - We do NOT pass `-l` or `-c` to ripgrep. Both flags suppress JSON output and
 *   fall back to plain-text printing, even with `--json`. Instead, we always
 *   ask for JSON `match` events and *fold* them ourselves into the requested
 *   shape. This keeps the parser single-pathed.
 * - Truncation is applied per item-of-interest:
 *     content            → max `headLimit` matches across all files
 *     files_with_matches → max `headLimit` files
 *     count              → max `headLimit` files (their counts stay accurate)
 *   Once the cap is hit we keep consuming chunks (cheap) but stop appending,
 *   and set `truncated: true`.
 *
 * Malformed JSON lines are tolerated: a single corrupt line is logged at
 * `warn` and skipped rather than crashing the whole call.
 */
export interface ParseOptions {
  outputMode: RipgrepInput["outputMode"];
  headLimit: number;
  /**
   * The values originally passed to ripgrep as `-B` / `-A`. Used by the parser
   * to decide whether a `context` chunk arriving between two matches belongs
   * to the *previous* match's `after` window or the *next* match's `before`
   * window. When omitted (or 0) the boundary defaults to "midpoint", which
   * is fine for the no-context case where this branch is never reached.
   */
  contextBefore?: number;
  contextAfter?: number;
  /** Channel-rooted logger; if omitted, malformed lines are silently skipped. */
  logger?: Logger;
}

interface RgBeginEvent {
  type: "begin";
  data: { path: { text?: string; bytes?: string } };
}
interface RgMatchEvent {
  type: "match";
  data: {
    path: { text?: string; bytes?: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
  };
}
interface RgContextEvent {
  type: "context";
  data: {
    path: { text?: string; bytes?: string };
    lines: { text?: string; bytes?: string };
    line_number: number;
  };
}
interface RgEndEvent {
  type: "end";
  data: { path: { text?: string; bytes?: string } };
}
interface RgSummaryEvent {
  type: "summary";
}
type RgEvent =
  | RgBeginEvent
  | RgMatchEvent
  | RgContextEvent
  | RgEndEvent
  | RgSummaryEvent;

export function parseRipgrepJsonLines(
  lines: readonly string[],
  opts: ParseOptions,
): RipgrepOutput {
  const log = opts.logger;

  // Accumulators for each output mode. Only the relevant one is touched.
  const matches: RipgrepContentMatch[] = [];
  const files: string[] = [];
  const counts = new Map<string, number>();
  // Iteration order is needed for `count`'s final array, but Map preserves
  // insertion order; for `files_with_matches` we push during `end` to keep
  // the rg traversal order stable.

  let truncated = false;
  let currentFile: string | null = null;
  let currentFileMatched = false;
  // Context lines arrive interleaved with matches; we can only decide whose
  // `before` / `after` they belong to once we've seen the next match (or the
  // file's `end`). Buffer them per-file and partition on those events.
  let pendingCtx: { line: number; text: string }[] = [];
  let prevMatchInFile: RipgrepContentMatch | null = null;
  const contextBefore = opts.contextBefore ?? 0;
  const contextAfter = opts.contextAfter ?? 0;

  const drainPendingTo = (target: RipgrepContentMatch | "after-prev") => {
    if (pendingCtx.length === 0) return;
    if (target === "after-prev") {
      if (prevMatchInFile == null) {
        pendingCtx = [];
        return;
      }
      const prev = prevMatchInFile;
      for (const c of pendingCtx) {
        (prev.after ??= []).push(c.text);
      }
      pendingCtx = [];
      return;
    }
    // target = the new match. Partition each context line:
    //   - inside [prev.line+1, prev.line+contextAfter]  → prev.after
    //   - inside [target.line-contextBefore, target.line-1] → target.before
    //   - else: assign to whichever match is closer in line distance
    for (const c of pendingCtx) {
      const inAfterWindow =
        prevMatchInFile != null &&
        contextAfter > 0 &&
        c.line > prevMatchInFile.line &&
        c.line <= prevMatchInFile.line + contextAfter;
      const inBeforeWindow =
        contextBefore > 0 &&
        c.line >= target.line - contextBefore &&
        c.line < target.line;
      if (inAfterWindow && !inBeforeWindow && prevMatchInFile != null) {
        (prevMatchInFile.after ??= []).push(c.text);
      } else if (inBeforeWindow && !inAfterWindow) {
        (target.before ??= []).push(c.text);
      } else if (prevMatchInFile != null) {
        // Tie-break on line-distance to the two anchors.
        const distAfter = c.line - prevMatchInFile.line;
        const distBefore = target.line - c.line;
        if (distBefore <= distAfter) {
          (target.before ??= []).push(c.text);
        } else {
          (prevMatchInFile.after ??= []).push(c.text);
        }
      } else {
        // Pre-first-match context: belongs to target.before.
        (target.before ??= []).push(c.text);
      }
    }
    pendingCtx = [];
  };

  for (const raw of lines) {
    if (raw.length === 0) continue;
    let ev: RgEvent;
    try {
      ev = JSON.parse(raw) as RgEvent;
    } catch {
      log?.warn("ripgrep json line dropped (parse error)", {
        sample: raw.slice(0, 80),
      });
      continue;
    }
    if (typeof ev !== "object" || ev == null || typeof ev.type !== "string") {
      log?.warn("ripgrep json line dropped (shape error)");
      continue;
    }

    switch (ev.type) {
      case "begin": {
        currentFile = pathOf(ev.data.path);
        currentFileMatched = false;
        prevMatchInFile = null;
        pendingCtx = [];
        break;
      }

      case "match": {
        const file = pathOf(ev.data.path);
        if (file == null) break;
        const text = textOf(ev.data.lines);
        const lineNumber = ev.data.line_number;
        if (text == null || !Number.isFinite(lineNumber)) break;

        // Per-mode accounting. Truncation gate is per-mode too.
        if (opts.outputMode === "content") {
          if (matches.length >= opts.headLimit) {
            truncated = true;
            // Drop any pending context — there's no longer a match to attach
            // it to in the truncated output.
            pendingCtx = [];
            break;
          }
          const newMatch: RipgrepContentMatch = {
            file,
            line: lineNumber,
            text: stripTrailingNewline(text),
          };
          // Partition any buffered context between prev match's `after` and
          // this new match's `before`.
          drainPendingTo(newMatch);
          matches.push(newMatch);
          prevMatchInFile = newMatch;
        } else if (opts.outputMode === "files_with_matches") {
          // Defer the file push to `end` so the result list stays in rg's
          // natural traversal order, with no duplicates.
          currentFileMatched = true;
        } else {
          // count
          counts.set(file, (counts.get(file) ?? 0) + 1);
        }
        break;
      }

      case "context": {
        if (opts.outputMode !== "content") break;
        const text = textOf(ev.data.lines);
        const lineNumber = ev.data.line_number;
        if (text == null || !Number.isFinite(lineNumber)) break;
        // Buffer; assignment happens at the next `match` or at `end`.
        pendingCtx.push({ line: lineNumber, text: stripTrailingNewline(text) });
        break;
      }

      case "end": {
        // Any context still in the buffer must belong to the previous match's
        // `after` window (by definition: there's no next match in this file).
        drainPendingTo("after-prev");
        prevMatchInFile = null;

        if (opts.outputMode === "files_with_matches" && currentFileMatched) {
          if (currentFile != null) {
            if (files.length >= opts.headLimit) {
              truncated = true;
            } else {
              files.push(currentFile);
            }
          }
        }
        currentFile = null;
        currentFileMatched = false;
        break;
      }

      case "summary":
        // intentionally ignored — see header comment
        break;

      default: {
        // Unknown chunk types from a future ripgrep — log once and skip.
        log?.debug("ripgrep json line: unknown type", {
          type: (ev as { type: unknown }).type,
        });
      }
    }
  }

  if (opts.outputMode === "content") {
    return { mode: "content", matches, truncated };
  }
  if (opts.outputMode === "files_with_matches") {
    return { mode: "files_with_matches", files, truncated };
  }
  // count: re-fold the Map into an array, applying headLimit on file count
  // (per-file totals stay exact since we kept counting throughout).
  const arr: { file: string; count: number }[] = [];
  for (const [file, count] of counts) {
    if (arr.length >= opts.headLimit) {
      truncated = true;
      break;
    }
    arr.push({ file, count });
  }
  return { mode: "count", counts: arr, truncated };
}

function pathOf(p: { text?: string; bytes?: string } | undefined): string | null {
  if (p == null) return null;
  if (typeof p.text === "string") return p.text;
  // ripgrep emits `bytes` (base64) for non-utf8 paths. We could decode but
  // any path we surface back must round-trip through the OS; punt for now.
  return null;
}

function textOf(l: { text?: string; bytes?: string } | undefined): string | null {
  if (l == null) return null;
  if (typeof l.text === "string") return l.text;
  return null;
}

function stripTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}
