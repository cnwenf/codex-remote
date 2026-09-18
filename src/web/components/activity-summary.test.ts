import { describe, expect, it } from "vitest";
import { activitySummary } from "./activity-summary";
import { initialCodexState, reduceCodexState } from "../../protocol/thread-store";

describe("Desktop-style activity summary", () => {
  it("never promotes command output deltas into the collapsed summary", () => {
    let state = reduceCodexState(initialCodexState, { method: "item/started", params: {
      threadId: "t", turnId: "turn", item: { id: "tool", type: "commandExecution", command: "pnpm test" },
    } });
    state = reduceCodexState(state, { method: "item/commandExecution/outputDelta", params: {
      threadId: "t", turnId: "turn", itemId: "tool", delta: "PRIVATE_OUTPUT_FIXTURE",
    } });
    expect(activitySummary([state.threads.t.turns.turn.items.tool], true)).toBe("正在运行命令 · pnpm test");
  });
  it("describes the running tool instead of counting tools", () => {
    expect(activitySummary([
      { id: "a", type: "commandExecution", text: "cat README.md", toolInput: "cat README.md", status: "completed" },
      { id: "b", type: "commandExecution", text: "pnpm test", toolInput: "pnpm test", status: "running" },
    ], true)).toBe("正在运行命令 · pnpm test");
  });
  it("summarizes completed action kinds once, not tool counts", () => {
    expect(activitySummary([
      { id: "a", type: "commandExecution", text: "cat README.md", toolInput: "cat README.md" },
      { id: "b", type: "commandExecution", text: "head package.json", toolInput: "head package.json" },
      { id: "c", type: "fileChange", text: "src/app.ts" },
    ], false)).toBe("已读取文件、修改文件");
  });
  it("shows a reasoning headline while preserving full details elsewhere", () => {
    expect(activitySummary([{ id: "a", type: "reasoning", text: "**检查连接恢复**\n详细过程" }], true))
      .toBe("正在思考 · 检查连接恢复");
  });
  it("names a tool without exposing its raw JSON input in the summary", () => {
    expect(activitySummary([{ id: "a", type: "mcpToolCall", text: "browser.search", toolInput: '{"token":"private"}' }], true))
      .toBe("正在调用工具 · browser.search");
  });
  it("does not describe failed or interrupted work as successful", () => {
    expect(activitySummary([{ id: "a", type: "commandExecution", text: "pnpm test", toolInput: "pnpm test", status: "failed" }], false))
      .toBe("执行失败 · 运行命令");
    expect(activitySummary([{ id: "a", type: "commandExecution", text: "pnpm test", toolInput: "pnpm test", status: "running" }], false, "interrupted"))
      .toBe("已停止 · 运行命令");
  });
});
