export const MAX_TRANSFER_IMAGE_BYTES = 1_000_000;
export const MAX_SELECTABLE_IMAGE_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_TRANSFER_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
