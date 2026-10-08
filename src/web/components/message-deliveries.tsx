import { useState } from "react";
import type { MessageDelivery } from "../../protocol/message-delivery";
import type { MobileLanguage } from "../../mobile/settings-store";

export function MessageDeliveries({ messages, onRetry, language = "zh-CN" }: {
  messages: MessageDelivery[];
  onRetry: (id: string) => Promise<void>;
  language?: MobileLanguage;
}) {
  const en = language === "en";
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  if (!messages.length) return null;
  async function retry(id: string) {
    if (busyId) return;
    setBusyId(id); setError(undefined);
    try { await onRetry(id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "重试失败"); }
    finally { setBusyId(undefined); }
  }
  return <section className="queued-followups message-deliveries" aria-label={en ? "Message delivery" : "消息发送状态"}>
    <div className="queued-followups-list">{messages.map((message) => <article key={message.id}>
      <p>{message.text || (message.operation === "promote"
        ? en ? "Queued message" : "排队消息" : en ? "Image message" : "图片消息")}</p>
      <span className="delivery-status" role="status">{message.status === "accepted"
        ? en ? "Server received it, sending…" : "服务端已接收，正在发送…"
        : message.status === "uncertain"
          ? en ? "Delivery not confirmed. Check the conversation before resending." : "发送结果待确认，请先查看会话，避免重复发送。"
          : en ? "Delivery failed" : "发送失败"}</span>
      {message.status === "failed" ? <button type="button" disabled={Boolean(busyId)} onClick={() => void retry(message.id)}>
        {en ? "Retry" : "重试发送"}
      </button> : null}
      {message.error ? <p className="inline-error">{message.error}</p> : null}
    </article>)}</div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </section>;
}
