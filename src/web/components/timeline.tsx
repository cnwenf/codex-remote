import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodexItem, CodexThread, CodexTurn } from "../../protocol/thread-store";

export function Timeline({ thread }: { thread?: CodexThread }) {
  if (!thread) {
    return (
      <div className="empty-thread">
        <span aria-hidden="true">⌁</span>
        <h2>选择一个对话</h2>
        <p>查看运行状态、执行过程和最终回复。</p>
      </div>
    );
  }

  if (thread.turnOrder.length === 0) {
    return (
      <div className="empty-thread">
        <span aria-hidden="true">↗</span>
        <h2>可以开始了</h2>
        <p>在下方输入第一条指令。</p>
      </div>
    );
  }

  return (
    <ol className="timeline" aria-label="对话内容">
      {thread.turnOrder.map((turnId) => {
        const turn = thread.turns[turnId];
        return turn ? <TurnView key={turnId} turn={turn} /> : null;
      })}
    </ol>
  );
}

function TurnView({ turn }: { turn: CodexTurn }) {
  const items = turn.itemOrder.map((id) => turn.items[id]).filter(Boolean);
  const userMessages = items.filter((item) => item.type.toLocaleLowerCase().includes("user"));
  const agentMessages = items.filter((item) => item.type.toLocaleLowerCase().includes("agentmessage"));
  const activities = items.filter((item) => !userMessages.includes(item) && !agentMessages.includes(item));

  return (
    <li className="conversation-turn" data-turn-id={turn.id}>
      {userMessages.map((item) => (
        <article key={item.id} className="message message-user">
          <span className="message-author">你</span>
          <MarkdownContent text={item.text || "等待输入…"} />
          {item.imageIds?.length ? (
            <div className="message-images">
              {item.imageIds.map((imageId, index) => (
                <img
                  key={`${imageId}-${index}`}
                  src={`/api/images/${encodeURIComponent(imageId)}`}
                  alt={`用户上传的图片 ${index + 1}`}
                  loading="lazy"
                />
              ))}
            </div>
          ) : null}
        </article>
      ))}

      {activities.length > 0 ? (
        <details className="activity-group" open={turn.status === "inProgress" || undefined}>
          <summary>
            <span className={`run-indicator run-${turn.status}`} aria-hidden="true" />
            <span>执行过程（{activities.length} 项）</span>
            <span className="activity-duration">{formatDuration(turn.durationMs)}</span>
          </summary>
          <ol className="activity-list">
            {activities.map((item) => <ActivityItem key={item.id} item={item} />)}
          </ol>
        </details>
      ) : turn.status === "inProgress" ? (
        <div className="turn-running" role="status">
          <span className="run-indicator run-inProgress" aria-hidden="true" />
          Codex 正在运行
        </div>
      ) : null}

      {agentMessages.map((item) => (
        <article key={item.id} className="message message-agent">
          <span className="message-author">Codex</span>
          <MarkdownContent text={item.text || "等待输出…"} />
        </article>
      ))}

      {agentMessages.length === 0 && turn.status === "inProgress" ? (
        <article className="message message-agent message-pending" aria-label="Codex 正在回复">
          <span className="message-author">Codex</span>
          <p>正在处理…</p>
        </article>
      ) : null}
    </li>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function ActivityItem({ item }: { item: CodexItem }) {
  return (
    <li>
      <span className="activity-icon" aria-hidden="true">{iconForType(item.type)}</span>
      <span className="activity-copy">
        <strong>{labelForType(item.type)}</strong>
        <span>{item.text || "等待结果…"}</span>
      </span>
      {item.status ? <span className="activity-status">{statusLabel(item.status)}</span> : null}
    </li>
  );
}

function labelForType(type: string) {
  const value = type.toLocaleLowerCase();
  if (value.includes("reason")) return "思考";
  if (value.includes("command")) return "运行命令";
  if (value.includes("file")) return "文件变更";
  if (value.includes("websearch")) return "网页搜索";
  if (value.includes("mcp") || value.includes("tool")) return "调用工具";
  if (value.includes("plan")) return "更新计划";
  if (value.includes("compaction")) return "整理上下文";
  return type.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function iconForType(type: string) {
  const value = type.toLocaleLowerCase();
  if (value.includes("command")) return ">";
  if (value.includes("file")) return "±";
  if (value.includes("search")) return "⌕";
  if (value.includes("reason")) return "·";
  return "•";
}

function statusLabel(status: string) {
  if (status === "completed") return "完成";
  if (status === "running" || status === "inProgress") return "运行中";
  if (status === "failed") return "失败";
  return status;
}

function formatDuration(value?: number) {
  if (value === undefined) return "";
  if (value < 1_000) return `${value} 毫秒`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
