import { useState } from "react";
import type { MobileLanguage } from "../../mobile/settings-store";
import type { QueuedFollowUp } from "../state/use-codex";

type QueuedFollowUpsProps = {
  messages: QueuedFollowUp[];
  onSteer: (messageId: string) => Promise<void> | void;
  language?: MobileLanguage;
};

export function QueuedFollowUps({ messages, onSteer, language = "zh-CN" }: QueuedFollowUpsProps) {
  const en = language === "en";
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  if (messages.length === 0) return null;

  async function steer(messageId: string) {
    if (busyId) return;
    setBusyId(messageId);
    setError(undefined);
    try {
      await onSteer(messageId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : en ? "Failed to steer message" : "转为引导失败");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="queued-followups" aria-label={en ? "Queued messages" : "排队消息"}>
      <header>
        <strong>{en ? "Queued messages" : "排队消息"}</strong>
        <span>{messages.length}</span>
      </header>
      <div className="queued-followups-list">
        {messages.map((message) => (
          <article key={message.id}>
            <p>{message.text || (en ? "Image message" : "图片消息")}</p>
            <button
              type="button"
              onClick={() => void steer(message.id)}
              disabled={Boolean(busyId)}
            >
              {busyId === message.id ? (en ? "Working…" : "处理中…") : (en ? "Steer now" : "转为引导")}
            </button>
          </article>
        ))}
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
