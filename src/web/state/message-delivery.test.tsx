import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexSocket, type BrowserSocket } from "../api/socket";
import { useCodex } from "./use-codex";

class ClientSocket implements BrowserSocket {
  readonly OPEN = 1;
  readyState = 1;
  onopen = null;
  onclose: (() => void) | null = null;
  onerror = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
  emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  constructor() { queueMicrotask(() => this.emit({ type: "session", state: "ready", transport: "desktop-live", messageDelivery: true })); }
}

describe("async message client", () => {
  it.each([false, true])("submits an idle/running message once and releases the composer on receipt (running: %s)", async (running) => {
    const client = new ClientSocket();
    const socket = new CodexSocket(() => client);
    const thread = { id: "t1", title: "Task", status: running ? "active" : "idle", turns: running
      ? [{ id: "active", status: "inProgress", items: [] }] : [] };
    const request = vi.spyOn(socket, "request").mockImplementation(async (method, params) => {
      if (method === "thread/list") return { data: [thread] };
      if (method === "desktopState/listThreads") return { data: [thread] };
      if (method === "desktopState/readThread" || method === "thread/resume") return { desktopMirror: true, thread };
      if (method === "desktop/queue/list") return { messages: [] };
      if (method === "gateway/message/submit") {
        const submission = params as { id: string; operation: string };
        return { id: submission.id, operation: submission.operation, threadId: "t1", status: "accepted",
          text: "Keep going", createdAt: 1, updatedAt: 1, revision: 0 };
      }
      return new Promise(() => {});
    });
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("test-token"));
      await act(() => result.current.refreshThreads());
      await act(() => result.current.selectThread("t1"));
      let done = false;
      act(() => { void result.current.sendInstruction("Keep going", [], "steer").then(() => { done = true; }); });
      await waitFor(() => expect(done).toBe(true));
      expect(request).toHaveBeenCalledWith("gateway/message/submit", expect.objectContaining({
        operation: running ? "guide" : "start", params: expect.objectContaining({ threadId: "t1" }),
      }));
      expect(request.mock.calls.some(([method]) => ["desktop/queue/add", "desktop/queue/steer", "turn/start"].includes(method))).toBe(false);
      const submission = request.mock.calls.find(([method]) => method === "gateway/message/submit")![1] as { id: string };
      const receipt = { id: submission.id, threadId: "t1", operation: running ? "guide" : "start", text: "Keep going",
        status: "delivered", createdAt: 1, updatedAt: 1, revision: 2 };
      act(() => {
        client.emit({ type: "rpc", payload: { method: "gateway/message/updated", params: receipt } });
        client.emit({ type: "rpc", payload: { method: "gateway/message/updated", params: { ...receipt, status: "accepted", revision: 0 } } });
      });
      expect(result.current.selectedMessageDeliveries).toEqual([]);
      if (running) {
        await act(() => result.current.steerQueuedMessage("queued-1"));
        expect(request).toHaveBeenLastCalledWith("gateway/message/submit", expect.objectContaining({
          operation: "promote", params: expect.objectContaining({ messageId: "queued-1" }),
        }));
      }
      act(() => socket.disconnect());
      expect(result.current.error).toBeUndefined();
    } finally { unmount(); socket.disconnect(); }
  });
});
