const imageEnvelopePattern = /<image\b[\s\S]*?<\/image>/gi;
const standaloneImageTagPattern = /<image\b[^>]*>/gi;
const standaloneImageClosingTagPattern = /<\/image>/gi;
const requestMarkerPattern = /(?:^|\n)#{1,3}\s*My request:\s*/i;

type UserItemIdentity = { id: string; itemIdAliases?: readonly string[]; clientMessageId?: string };

// Aliases belong to one item in one turn, and only come from confirmed merges.
export function userMessageAliases(id: string, ...items: UserItemIdentity[]) {
  const aliases = [...new Set(items.flatMap(item => [...(item.itemIdAliases ?? []), item.id]))]
    .filter(alias => alias !== id);
  // ponytail: eight historical representations per item; no global identity cache.
  return aliases.length ? aliases.slice(-8) : undefined;
}

export function userMessageHasIdentity(item: UserItemIdentity, id: string, clientMessageId?: string) {
  return !(clientMessageId && item.clientMessageId && clientMessageId !== item.clientMessageId) &&
    (item.id === id || item.itemIdAliases?.includes(id) === true);
}

export function sameUserInput(
  leftText: string,
  rightText: string,
  leftHasImages = false,
  rightHasImages = false,
) {
  const left = normalizeWhitespace(leftText);
  const right = normalizeWhitespace(rightText);
  if (left === right) return true;
  if (!leftHasImages && !rightHasImages && !containsAttachmentEnvelope(leftText) && !containsAttachmentEnvelope(rightText)) {
    return false;
  }
  return normalizeAttachedUserInput(leftText) === normalizeAttachedUserInput(rightText);
}

// Missing attachment metadata is unknown; known, different images cannot confirm each other.
export function compatibleUserImages(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  return !left?.length || !right?.length || (
    left.length === right.length && left.every((imageId, index) => imageId === right[index])
  );
}

export function displayUserInput(value: string) {
  const marker = requestMarkerPattern.exec(value);
  const request = marker ? value.slice((marker.index ?? 0) + marker[0].length) : value;
  return request
    .replace(imageEnvelopePattern, "")
    .replace(standaloneImageTagPattern, "")
    .replace(standaloneImageClosingTagPattern, "")
    .trim();
}

function normalizeAttachedUserInput(value: string) {
  const marker = requestMarkerPattern.exec(value);
  const request = marker ? value.slice((marker.index ?? 0) + marker[0].length) : value;
  return normalizeWhitespace(
    request
      .replace(imageEnvelopePattern, " ")
      .replace(standaloneImageTagPattern, " ")
      .replace(standaloneImageClosingTagPattern, " "),
  );
}

function containsAttachmentEnvelope(value: string) {
  return /<image\b/i.test(value) || requestMarkerPattern.test(value);
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
