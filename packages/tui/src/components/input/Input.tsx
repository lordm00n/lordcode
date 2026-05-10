import React, { useRef } from "react";
import {
  Box,
  Text,
  useBoxMetrics,
  useCursor,
  type DOMElement,
} from "ink";
import stringWidth from "string-width";
import { offsetToLineCol } from "../../lib/input-buffer.js";

interface InputProps {
  value: string;
  /** Character offset of the cursor in `value`, in `[0, value.length]`. */
  cursor: number;
  isStreaming: boolean;
}

/** Display width of the rendered prompt prefix (`"› "` / `"… "`). Both glyphs
 *  measure 1 column in a monospace cell, plus the trailing space — but we let
 *  `string-width` settle the width so it stays correct if the chevron ever
 *  changes to something wider. */
const PROMPT = "›";
const STREAMING_PROMPT = "…";
const PROMPT_DISPLAY_WIDTH = stringWidth(`${PROMPT} `);

/**
 * Presentational prompt line for the TUI's command input.
 *
 * - Rendering is pure: cursor + value live in the parent (`App`) and we just
 *   reflect them.
 * - There is no in-text cursor highlight: we rely on the terminal's own
 *   hardware cursor, positioned via `useCursor`, to mark the insertion
 *   point. `main.tsx` forces the cursor style to a steady block on start
 *   (`DECSCUSR 2`) so it visually behaves like "the character at the cursor
 *   is inverse", regardless of the user's terminal default. This is also
 *   what enables IME composition (CJK, dead keys) to anchor candidate
 *   popups in the right spot.
 * - During streaming we hide the cursor: the user can't type and a blinking
 *   cursor would falsely suggest otherwise.
 */
export function Input({ value, cursor, isStreaming }: InputProps) {
  // `null!` because Ink's `useBoxMetrics` types the ref as non-nullable
  // (`RefObject<DOMElement>`) while React 19's `useRef(null)` necessarily
  // infers a nullable ref. The hook itself handles the null case at runtime
  // by returning zeroed metrics until the ref is attached.
  const ref = useRef<DOMElement>(null!);
  const { left, top, hasMeasured } = useBoxMetrics(ref);
  const { setCursorPosition } = useCursor();

  if (isStreaming || !hasMeasured) {
    setCursorPosition(undefined);
  } else {
    const { line, col } = offsetToLineCol(value, cursor);
    // Width of the rendered prefix on the cursor's line. The prompt only
    // appears on the visual first line; continuation lines (after `\n`) start
    // flush against the box's left edge, so the prefix collapses to 0.
    const prefixWidth = line === 0 ? PROMPT_DISPLAY_WIDTH : 0;
    const linePrefix = sliceLine(value, line).slice(0, col);
    setCursorPosition({
      x: left + prefixWidth + stringWidth(linePrefix),
      y: top + line,
    });
  }

  return (
    <Box ref={ref}>
      <Text>
        <Text color={isStreaming ? "gray" : "magenta"}>
          {isStreaming ? STREAMING_PROMPT : PROMPT}
          {" "}
        </Text>
        <Text>{value}</Text>
      </Text>
    </Box>
  );
}

/** Extract the substring corresponding to a single 0-indexed line of `value`. */
function sliceLine(value: string, line: number): string {
  const lines = value.split("\n");
  return lines[line] ?? "";
}
