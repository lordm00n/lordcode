import { describe, expect, it } from "vitest";
import type {
  ReadFileImageOutput,
  ReadFileTextOutput,
} from "./schema.js";
import { toModelOutput } from "./tool.js";

const baseText = (over: Partial<ReadFileTextOutput> = {}): ReadFileTextOutput => ({
  kind: "text",
  path: "/abs/path/file.ts",
  content: "     1|hello\n     2|world\n",
  startLine: 1,
  endLine: 2,
  totalLines: 2,
  truncated: false,
  lineTruncated: false,
  ...over,
});

const baseImage = (
  over: Partial<ReadFileImageOutput> = {},
): ReadFileImageOutput => ({
  kind: "image",
  path: "/abs/path/img.png",
  mediaType: "image/png",
  byteSize: 1234,
  base64: "QUJDRA==",
  ...over,
});

describe("toModelOutput — text branch", () => {
  it("[UT-6.1] renders header + numbered content as a single text block", () => {
    const out = toModelOutput(baseText());
    expect(out.type).toBe("text");
    if (out.type !== "text") return;
    expect(out.value).toBe(
      "<file: /abs/path/file.ts [lines 1-2 of 2]>\n     1|hello\n     2|world\n",
    );
  });

  it("[UT-6.2] flags `more available` when truncated=true", () => {
    const out = toModelOutput(
      baseText({
        endLine: 50,
        totalLines: 200,
        truncated: true,
      }),
    );
    if (out.type !== "text") throw new Error("expected text");
    expect(out.value).toContain("more available");
    expect(out.value).toContain("lines 1-50 of 200");
  });

  it("[UT-6.3] flags `some lines truncated` when lineTruncated=true", () => {
    const out = toModelOutput(baseText({ lineTruncated: true }));
    if (out.type !== "text") throw new Error("expected text");
    expect(out.value).toContain("some lines truncated");
  });

  it("[UT-6.4] both flags are joined with a comma", () => {
    const out = toModelOutput(
      baseText({
        truncated: true,
        lineTruncated: true,
        endLine: 50,
        totalLines: 200,
      }),
    );
    if (out.type !== "text") throw new Error("expected text");
    expect(out.value).toContain("more available, some lines truncated");
  });
});

describe("toModelOutput — image branch", () => {
  it("[UT-6.5] returns a content array with text caption + file-data part", () => {
    const out = toModelOutput(baseImage());
    expect(out.type).toBe("content");
    if (out.type !== "content") return;
    expect(out.value).toHaveLength(2);

    const [textPart, dataPart] = out.value;
    expect(textPart).toEqual({
      type: "text",
      text: "<image: /abs/path/img.png (image/png, 1234 bytes)>",
    });
    expect(dataPart).toEqual({
      type: "file-data",
      data: "QUJDRA==",
      mediaType: "image/png",
    });
  });

  it("[UT-6.6] preserves base64 payload and media type without transformation", () => {
    const out = toModelOutput(
      baseImage({ mediaType: "image/jpeg", base64: "ZGVtbw==" }),
    );
    if (out.type !== "content") throw new Error("expected content");
    expect(out.value[1]).toEqual({
      type: "file-data",
      data: "ZGVtbw==",
      mediaType: "image/jpeg",
    });
  });
});
