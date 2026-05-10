import { describe, expect, it } from "vitest";
import {
  clampCursor,
  countLines,
  deleteAt,
  deleteBefore,
  insert,
  lineColToOffset,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  offsetToLineCol,
  type InputState,
} from "./input-buffer.js";

const s = (value: string, cursor: number): InputState => ({ value, cursor });

describe("clampCursor", () => {
  // [IB1.1]
  it("[IB1.1] negative → 0", () => {
    expect(clampCursor("hello", -3)).toBe(0);
  });

  // [IB1.2]
  it("[IB1.2] past end → length", () => {
    expect(clampCursor("hello", 99)).toBe(5);
  });

  // [IB1.3]
  it("[IB1.3] within range → unchanged", () => {
    expect(clampCursor("hello", 2)).toBe(2);
  });

  // [IB1.4]
  it("[IB1.4] non-finite → 0", () => {
    expect(clampCursor("hello", Number.NaN)).toBe(0);
    expect(clampCursor("hello", Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("insert", () => {
  // [IB2.1]
  it("[IB2.1] empty buffer → cursor advances by inserted length", () => {
    expect(insert(s("", 0), "hi")).toEqual({ value: "hi", cursor: 2 });
  });

  // [IB2.2]
  it("[IB2.2] middle of buffer → text spliced in, cursor advances past it", () => {
    expect(insert(s("ad", 1), "bc")).toEqual({ value: "abcd", cursor: 3 });
  });

  // [IB2.3]
  it("[IB2.3] empty insert → no-op (preserves identity behaviorally)", () => {
    expect(insert(s("hi", 1), "")).toEqual({ value: "hi", cursor: 1 });
  });

  // [IB2.4]
  it("[IB2.4] cursor past end clamps before insertion (defensive)", () => {
    expect(insert(s("hi", 99), "!")).toEqual({ value: "hi!", cursor: 3 });
  });

  // [IB2.5]
  it("[IB2.5] multi-line insertion preserves embedded newlines", () => {
    expect(insert(s("XY", 1), "a\nb")).toEqual({
      value: "Xa\nbY",
      cursor: 4,
    });
  });
});

describe("deleteBefore (backspace)", () => {
  // [IB3.1]
  it("[IB3.1] middle → removes char before cursor, cursor moves left 1", () => {
    expect(deleteBefore(s("abc", 2))).toEqual({ value: "ac", cursor: 1 });
  });

  // [IB3.2]
  it("[IB3.2] at start → no-op", () => {
    expect(deleteBefore(s("abc", 0))).toEqual({ value: "abc", cursor: 0 });
  });

  // [IB3.3]
  it("[IB3.3] at end → trims last char", () => {
    expect(deleteBefore(s("abc", 3))).toEqual({ value: "ab", cursor: 2 });
  });
});

describe("deleteAt (forward delete)", () => {
  // [IB4.1]
  it("[IB4.1] middle → removes char at cursor, cursor stays put", () => {
    expect(deleteAt(s("abc", 1))).toEqual({ value: "ac", cursor: 1 });
  });

  // [IB4.2]
  it("[IB4.2] at end → no-op", () => {
    expect(deleteAt(s("abc", 3))).toEqual({ value: "abc", cursor: 3 });
  });

  // [IB4.3]
  it("[IB4.3] at start → trims first char, cursor stays at 0", () => {
    expect(deleteAt(s("abc", 0))).toEqual({ value: "bc", cursor: 0 });
  });
});

describe("moveLeft / moveRight", () => {
  // [IB5.1]
  it("[IB5.1] left from middle → -1", () => {
    expect(moveLeft(s("abc", 2)).cursor).toBe(1);
  });

  // [IB5.2]
  it("[IB5.2] left at 0 → stays at 0 (no underflow)", () => {
    expect(moveLeft(s("abc", 0)).cursor).toBe(0);
  });

  // [IB5.3]
  it("[IB5.3] right from middle → +1", () => {
    expect(moveRight(s("abc", 1)).cursor).toBe(2);
  });

  // [IB5.4]
  it("[IB5.4] right at end → stays (no overflow past length)", () => {
    expect(moveRight(s("abc", 3)).cursor).toBe(3);
  });
});

describe("moveWordLeft", () => {
  // [IB6.1]
  it("[IB6.1] from end of last word → start of that word", () => {
    expect(moveWordLeft(s("hello world", 11)).cursor).toBe(6);
  });

  // [IB6.2]
  it("[IB6.2] from start of word → start of previous word", () => {
    expect(moveWordLeft(s("hello world", 6)).cursor).toBe(0);
  });

  // [IB6.3]
  it("[IB6.3] across multiple spaces → eats whitespace then word", () => {
    expect(moveWordLeft(s("a   bc", 6)).cursor).toBe(4);
  });

  // [IB6.4]
  it("[IB6.4] at 0 → no-op", () => {
    expect(moveWordLeft(s("hello", 0)).cursor).toBe(0);
  });

  // [IB6.5]
  it("[IB6.5] from inside a word → start of that word", () => {
    expect(moveWordLeft(s("foo bar", 5)).cursor).toBe(4);
  });

  // [IB6.6]
  it("[IB6.6] across newline counts as whitespace", () => {
    expect(moveWordLeft(s("foo\nbar", 7)).cursor).toBe(4);
    expect(moveWordLeft(s("foo\nbar", 4)).cursor).toBe(0);
  });
});

describe("moveWordRight", () => {
  // [IB7.1]
  it("[IB7.1] from start of word → end of that word", () => {
    expect(moveWordRight(s("hello world", 0)).cursor).toBe(5);
  });

  // [IB7.2]
  it("[IB7.2] from end of word (on space) → end of next word", () => {
    expect(moveWordRight(s("hello world", 5)).cursor).toBe(11);
  });

  // [IB7.3]
  it("[IB7.3] across multiple spaces → eats whitespace then word", () => {
    expect(moveWordRight(s("a   bc", 1)).cursor).toBe(6);
  });

  // [IB7.4]
  it("[IB7.4] at end → no-op", () => {
    expect(moveWordRight(s("hello", 5)).cursor).toBe(5);
  });

  // [IB7.5]
  it("[IB7.5] from middle of word → end of that word", () => {
    expect(moveWordRight(s("foobar baz", 3)).cursor).toBe(6);
  });

  // [IB7.6]
  it("[IB7.6] across newline counts as whitespace", () => {
    expect(moveWordRight(s("foo\nbar", 0)).cursor).toBe(3);
    expect(moveWordRight(s("foo\nbar", 3)).cursor).toBe(7);
  });
});

describe("offsetToLineCol", () => {
  // [IB8.1]
  it("[IB8.1] start of single-line buffer", () => {
    expect(offsetToLineCol("hello", 0)).toEqual({ line: 0, col: 0 });
  });

  // [IB8.2]
  it("[IB8.2] middle of single-line buffer", () => {
    expect(offsetToLineCol("hello", 3)).toEqual({ line: 0, col: 3 });
  });

  // [IB8.3]
  it("[IB8.3] right at the newline → end of preceding line", () => {
    expect(offsetToLineCol("ab\ncd", 2)).toEqual({ line: 0, col: 2 });
  });

  // [IB8.4]
  it("[IB8.4] just past the newline → start of next line", () => {
    expect(offsetToLineCol("ab\ncd", 3)).toEqual({ line: 1, col: 0 });
  });

  // [IB8.5]
  it("[IB8.5] mid second line", () => {
    expect(offsetToLineCol("ab\ncd", 4)).toEqual({ line: 1, col: 1 });
  });

  // [IB8.6]
  it("[IB8.6] empty buffer", () => {
    expect(offsetToLineCol("", 0)).toEqual({ line: 0, col: 0 });
  });
});

describe("lineColToOffset", () => {
  // [IB9.1]
  it("[IB9.1] negative line → 0", () => {
    expect(lineColToOffset("abc\ndef", -1, 2)).toBe(0);
  });

  // [IB9.2]
  it("[IB9.2] line past end → end-of-buffer", () => {
    expect(lineColToOffset("abc\ndef", 99, 0)).toBe(7);
  });

  // [IB9.3]
  it("[IB9.3] col within line", () => {
    expect(lineColToOffset("abc\ndef", 1, 2)).toBe(6);
  });

  // [IB9.4]
  it("[IB9.4] col past line length → snaps to line end", () => {
    expect(lineColToOffset("abc\nde", 1, 99)).toBe(6);
  });

  // [IB9.5]
  it("[IB9.5] negative col → 0 within line", () => {
    expect(lineColToOffset("abc\ndef", 1, -5)).toBe(4);
  });
});

describe("moveUp / moveDown", () => {
  // [IB10.1]
  it("[IB10.1] down preserves column when next line is long enough", () => {
    expect(moveDown(s("abcd\nwxyz", 2)).cursor).toBe(7); // col 2 on line 1
  });

  // [IB10.2]
  it("[IB10.2] down snaps column when next line is shorter", () => {
    expect(moveDown(s("abcdef\nwx", 5)).cursor).toBe(9); // end of "wx"
  });

  // [IB10.3]
  it("[IB10.3] down on last line → end-of-buffer", () => {
    expect(moveDown(s("abc\ndef", 5)).cursor).toBe(7);
  });

  // [IB10.4]
  it("[IB10.4] up preserves column when previous line is long enough", () => {
    expect(moveUp(s("abcd\nwxyz", 7)).cursor).toBe(2); // col 2 on line 0
  });

  // [IB10.5]
  it("[IB10.5] up snaps column when previous line is shorter", () => {
    expect(moveUp(s("ab\ncdefgh", 7)).cursor).toBe(2); // end of "ab"
  });

  // [IB10.6]
  it("[IB10.6] up on first line → start-of-buffer", () => {
    expect(moveUp(s("abc\ndef", 2)).cursor).toBe(0);
  });

  // [IB10.7]
  it("[IB10.7] down then up restores column when both lines are long", () => {
    const start = s("abcdef\nuvwxyz\n123456", 4); // col 4 on line 0
    const after = moveUp(moveDown(moveDown(start)));
    expect(after.cursor).toBe(11); // col 4 on line 1
  });
});

describe("countLines", () => {
  // [IB11.1]
  it("[IB11.1] empty buffer → 1", () => {
    expect(countLines("")).toBe(1);
  });

  // [IB11.2]
  it("[IB11.2] no newlines → 1", () => {
    expect(countLines("hello")).toBe(1);
  });

  // [IB11.3]
  it("[IB11.3] N newlines → N+1", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  // [IB11.4]
  it("[IB11.4] trailing newline counts the empty final line", () => {
    expect(countLines("a\n")).toBe(2);
  });
});
