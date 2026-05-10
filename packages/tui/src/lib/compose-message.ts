/**
 * Translate the TUI's input-line representation of a message back into a
 * shared-layer `ChatMessage.content`.
 *
 * Pasted images aren't kept inline in the input string — see `App.tsx` for the
 * out-of-band rationale. Instead, each pasted image leaves a tiny placeholder
 * `[image:<mime>#<id>]` in the input, with the actual bytes living in a Map
 * keyed by `id`. At send time we walk the input, swap each known placeholder
 * for the corresponding image part, and yield either:
 *
 * - a plain `string`, if no placeholder resolved (preserves the existing
 *   text-only wire format for unchanged turns), or
 * - a `ContentPart[]` interleaving text and image parts in input order.
 *
 * Unresolved placeholders (id not in the map) are left as literal text so a
 * user typing `[image:image/png#whatever]` by hand stays as text.
 */
import type { ContentPart, ImagePart } from "@lordcode/shared";

/**
 * Minimal shape we need from an entry in `pendingImagesRef`. Kept structural
 * (not nominal) so callers can pass `PastedImage` from `clipboard-image.ts`
 * directly without an adapter.
 */
export interface PendingImage {
  base64: string;
  mimeType: string;
}

/**
 * Matches `[image:<mime>#<id>]`. `mime` allows `/`, `.`, `+`, `-`; `id` is
 * the random token produced by `App.tsx` so we keep its alphabet narrow.
 */
const PLACEHOLDER_RE = /\[image:([a-zA-Z0-9./+-]+)#([a-zA-Z0-9-]+)\]/g;

export function composeContent(
  text: string,
  images: ReadonlyMap<string, PendingImage>,
): string | ContentPart[] {
  if (images.size === 0) return text;

  const parts: ContentPart[] = [];
  let cursor = 0;
  let resolvedAny = false;

  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const id = m[2];
    if (id == null) continue;
    const img = images.get(id);
    if (img == null) continue;

    resolvedAny = true;
    const idx = m.index ?? 0;
    if (idx > cursor) {
      parts.push({ type: "text", text: text.slice(cursor, idx) });
    }
    const imagePart: ImagePart = {
      type: "image",
      image: img.base64,
      mediaType: img.mimeType,
    };
    parts.push(imagePart);
    cursor = idx + m[0].length;
  }

  if (!resolvedAny) return text;
  if (cursor < text.length) {
    parts.push({ type: "text", text: text.slice(cursor) });
  }

  // Drop empty text parts (e.g. when an image placeholder sits at a boundary).
  const cleaned = parts.filter(
    (p) => p.type !== "text" || p.text.length > 0,
  );

  // Edge case: the whole message was unresolved placeholders. Fall back to
  // the raw text rather than emit an empty array.
  if (cleaned.length === 0) return text;
  // Single text part collapses back to a string for wire compactness.
  if (cleaned.length === 1) {
    const only = cleaned[0];
    if (only && only.type === "text") return only.text;
  }
  return cleaned;
}

/**
 * Render any `ChatMessage.content` value as a single string for in-TUI display.
 * Image parts collapse to a `[image:<mime>]` placeholder so users can see
 * where the image was attached without dumping base64 into the viewport.
 */
export function renderContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : `[image:${p.mediaType}]`))
    .join("");
}

/**
 * Collect the placeholder ids actually consumed by `composeContent` for a
 * given input. Useful for pruning the pending-images map after a successful
 * send (we want to keep images whose placeholder the user accidentally
 * deleted from the input — they may re-type and use them again).
 */
export function consumedImageIds(
  text: string,
  images: ReadonlyMap<string, PendingImage>,
): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const id = m[2];
    if (id != null && images.has(id)) ids.push(id);
  }
  return ids;
}
