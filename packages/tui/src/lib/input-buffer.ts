/**
 * Pure model + transitions for a single-buffer text input with a cursor.
 *
 * All functions are stateless — they take an `InputState` and return a new
 * `InputState`, never mutate. This keeps the React layer (`App.tsx`) trivially
 * predictable (just `setInput(fn(prev))`) and makes every cursor / editing
 * rule testable in isolation without spinning up Ink.
 *
 * Coordinate model:
 * - `value` is a JS string. Cursor positions are *character offsets* into
 *   `value`, in the half-open range `[0, value.length]`. Position `value.length`
 *   means "after the last character".
 * - For multi-line text, lines are split on `\n`. The newline character belongs
 *   to its preceding line: in `"abc\ndef"`, line 0 is `"abc"` (cols 0..3,
 *   offsets 0..3), line 1 is `"def"` (cols 0..3, offsets 4..7). The cursor at
 *   offset 3 is "end of line 0", at offset 4 is "start of line 1".
 *
 * Word boundaries (for `moveWordLeft` / `moveWordRight`):
 *   We use the macOS-Terminal style: a "word" is a maximal run of non-whitespace
 *   characters, and word-skipping first eats the whitespace adjacent to the
 *   cursor in the direction of motion, then eats one word.
 */

export interface InputState {
  value: string;
  cursor: number;
}

const WHITESPACE_RE = /\s/;

export function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor) || cursor < 0) return 0;
  if (cursor > value.length) return value.length;
  return Math.floor(cursor);
}

export function insert(state: InputState, text: string): InputState {
  if (text.length === 0) return state;
  const cursor = clampCursor(state.value, state.cursor);
  return {
    value: state.value.slice(0, cursor) + text + state.value.slice(cursor),
    cursor: cursor + text.length,
  };
}

/** Backspace — delete the character immediately before the cursor. */
export function deleteBefore(state: InputState): InputState {
  const cursor = clampCursor(state.value, state.cursor);
  if (cursor === 0) return { value: state.value, cursor };
  return {
    value: state.value.slice(0, cursor - 1) + state.value.slice(cursor),
    cursor: cursor - 1,
  };
}

/** Forward delete — remove the character at the cursor. No-op at end. */
export function deleteAt(state: InputState): InputState {
  const cursor = clampCursor(state.value, state.cursor);
  if (cursor >= state.value.length) return { value: state.value, cursor };
  return {
    value: state.value.slice(0, cursor) + state.value.slice(cursor + 1),
    cursor,
  };
}

export function moveLeft(state: InputState): InputState {
  return { value: state.value, cursor: clampCursor(state.value, state.cursor - 1) };
}

export function moveRight(state: InputState): InputState {
  return { value: state.value, cursor: clampCursor(state.value, state.cursor + 1) };
}

/**
 * Skip backwards over (whitespace, then one word). At buffer start, no-op.
 *
 * Examples (cursor shown as `|`):
 *   "hello |world" → "|hello world"     (no leading ws to skip; eat "hello")
 *   "hello world|" → "hello |world"     (no leading ws; eat "world")
 *   "hello |  world" → "|hello   world" (skip 2 ws, then eat "hello")
 *                                       (well, cursor is between "o " here;
 *                                        the example above is illustrative)
 */
export function moveWordLeft(state: InputState): InputState {
  const value = state.value;
  let p = clampCursor(value, state.cursor);
  if (p === 0) return { value, cursor: 0 };
  while (p > 0 && WHITESPACE_RE.test(value[p - 1] ?? "")) p--;
  while (p > 0 && !WHITESPACE_RE.test(value[p - 1] ?? "")) p--;
  return { value, cursor: p };
}

/**
 * Skip forwards over (whitespace, then one word). At buffer end, no-op.
 */
export function moveWordRight(state: InputState): InputState {
  const value = state.value;
  let p = clampCursor(value, state.cursor);
  if (p === value.length) return { value, cursor: p };
  while (p < value.length && WHITESPACE_RE.test(value[p] ?? "")) p++;
  while (p < value.length && !WHITESPACE_RE.test(value[p] ?? "")) p++;
  return { value, cursor: p };
}

/**
 * Map a character offset to (line, col). Lines and cols are 0-indexed.
 * The newline character belongs to its line, so `offsetToLineCol("a\nb", 1)`
 * is `{line: 0, col: 1}` (i.e. just after "a", on line 0) and
 * `offsetToLineCol("a\nb", 2)` is `{line: 1, col: 0}` (start of line 1).
 */
export function offsetToLineCol(
  value: string,
  offset: number,
): { line: number; col: number } {
  const o = clampCursor(value, offset);
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < o; i++) {
    if (value[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: o - lineStart };
}

/**
 * Map (line, col) back to a character offset. Negative `line` clamps to start;
 * a `line` past the last line clamps to end-of-buffer. `col` is clamped to the
 * line's length (so jumping from a long line to a short one snaps to its end).
 */
export function lineColToOffset(
  value: string,
  line: number,
  col: number,
): number {
  if (line < 0) return 0;
  const lines = value.split("\n");
  if (line >= lines.length) return value.length;
  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += (lines[i]?.length ?? 0) + 1; // +1 for the consumed "\n"
  }
  const lineLen = lines[line]?.length ?? 0;
  const safeCol = Math.max(0, Math.min(col, lineLen));
  return offset + safeCol;
}

/**
 * Up arrow. Preserves the column where possible. Pressing up on the first line
 * snaps to start-of-buffer (matching common editor / shell-prompt behavior).
 */
export function moveUp(state: InputState): InputState {
  const { line, col } = offsetToLineCol(state.value, state.cursor);
  if (line === 0) return { value: state.value, cursor: 0 };
  return {
    value: state.value,
    cursor: lineColToOffset(state.value, line - 1, col),
  };
}

/**
 * Down arrow. Preserves the column where possible. Pressing down on the last
 * line snaps to end-of-buffer.
 */
export function moveDown(state: InputState): InputState {
  const { line, col } = offsetToLineCol(state.value, state.cursor);
  const lineCount = countLines(state.value);
  if (line >= lineCount - 1) {
    return { value: state.value, cursor: state.value.length };
  }
  return {
    value: state.value,
    cursor: lineColToOffset(state.value, line + 1, col),
  };
}

/**
 * Number of logical lines in `value`. An empty string still counts as one
 * (empty) line; `"a\nb"` is two; `"a\n"` is two (the second is empty).
 */
export function countLines(value: string): number {
  let n = 1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") n++;
  }
  return n;
}
