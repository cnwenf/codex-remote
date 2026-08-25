import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";

const { useCodexMock } = vi.hoisted(() => ({ useCodexMock: vi.fn() }));

vi.mock("./state/use-codex", () => ({ useCodex: useCodexMock }));

function codexState(overrides: Record<string, unknown> = {}) {
  return {
    state: { threadOrder: [], threads: {}, stale: false },
    creationOptions: { models: [], permissions: [], loading: false },
    connection: "disconnected",
    desktopStateAvailable: false,
    desktopControlAvailable: false,
    selectedThreadLoading: false,
    selectedThreadHistory: { hasMoreBefore: false, loading: false },
    pendingRequests: [],
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    refreshThreads: vi.fn().mockResolvedValue(undefined),
    refreshThreadSections: vi.fn().mockResolvedValue(undefined),
    refreshCreationOptions: vi.fn().mockResolvedValue(undefined),
    togglePin: vi.fn().mockResolvedValue(undefined),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    archivedThreads: [],
    archivedThreadsLoading: false,
    refreshArchivedThreads: vi.fn().mockResolvedValue(undefined),
    renameThread: vi.fn().mockResolvedValue(undefined),
    unarchiveThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    selectThread: vi.fn().mockResolvedValue(undefined),
    loadEarlierThreadHistory: vi.fn().mockResolvedValue(undefined),
    clearSelection: vi.fn(),
    createThread: vi.fn().mockResolvedValue(undefined),
    updateSelectedThreadSettings: vi.fn(),
    sendInstruction: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    resolveRequest: vi.fn(),
    ...overrides,
  };
}

describe("App", () => {
  beforeEach(() => {
    useCodexMock.mockReset();
    useCodexMock.mockReturnValue(codexState());
  });

  it("renders the local Codex client heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Codex Remote" })).toBeVisible();
    expect(document.querySelector(".brand-mark img")).toBeVisible();
  });

  it("does not render a redundant Desktop live connection banner", () => {
    const thread = {
      id: "thread-1",
      title: "Desktop task",
      cwd: "/tmp/project",
      status: "idle",
      turnOrder: [],
      turns: {},
      desktopMirror: true,
    };
    useCodexMock.mockReturnValue(codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
      desktopStateAvailable: true,
      desktopControlAvailable: true,
      transportMode: "desktop-live",
      selectedThreadId: thread.id,
      selectedThread: thread,
    }));

    render(<App />);

    expect(
      screen.queryByText("已连接 Codex Desktop，本页与 Desktop 操作同一会话。"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeVisible();
  });

  it("keeps mobile browser back swipe inside the app and returns to the conversation list", async () => {
    const thread = {
      id: "thread-1",
      title: "Swipe back task",
      status: "idle",
      turnOrder: [],
      turns: {},
    };
    const value = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
    });
    useCodexMock.mockReturnValue(value);
    window.history.replaceState(null, "", "/");
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /^Swipe back task，/ }));
    expect(window.history.state).toMatchObject({ codexRemoteView: "thread" });

    act(() => window.dispatchEvent(new PopStateEvent("popstate", {
      state: { codexRemoteView: "list" },
    })));
    expect(value.clearSelection).toHaveBeenCalled();
  });
});
