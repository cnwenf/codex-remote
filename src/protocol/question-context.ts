export type QuestionContextRequest = {
  threadId: string;
  turnId: string;
  anchorItemId?: string;
  textOffset?: number;
};

export type QuestionContext = {
  threadId: string;
  turnId: string;
  anchorItemId?: string;
  state: "pending" | "ready" | "not_found" | "error";
  revision: string;
  question?: {
    id: string;
    text: string;
    imageCount: number;
    source: "user" | "delegated";
    sourceThreadId?: string;
    truncated: boolean;
    textOffset: number;
    nextTextOffset?: number;
  };
  message?: string;
};

export function isQuestionContext(value: unknown): value is QuestionContext {
  if (!value || typeof value !== "object") return false;
  const result = value as QuestionContext;
  if (typeof result.threadId !== "string" || typeof result.turnId !== "string" || typeof result.revision !== "string" ||
    !["pending", "ready", "not_found", "error"].includes(result.state) ||
    (result.anchorItemId !== undefined && typeof result.anchorItemId !== "string") ||
    (result.message !== undefined && typeof result.message !== "string")) return false;
  const q = result.question;
  if (!q) return result.state !== "ready";
  return result.state === "ready" && typeof q.id === "string" && typeof q.text === "string" && q.text.length <= 4096 &&
    Number.isSafeInteger(q.imageCount) && q.imageCount >= 0 && ["user", "delegated"].includes(q.source) &&
    (q.sourceThreadId === undefined || typeof q.sourceThreadId === "string") && typeof q.truncated === "boolean" &&
    Number.isSafeInteger(q.textOffset) && q.textOffset >= 0 &&
    (q.nextTextOffset === undefined || Number.isSafeInteger(q.nextTextOffset) && q.nextTextOffset > q.textOffset);
}
