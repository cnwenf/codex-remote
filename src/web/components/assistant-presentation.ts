type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** Only transform top-level machine envelopes; quoted/code examples remain literal. */
export function remarkAssistantPresentation() {
  return (tree: { children: MarkdownNode[] }) => {
    tree.children = tree.children.flatMap((node) => {
      if (node.type !== "html" || !node.value) return [node];
      const value = node.value.trim();
      if (/^<oai-mem-citation>[\s\S]*<\/oai-mem-citation>$/.test(value)) return [];
      if (/^<heartbeat>[\s\S]*<\/heartbeat>$/.test(value)) {
        const message = /<message>([\s\S]*?)<\/message>/.exec(value)?.[1];
        if (message?.trim()) return [{ type: "paragraph", children: [{ type: "text", value: message.trim() }] }];
      }
      return [node];
    });
  };
}
