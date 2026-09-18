import type { CodexItem, CodexTurn } from "../../protocol/thread-store";

export function activitySummary(items: CodexItem[], running: boolean, turnStatus?: CodexTurn["status"]) {
  if (running) {
    const item = [...items].reverse().find((item) => item.status === "running" || item.status === "inProgress") ?? items.at(-1);
    if (!item) return "正在处理";
    const action = actionForItem(item);
    // Command text accumulates outputDelta. Only its separate input is a title.
    const title = /command/i.test(item.type) ? item.toolInput ?? "" : item.text;
    const detail = title.split("\n").find((line) => line.trim())?.replace(/^[#*\s]+|[*\s]+$/g, "").slice(0, 120);
    return `正在${action}${detail ? ` · ${detail}` : ""}`;
  }
  const actions = [...new Set(items.map(actionForItem))].join("、");
  if (items.some((item) => item.status === "failed")) return `执行失败 · ${actions}`;
  if (turnStatus === "interrupted") return `已停止 · ${actions}`;
  if (turnStatus === "failed") return `执行中断 · ${actions}`;
  return `已${actions || "处理"}`;
}

function actionForItem(item: CodexItem) {
  const type = item.type.replace(/[_-]/g, "").toLowerCase();
  if (type.includes("reason")) return "思考";
  if (type.includes("command")) {
    const command = (item.toolInput ?? "").trim();
    if (/^(cat|head|tail|less|sed)\s/.test(command)) return "读取文件";
    if (/^(rg|grep|find)\s/.test(command)) return "搜索文件";
    if (/^ls(?:\s|$)/.test(command)) return "浏览文件";
    return "运行命令";
  }
  if (type.includes("file") || type === "customtoolcall" && /apply_patch/.test(item.text)) return "修改文件";
  if (type.includes("websearch")) return "搜索网页";
  if (type.includes("imageview")) return "查看图片";
  if (type.includes("imagegeneration")) return "生成图片";
  if (type.includes("plan")) return "更新计划";
  if (type.includes("compaction")) return "整理上下文";
  if (type.includes("tool") || type.includes("functioncall")) return "调用工具";
  return "处理任务";
}
