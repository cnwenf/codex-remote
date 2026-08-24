import type { MobileTask } from "./types";

export type CompletedTask = MobileTask & { completion: "completed" | "failed" };

export function compareTaskStatus(previous: MobileTask[], current: MobileTask[]) {
  const previousById = new Map(previous.map((thread) => [thread.id, thread]));
  return current.flatMap<CompletedTask>((thread) => {
    if (previousById.get(thread.id)?.status !== "running" || thread.status === "running") return [];
    if (thread.status !== "idle" && thread.status !== "error") return [];
    return [{ ...thread, completion: thread.status === "error" ? "failed" : "completed" }];
  });
}

export function summarizeRunningTasks(threads: MobileTask[]) {
  const running = threads.filter((thread) => thread.status === "running");
  if (running.length === 0) return undefined;
  return {
    title: `${running.length} 个对话运行中`,
    body: running.slice(0, 3).map((thread) => thread.title).join("、") +
      (running.length > 3 ? ` 等 ${running.length} 个` : ""),
    threadIds: running.map((thread) => thread.id),
  };
}
