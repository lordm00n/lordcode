import { describe, expect, it } from "vitest";
import {
  composeContent,
  consumedImageIds,
  renderContent,
  type PendingImage,
} from "./compose-message.js";

const png = (base64: string): PendingImage => ({
  base64,
  mimeType: "image/png",
});

const mapOf = (entries: Array<[string, PendingImage]>) =>
  new Map<string, PendingImage>(entries);

describe("composeContent", () => {
  it("[CM1.1] empty image map → returns text unchanged", () => {
    expect(composeContent("hi", new Map())).toBe("hi");
  });

  it("[CM1.2] text with no placeholder → returns plain string even when images exist", () => {
    expect(composeContent("hi", mapOf([["a", png("AAA")]]))).toBe("hi");
  });

  it("[CM1.3] single placeholder, surrounding text on both sides → 3 parts in order", () => {
    const out = composeContent(
      "before [image:image/png#abc] after",
      mapOf([["abc", png("AAA")]]),
    );
    expect(out).toEqual([
      { type: "text", text: "before " },
      { type: "image", image: "AAA", mediaType: "image/png" },
      { type: "text", text: " after" },
    ]);
  });

  it("[CM1.4] image-only message (placeholder == whole input) → single image part", () => {
    const out = composeContent(
      "[image:image/png#abc]",
      mapOf([["abc", png("AAA")]]),
    );
    expect(out).toEqual([
      { type: "image", image: "AAA", mediaType: "image/png" },
    ]);
  });

  it("[CM1.5] two placeholders interleaved with text → preserves order", () => {
    const out = composeContent(
      "x[image:image/png#a]y[image:image/jpeg#b]z",
      mapOf([
        ["a", { base64: "AAA", mimeType: "image/png" }],
        ["b", { base64: "BBB", mimeType: "image/jpeg" }],
      ]),
    );
    expect(out).toEqual([
      { type: "text", text: "x" },
      { type: "image", image: "AAA", mediaType: "image/png" },
      { type: "text", text: "y" },
      { type: "image", image: "BBB", mediaType: "image/jpeg" },
      { type: "text", text: "z" },
    ]);
  });

  it("[CM1.6] placeholder id not in map → leaves the literal placeholder as text", () => {
    expect(
      composeContent(
        "look at [image:image/png#missing]",
        mapOf([["other", png("AAA")]]),
      ),
    ).toBe("look at [image:image/png#missing]");
  });

  it("[CM1.7] mixed resolved + unresolved placeholders → only resolved becomes ImagePart", () => {
    const out = composeContent(
      "[image:image/png#missing][image:image/png#known]",
      mapOf([["known", png("AAA")]]),
    );
    expect(out).toEqual([
      { type: "text", text: "[image:image/png#missing]" },
      { type: "image", image: "AAA", mediaType: "image/png" },
    ]);
  });

  it("[CM1.8] adjacent placeholders → no empty text parts inserted between them", () => {
    const out = composeContent(
      "[image:image/png#a][image:image/png#b]",
      mapOf([
        ["a", png("AAA")],
        ["b", png("BBB")],
      ]),
    );
    expect(out).toEqual([
      { type: "image", image: "AAA", mediaType: "image/png" },
      { type: "image", image: "BBB", mediaType: "image/png" },
    ]);
  });
});

describe("renderContent", () => {
  it("[CM2.1] string content → returns unchanged", () => {
    expect(renderContent("hello")).toBe("hello");
  });

  it("[CM2.2] array content → image parts render as [image:<mime>] placeholder", () => {
    expect(
      renderContent([
        { type: "text", text: "see " },
        { type: "image", image: "AAA", mediaType: "image/png" },
        { type: "text", text: " ok?" },
      ]),
    ).toBe("see [image:image/png] ok?");
  });
});

describe("consumedImageIds", () => {
  it("[CM3.1] returns ids whose placeholder is present AND in the map", () => {
    expect(
      consumedImageIds(
        "[image:image/png#a] x [image:image/png#missing]",
        mapOf([
          ["a", png("AAA")],
          ["b", png("BBB")],
        ]),
      ),
    ).toEqual(["a"]);
  });

  it("[CM3.2] no placeholders → empty list", () => {
    expect(consumedImageIds("hi", mapOf([["a", png("AAA")]]))).toEqual([]);
  });
});
