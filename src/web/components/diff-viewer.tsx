export function DiffViewer({ diff, maxChars = 200_000 }: { diff: string; maxChars?: number }) {
  const truncated = diff.length > maxChars;
  const visible = truncated ? diff.slice(0, maxChars) : diff;

  return (
    <div className="diff-viewer">
      <pre aria-label="Unified diff">
        <code>
          {visible.split("\n").map((line, index) => (
            <span className={lineClass(line)} key={`${index}-${line.slice(0, 20)}`}>
              {line || " "}{"\n"}
            </span>
          ))}
        </code>
      </pre>
      {truncated ? <p className="diff-truncated">Diff truncated for display</p> : null}
    </div>
  );
}

function lineClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-file";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-delete";
  if (line.startsWith("@@")) return "diff-hunk";
  return "diff-context";
}
