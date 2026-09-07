export const TOOL_TEXT_LIMIT = 16_384;
export const MAX_PENDING_TOOL_OUTPUTS = 64;
export const MAX_TOOL_OUTPUT_IMAGES = 16;
export type PendingToolOutput = ToolDetails & { id: string; turnId?: string };

export type ToolDetails = {
  toolInput?: string;
  toolOutput?: string;
  toolInputTruncated?: boolean;
  toolOutputTruncated?: boolean;
  toolInputLength?: number;
  toolOutputLength?: number;
  toolOutputImageIds?: string[];
  toolOutputImagesIncomplete?: boolean;
};

export function isToolActivity(type: string) {
  return /command|tool|function_call/i.test(type);
}

export function boundedToolText(text: string) {
  return { text: text.slice(0, TOOL_TEXT_LIMIT), truncated: text.length > TOOL_TEXT_LIMIT, length: text.length };
}

function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.text === "string") return part.text;
    return "[非文本结果]";
  }).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image" || record.type === "audio" || record.type === "resource") return "[非文本结果]";
    if (record.content !== undefined || record.structuredContent !== undefined) {
      return [resultText(record.content), resultText(record.structuredContent)].filter((part) => part !== undefined).join("\n");
    }
  }
  return JSON.stringify(value, (key, entry) =>
    /^(data|blob|base64)$/i.test(key) || (typeof entry === "string" && /^data:[^,]+;base64,/.test(entry))
      ? "[非文本结果]" : entry, 2);
}

export function toolDetailsFromProtocol(item: Record<string, unknown>): ToolDetails {
  if (!isToolActivity(String(item.type ?? "")) && item.toolInput === undefined && item.toolOutput === undefined) return {};
  const inputValue = item.toolInput ?? item.command ?? item.arguments ?? item.input;
  const input = inputValue == null ? undefined : typeof inputValue === "string" ? inputValue : JSON.stringify(inputValue, null, 2);
  const result = resultText(item.toolOutput ?? item.aggregatedOutput ?? item.output ?? item.result ?? item.content);
  const error = resultText(item.error);
  const output = result === undefined ? error : error ? `${result}\n${error}` : result;
  const inputTruncated = item.toolInputTruncated === true || item.inputTruncated === true;
  const outputTruncated = item.toolOutputTruncated === true || item.outputTruncated === true;
  const rawInputLength = item.toolInputLength ?? item.inputLength;
  const rawOutputLength = item.toolOutputLength ?? item.outputLength;
  const inputLength = typeof rawInputLength === "number" && Number.isFinite(rawInputLength)
    ? Math.max(input?.length ?? 0, rawInputLength) : inputTruncated ? undefined : input?.length;
  const outputLength = typeof rawOutputLength === "number" && Number.isFinite(rawOutputLength)
    ? Math.max(output?.length ?? 0, rawOutputLength) : outputTruncated ? undefined : output?.length;
  return {
    ...(input !== undefined ? { toolInput: input.slice(0, TOOL_TEXT_LIMIT), toolInputTruncated: inputTruncated || input.length > TOOL_TEXT_LIMIT, toolInputLength: inputLength } : {}),
    ...(output !== undefined ? {
      toolOutput: output.slice(0, TOOL_TEXT_LIMIT),
      toolOutputTruncated: outputTruncated || output.length > TOOL_TEXT_LIMIT,
      toolOutputLength: outputLength,
      ...(Array.isArray(item.toolOutputImageIds) ? {
        toolOutputImageIds: [...new Set(item.toolOutputImageIds.filter((id): id is string => typeof id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))].slice(0, MAX_TOOL_OUTPUT_IMAGES),
        toolOutputImagesIncomplete: item.toolOutputImagesIncomplete === true || item.toolOutputImageIds.length > MAX_TOOL_OUTPUT_IMAGES,
      } : {}),
    } : {}),
  };
}
