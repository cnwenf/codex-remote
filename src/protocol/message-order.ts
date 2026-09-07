/** Preserve omitted history, repair shared order, then insert missing items at anchors. */
export function mergeMessageOrder(existing: string[], incoming: string[], prepend = false): string[] {
  const known = new Set(existing);
  const incomingIds = new Set(incoming);
  const shared = incoming.filter((id) => known.has(id));
  let sharedIndex = 0;
  const result = existing.map((id) => incomingIds.has(id) ? shared[sharedIndex++] : id);
  let insertAt = prepend ? 0 : result.length;
  for (let index = 0; index < incoming.length; index += 1) {
    const id = incoming[index];
    if (known.has(id)) {
      insertAt = result.indexOf(id) + 1;
      continue;
    }
    const nextAnchor = incoming.slice(index + 1).find((candidate) => known.has(candidate));
    const position = nextAnchor ? result.indexOf(nextAnchor) : insertAt;
    result.splice(position, 0, id);
    known.add(id);
    insertAt = position + 1;
  }
  return result;
}
