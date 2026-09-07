import { isToolActivity, MAX_TOOL_OUTPUT_IMAGES } from "../protocol/tool-content";
import type { ImageUploadStore } from "./image-upload-store";

export const PROJECTED_IMAGE_URL_PREFIX = "codex-remote-image:";

/** The result-image boundary shared by bounded history projection and registration. */
export function mapToolOutputImages(
  item: Record<string, unknown>,
  image: (part: Record<string, unknown>) => Record<string, unknown>,
) {
  if (!isToolActivity(String(item.type ?? ""))) return item;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const part = value as Record<string, unknown>;
    if (part.type === "input_image" || part.type === "image") return image(part);
    return Array.isArray(part.content) ? { ...part, content: visit(part.content) } : value;
  };
  return { ...item, ...Object.fromEntries(["output", "result", "content"]
    .filter((key) => item[key] !== undefined).map((key) => [key, visit(item[key])])) };
}

/** Register declared result images only; never read paths or fetch remote URLs. */
export function registerToolOutputImages(item: Record<string, unknown>, store: ImageUploadStore) {
  if (!isToolActivity(String(item.type ?? ""))) return item;
  const ids: string[] = [];
  let count = 0;
  let incomplete = false;
  const projected = mapToolOutputImages(item, (part) => {
    count++;
    try {
      if (count > MAX_TOOL_OUTPUT_IMAGES) throw new Error("image-count-limit");
      const url = typeof part.image_url === "string" ? part.image_url
        : part.type === "image" && typeof part.data === "string" && part.data.startsWith(PROJECTED_IMAGE_URL_PREFIX)
          ? part.data
        : part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"
          ? `data:${part.mimeType};base64,${part.data}` : "";
      const id = url.startsWith(PROJECTED_IMAGE_URL_PREFIX)
        ? store.referenceForStoredId(url.slice(PROJECTED_IMAGE_URL_PREFIX.length))
        : store.referenceForDataUrl(url);
      if (!id) throw new Error("image-unavailable");
      if (!ids.includes(id)) ids.push(id);
    } catch { incomplete = true; }
    // Image bytes stay in the authenticated store, not in transport/state.
    return { type: part.type };
  });
  return count === 0 ? item : { ...projected,
    toolOutputImageIds: ids, toolOutputImagesIncomplete: incomplete,
  };
}
