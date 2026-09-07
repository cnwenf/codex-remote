import { isToolActivity, MAX_TOOL_OUTPUT_IMAGES } from "../protocol/tool-content";
import type { ImageUploadStore } from "./image-upload-store";

export const PROJECTED_IMAGE_URL_PREFIX = "codex-remote-image:";

/** Register declared result images only; never read paths or fetch remote URLs. */
export function registerToolOutputImages(item: Record<string, unknown>, store: ImageUploadStore) {
  if (!isToolActivity(String(item.type ?? ""))) return item;
  const ids: string[] = [];
  let count = 0;
  let incomplete = false;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const part = value as Record<string, unknown>;
    if (part.type === "input_image" || part.type === "image") {
      count++;
      try {
        if (count > MAX_TOOL_OUTPUT_IMAGES) throw new Error("image-count-limit");
        const url = typeof part.image_url === "string" ? part.image_url
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
    }
    return Array.isArray(part.content) ? { ...part, content: visit(part.content) } : value;
  };
  const fields = Object.fromEntries(["output", "result", "content"].filter((key) => item[key] !== undefined)
    .map((key) => [key, visit(item[key])]));
  return count === 0 ? item : { ...item, ...fields,
    toolOutputImageIds: ids, toolOutputImagesIncomplete: incomplete,
  };
}
