const imageEnvelopePattern = /<image\b[\s\S]*?<\/image>/gi;
const standaloneImageTagPattern = /<image\b[^>]*>/gi;
const requestMarkerPattern = /(?:^|\n)#{1,3}\s*My request:\s*/i;

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

function normalizeAttachedUserInput(value: string) {
  const marker = requestMarkerPattern.exec(value);
  const request = marker ? value.slice((marker.index ?? 0) + marker[0].length) : value;
  return normalizeWhitespace(
    request
      .replace(imageEnvelopePattern, " ")
      .replace(standaloneImageTagPattern, " "),
  );
}

function containsAttachmentEnvelope(value: string) {
  return /<image\b/i.test(value) || requestMarkerPattern.test(value);
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
