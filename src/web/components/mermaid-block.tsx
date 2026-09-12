import { isValidElement, useEffect, useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

// Loaded only when a Mermaid fence is present; bundled for offline native use.
let renderer: Promise<typeof import("mermaid")["default"]> | undefined;
function loadRenderer() {
  return renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, maxTextSize: 50_000,
      theme: "default", htmlLabels: false,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "themeCSS"],
    });
    return mermaid;
  }).catch(error => { renderer = undefined; throw error; });
}

// Parsing and rendering share Mermaid's configuration. Keep the check in the
// same queue as rendering, and reject image nodes before they start downloads.
let renderQueue = Promise.resolve();
function renderDiagram(id: string, text: string) {
  const result = renderQueue.then(async () => {
    if (text.length > 50_000) throw new Error("diagram-source-too-large");
    const mermaid = await loadRenderer();
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
    const db = diagram.db as { getVertices?: () => Map<string, { img?: unknown; icon?: unknown }> };
    if (db.getVertices && [...db.getVertices().values()].some(node => node.img || node.icon)) {
      throw new Error("unsupported-diagram-image-node");
    }
    return mermaid.render(id, text);
  });
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  if (isValidElement<{className?: string; children?: ReactNode}>(children) &&
      children.props.className?.split(/\s+/).includes("language-mermaid")) {
    return <MermaidBlock text={String(children.props.children ?? "").trimEnd()} />;
  }
  return <pre {...props}>{children}</pre>;
}

function MermaidBlock({ text }: { text: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [result, setResult] = useState<{ text: string; source?: string; failed?: boolean }>();
  useEffect(() => {
    let disposed = false;
    // A streamed fence may be incomplete. Retry when its source changes.
    const timer = setTimeout(() => {
      void renderDiagram(id, text).then(({ svg }) => {
        if (!disposed) setResult({ text, source: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      }).catch(() => { if (!disposed) setResult({ text, failed: true }); });
    }, 150);
    return () => { disposed = true; clearTimeout(timer); };
  }, [id, text]);
  const current = result?.text === text ? result : undefined;
  return <div className="mermaid-block">
    {current?.source ? <img src={current.source} alt="Mermaid 图表"
      onError={() => setResult({ text, failed: true })} /> : <>
      <span>{current?.failed ? "图表暂无法渲染，显示源码" : "正在渲染图表…"}</span>
      <pre><code>{text}</code></pre>
    </>}
  </div>;
}
