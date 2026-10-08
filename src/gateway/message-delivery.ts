import type { MessageDelivery, MessageOperation } from "../protocol/message-delivery";

type Submission = { id: string; operation: MessageOperation; params: Record<string, unknown> };
type Job = { submission: Submission; receipt: MessageDelivery; queuedMessageId?: string };
const METHODS = { start: "turn/start", steer: "turn/steer", queue: "desktop/queue/add",
  guide: "desktop/queue/add", promote: "desktop/queue/steer" } as const;

// Server-owned work survives closing/replacing every client connection. The
// bounded receipt cache is process-local; it does not promise gateway restart recovery.
export class MessageDeliveries {
  private readonly jobs = new Map<string, Job>();
  private readonly threads = new Map<string, Promise<void>>();

  constructor(
    private readonly request: (method: string, params: unknown) => Promise<unknown>,
    private readonly updated: (receipt: MessageDelivery) => void,
  ) {}

  snapshots() { return [...this.jobs.values()].map((job) => ({ ...job.receipt })); }

  submit(submission: Submission): MessageDelivery {
    const previous = this.jobs.get(submission.id);
    if (previous) {
      if (JSON.stringify(previous.submission) !== JSON.stringify(submission)) {
        throw new Error("消息标识已被另一条消息使用");
      }
      return { ...previous.receipt };
    }
    if ([...this.jobs.values()].filter((job) => job.receipt.status === "accepted").length >= 64) {
      throw new Error("待发送消息过多，请稍后重试");
    }
    while (this.jobs.size >= 256) {
      const oldest = [...this.jobs].find(([, job]) => job.receipt.status !== "accepted");
      if (!oldest) throw new Error("待发送消息过多，请稍后重试");
      this.jobs.delete(oldest[0]);
    }
    const params = submission.params;
    const text = typeof params.text === "string" ? params.text : (params.input as Record<string, unknown>[] | undefined)
      ?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
    const now = Date.now();
    const job: Job = { submission, receipt: {
      id: submission.id, threadId: params.threadId as string, operation: submission.operation,
      status: "accepted", text, createdAt: now, updatedAt: now, revision: 0,
      ...(typeof params.messageId === "string" ? { messageId: params.messageId } : {}),
    } };
    this.jobs.set(submission.id, job);
    this.schedule(job);
    return { ...job.receipt };
  }

  retry(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.receipt.status !== "failed") throw new Error("只可重试已确认失败的消息");
    job.receipt = { ...job.receipt, status: "accepted", error: undefined, updatedAt: Date.now(), revision: job.receipt.revision + 1 };
    this.updated({ ...job.receipt });
    this.schedule(job);
    return { ...job.receipt };
  }

  private schedule(job: Job) {
    const threadId = job.receipt.threadId;
    // Serialize one thread's sends, while other threads remain independent.
    const work = (this.threads.get(threadId) ?? Promise.resolve()).then(async () => {
      const { operation, params } = job.submission;
      try {
        if (operation === "guide") {
          if (!job.queuedMessageId) {
            const result = await this.request(METHODS.guide, params) as { message?: { id?: string } };
            if (!result.message?.id) throw new Error("服务端未返回排队消息标识");
            job.queuedMessageId = result.message.id;
            job.receipt = { ...job.receipt, messageId: result.message.id, updatedAt: Date.now(), revision: job.receipt.revision + 1 };
            this.updated({ ...job.receipt });
          }
          await this.request(METHODS.promote, {
            threadId, messageId: job.queuedMessageId, expectedTurnId: params.expectedTurnId,
          });
        } else await this.request(METHODS[operation], params);
        job.receipt = { ...job.receipt, status: "delivered", updatedAt: Date.now(), revision: job.receipt.revision + 1 };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : "消息发送失败";
        // An absent response is not proof of failure: never retry ambiguous work
        // automatically, which could send the same user instruction twice.
        const uncertain = /timeout|disconnect|could not confirm|interrupted|stopping/i.test(error) ||
          (cause as { rpcCode?: number } | undefined)?.rpcCode === -32003;
        job.receipt = { ...job.receipt, status: uncertain ? "uncertain" : "failed", error, updatedAt: Date.now(), revision: job.receipt.revision + 1 };
      }
      this.updated({ ...job.receipt });
    });
    this.threads.set(threadId, work);
    void work.finally(() => {
      if (this.threads.get(threadId) === work) this.threads.delete(threadId);
    });
  }
}

export function messageSubmission(value: unknown): Submission {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
    ? record.params as Record<string, unknown> : {};
  if (typeof record.id !== "string" || !record.id || record.id.length > 160 ||
      typeof record.operation !== "string" || !Object.hasOwn(METHODS, record.operation) ||
      typeof params.threadId !== "string" || !params.threadId.trim()) throw new Error("无效的消息提交");
  if (record.operation === "promote") {
    if (typeof params.messageId !== "string" || !params.messageId) throw new Error("缺少排队消息标识");
  } else if (!Array.isArray(params.input) || !params.input.length || params.input.some((item) => {
    if (!item || typeof item !== "object") return true;
    const part = item as Record<string, unknown>;
    return part.type === "text" ? typeof part.text !== "string" : part.type !== "remoteImage";
  }) || !params.input.some((item) => item.type === "remoteImage" || item.text.trim())) {
    throw new Error("请输入消息或添加图片");
  }
  return { id: record.id, operation: record.operation as MessageOperation, params };
}
