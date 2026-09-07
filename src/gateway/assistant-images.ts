import type { ImageUploadStore } from "./image-upload-store";
import { fileURLToPath } from "node:url";
import Markdown from "react-markdown";

type ImageNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: ImageNode[] };

export function registerAssistantImages(text: string, store: ImageUploadStore): Record<string, string> {
  const images: Record<string, string> = {};
  if (!text.includes("![")) return images;
  const sources = new Set<string>();
  function collect(node: ImageNode) {
    if (node.tagName === "img" && typeof node.properties?.src === "string") sources.add(node.properties.src);
    node.children?.forEach(collect);
  }
  // Reuse the renderer's parser: links, code and raw HTML are not image nodes.
  Markdown({ children: text, rehypePlugins: [() => collect], allowedElements: [] });
  for (const source of sources) {
    let path: string;
    try {
      if (source.startsWith("file:")) {
        const url = new URL(source);
        if (url.hostname && url.hostname !== "localhost") continue;
        if (url.search || url.hash) continue;
        path = fileURLToPath(url);
      } else if (source.startsWith("/") && !source.startsWith("//")) {
        path = decodeURIComponent(source);
      } else continue;
      const id = store.referenceForPath(path);
      if (id) images[source] = id;
    } catch { /* Unsupported or unavailable local image: the UI shows a failure. */ }
  }
  return images;
}
