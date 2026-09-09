import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    threadsLoading: false,
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
    prepareDesktopRestart: vi.fn().mockResolvedValue({
      confirmationToken: "confirm-once",
      expiresInSeconds: 60,
      runningThreadCount: 1,
    }),
    confirmDesktopRestart: vi.fn().mockResolvedValue({ accepted: true }),
    readQuestionContext: vi.fn().mockResolvedValue({
      threadId: "unused", turnId: "unused", state: "not_found", revision: "unused",
    }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    resolveRequest: vi.fn(),
    ...overrides,
  };
}

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    useCodexMock.mockReset();
    useCodexMock.mockReturnValue(codexState());
  });

  it("renders the Remote product heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Remote" })).toBeVisible();
    expect(document.querySelector(".brand-mark img")).toBeVisible();
  });

  it("shows native connection progress until the handshake actually fails", () => {
    const remote = { connectionId: "local", name: "Test Mac", baseUrl: "http://local:4321", token: "test", onManageConnections: vi.fn() };
    useCodexMock.mockReturnValue(codexState({ connection: "connecting" }));
    const { rerender } = render(<App remote={remote} />);
    expect(screen.getByRole("status")).toHaveTextContent("正在连接 Test Mac");
    expect(screen.queryByRole("heading", { name: "无法连接 Test Mac" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();

    useCodexMock.mockReturnValue(codexState({ connection: "disconnected", error: "Connection refused" }));
    rerender(<App remote={remote} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
    expect(screen.getByRole("heading", { name: "无法连接 Test Mac" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });

  it("shows loading instead of claiming the initial task list is empty", () => {
    useCodexMock.mockReturnValue(codexState({ connection: "ready", threadsLoading: true }));

    render(<App />);

    expect(screen.getByText("加载中")).toBeVisible();
    expect(screen.queryByText("还没有活跃对话")).not.toBeInTheDocument();
  });

  it("shows the initial task-list failure instead of claiming the list is empty", () => {
    useCodexMock.mockReturnValue(codexState({
      connection: "ready",
      threadsError: "读取对话列表失败",
    }));

    render(<App />);

    expect(screen.getByRole("alert")).toHaveTextContent("读取对话列表失败");
    expect(screen.queryByText("还没有活跃对话")).not.toBeInTheDocument();
  });

  it("does not claim an existing conversation is empty while its history loads", () => {
    const thread = { id: "loading", title: "Existing conversation", status: "idle", turnOrder: [], turns: {} };
    useCodexMock.mockReturnValue(codexState({
      connection: "ready", selectedThreadId: thread.id, selectedThread: thread, selectedThreadLoading: true,
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
    }));
    render(<App />);
    expect(screen.getByText("正在加载对话…")).toBeVisible();
    expect(screen.queryByText("可以开始了")).not.toBeInTheDocument();
    expect(screen.queryByText("已显示最早内容")).not.toBeInTheDocument();
  });

  it("does not invite a first message after loading existing history fails", () => {
    const thread = { id: "failed-load", title: "Existing conversation", status: "idle", turnOrder: [], turns: {} };
    useCodexMock.mockReturnValue(codexState({
      connection: "ready", selectedThreadId: thread.id, selectedThread: thread, selectedThreadError: "History unavailable",
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
    }));
    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.queryByText("可以开始了")).not.toBeInTheDocument();
    expect(screen.queryByText("已显示最早内容")).not.toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Desktop task", level: 1 })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Remote" })).not.toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeVisible();
  });

  it("confirms a one-time Desktop restart from the read-only banner", async () => {
    const thread = {
      id: "thread-1",
      title: "Desktop task",
      cwd: "/tmp/project",
      status: "running",
      turnOrder: [],
      turns: {},
      desktopMirror: true,
    };
    const value = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
      desktopStateAvailable: true,
      desktopControlAvailable: false,
      transportMode: "desktop-cold",
      selectedThreadId: thread.id,
      selectedThread: thread,
    });
    useCodexMock.mockReturnValue(value);

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "重启 Desktop 恢复控制" }));
    expect(value.prepareDesktopRestart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "重启 Codex Desktop" })).toHaveTextContent(
      "当前有 1 个对话正在运行",
    );

    await userEvent.click(screen.getByRole("button", { name: "确认重启" }));
    expect(value.confirmDesktopRestart).toHaveBeenCalledWith("confirm-once");
    expect(await screen.findByText("已请求重启，正在等待 Desktop 桥恢复…")).toBeVisible();
  });

  it("clears the restart wait state when the Desktop bridge becomes writable again", async () => {
    const thread = {
      id: "thread-1",
      title: "Desktop task",
      cwd: "/tmp/project",
      status: "idle",
      turnOrder: [],
      turns: {},
      desktopMirror: true,
    };
    const readOnly = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
      desktopStateAvailable: true,
      desktopControlAvailable: false,
      transportMode: "desktop-cold",
      selectedThreadId: thread.id,
      selectedThread: thread,
    });
    useCodexMock.mockReturnValue(readOnly);

    const view = render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "重启 Desktop 恢复控制" }));
    await userEvent.click(screen.getByRole("button", { name: "确认重启" }));
    expect(await screen.findByText("已请求重启，正在等待 Desktop 桥恢复…")).toBeVisible();

    useCodexMock.mockReturnValue(codexState({
      ...readOnly,
      desktopControlAvailable: true,
      transportMode: "desktop-live",
    }));
    view.rerender(<App />);

    expect(await screen.findByText("Desktop 桥已恢复")).toBeVisible();
    expect(screen.queryByText("已请求重启，正在等待 Desktop 桥恢复…")).not.toBeInTheDocument();
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

  it("reopens the same conversation when browser history moves forward", async () => {
    const thread = {
      id: "thread-1",
      title: "Forward history task",
      status: "idle",
      turnOrder: [],
      turns: {},
    };
    const value = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
    });
    useCodexMock.mockReturnValue(value);
    window.history.replaceState({ codexRemoteView: "list" }, "", "/");
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: /^Forward history task，/ }));
    value.selectThread.mockClear();
    value.clearSelection.mockClear();
    act(() => window.dispatchEvent(new PopStateEvent("popstate", {
      state: { codexRemoteView: "list" },
    })));
    value.clearSelection.mockClear();

    act(() => window.dispatchEvent(new PopStateEvent("popstate", {
      state: { codexRemoteView: "thread", codexRemoteThreadId: thread.id },
    })));

    expect(value.selectThread).toHaveBeenCalledWith(thread.id);
    expect(value.clearSelection).not.toHaveBeenCalled();
  });

  it("restores the selected conversation after a page reload", async () => {
    const thread = {
      id: "thread-1",
      title: "Reloaded task",
      status: "running",
      turnOrder: [],
      turns: {},
    };
    const value = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
    });
    useCodexMock.mockReturnValue(value);
    window.history.replaceState({
      codexRemoteView: "thread",
      codexRemoteThreadId: thread.id,
    }, "", "/");

    render(<App />);

    await waitFor(() => expect(value.selectThread).toHaveBeenCalledWith(thread.id));
    expect(value.clearSelection).not.toHaveBeenCalled();
  });

  it("groups the native mobile conversation title, back action, status, and connection", () => {
    const thread = {
      id: "thread-1",
      title: "Release signing repair",
      status: "running",
      turnOrder: [],
      turns: {},
    };
    useCodexMock.mockReturnValue(codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
      selectedThreadId: thread.id,
      selectedThread: thread,
    }));

    render(<App remote={{
      connectionId: "mac-1",
      name: "macmini",
      baseUrl: "http://192.168.1.10:4321",
      token: "test-token",
      onManageConnections: vi.fn(),
    }} />);

    const topbar = document.querySelector(".topbar-native-thread");
    expect(topbar).not.toBeNull();
    expect(topbar).toContainElement(within(topbar as HTMLElement).getByRole("button", { name: "返回对话列表" }));
    expect(topbar).toContainElement(within(topbar as HTMLElement).getByRole("heading", { name: "Release signing repair" }));
    expect(topbar).toContainElement(within(topbar as HTMLElement).getByText("运行中"));
    const connection = screen.getByRole("button", { name: "打开 macmini 的会话列表，已连接" });
    expect(connection).toHaveTextContent("macmini");
    expect(connection.querySelector(".remote-connection-indicator.connection-ready")).not.toBeNull();
    expect(document.querySelector(".desktop-thread-context")).toBeNull();
  });

  it("passes the native image uploader into the conversation state", () => {
    const imageUploader = vi.fn();

    render(<App remote={{
      connectionId: "mac-1",
      name: "macmini",
      baseUrl: "https://remote.example.test",
      token: "test-token",
      imageUploader,
      onManageConnections: vi.fn(),
    }} />);

    expect(useCodexMock).toHaveBeenCalledWith(undefined, {
      baseUrl: "https://remote.example.test",
      token: "test-token",
      imageUploader,
    });
  });

  it("distinguishes an offline connection by its icon and restores the normal connection action", async () => {
    useCodexMock.mockReturnValue(codexState({ connection: "disconnected" }));
    const remote = { connectionId: "mac-1", name: "Test Mac", baseUrl: "https://remote.example.test", token: "test", onManageConnections: vi.fn() };
    const { rerender } = render(<App remote={remote} />);
    expect(screen.getByRole("button", { name: /打开 Test Mac.*离线/ }).querySelector(".connection-disconnected")).toHaveTextContent("×");
    const value = codexState({ connection: "ready" });
    useCodexMock.mockReturnValue(value);
    rerender(<App remote={remote} />);
    const connection = screen.getByRole("button", { name: /打开 Test Mac.*已连接/ });
    expect(connection.querySelector(".connection-ready")).toBeInTheDocument();
    expect(connection).not.toHaveTextContent("×");
    await userEvent.click(connection);
    expect(value.clearSelection).toHaveBeenCalled();
  });

  it("returns to saved connections from the Remote title and switches connection tabs", async () => {
    const onManageConnections = vi.fn();
    const onOpenConnection = vi.fn();
    useCodexMock.mockReturnValue(codexState({ connection: "ready" }));

    render(<App remote={{
      connectionId: "mac-1",
      name: "Office Mac",
      baseUrl: "http://192.168.1.10:4321",
      token: "test-token",
      connections: [
        { id: "mac-1", name: "Office Mac", pairingStatus: "ready" },
        { id: "mac-2", name: "Home Mac", pairingStatus: "ready" },
      ],
      onManageConnections,
      onOpenConnection,
    }} />);

    await userEvent.click(screen.getByRole("button", { name: "返回连接列表" }));
    expect(onManageConnections).toHaveBeenCalledTimes(1);

    const switcher = screen.getByRole("navigation", { name: "连接" });
    expect(switcher).toHaveClass("remote-connection-switcher");
    await userEvent.click(within(switcher).getByRole("button", { name: /Home Mac/ }));
    expect(onOpenConnection).toHaveBeenCalledWith("mac-2");
  });

  it("returns from a native connection conversation list with a left-edge swipe", () => {
    const onManageConnections = vi.fn();
    useCodexMock.mockReturnValue(codexState({ connection: "ready" }));

    const { container } = render(<App remote={{
      connectionId: "mac-1",
      name: "Office Mac",
      baseUrl: "http://192.168.1.10:4321",
      token: "test-token",
      onManageConnections,
    }} />);

    const app = container.querySelector(".app-root") as HTMLElement;
    fireEvent.touchStart(app, { touches: [{ clientX: 12, clientY: 240 }] });
    fireEvent.touchEnd(app, { changedTouches: [{ clientX: 118, clientY: 246 }] });

    expect(onManageConnections).toHaveBeenCalledOnce();
  });

  it("does not leave a selected native thread while that thread is still loading", () => {
    const onManageConnections = vi.fn();
    useCodexMock.mockReturnValue(codexState({
      connection: "ready",
      selectedThreadId: "thread-loading",
      selectedThread: undefined,
      selectedThreadLoading: true,
    }));

    const { container } = render(<App remote={{
      connectionId: "mac-1",
      name: "Office Mac",
      baseUrl: "http://192.168.1.10:4321",
      token: "test-token",
      onManageConnections,
    }} />);

    const app = container.querySelector(".app-root") as HTMLElement;
    fireEvent.touchStart(app, { touches: [{ clientX: 12, clientY: 240 }] });
    fireEvent.touchEnd(app, { changedTouches: [{ clientX: 118, clientY: 246 }] });

    expect(onManageConnections).not.toHaveBeenCalled();
  });

  it("opens the active connection conversation list without leaving connection view", async () => {
    const thread = {
      id: "thread-1",
      title: "Active task",
      status: "idle",
      turnOrder: [],
      turns: {},
    };
    window.history.replaceState({ codexRemoteView: "thread", codexRemoteThreadId: thread.id }, "");
    const value = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
      selectedThreadId: thread.id,
      selectedThread: thread,
    });
    useCodexMock.mockReturnValue(value);

    render(<App remote={{
      connectionId: "mac-1",
      name: "Office Mac",
      baseUrl: "http://192.168.1.10:4321",
      token: "test-token",
      connections: [{ id: "mac-1", name: "Office Mac", pairingStatus: "ready" }],
      onManageConnections: vi.fn(),
      onOpenConnection: vi.fn(),
    }} />);

    await waitFor(() => expect(value.selectThread).toHaveBeenCalledWith(thread.id));
    expect(value.clearSelection).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Office Mac/ }));
    expect(value.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("uses the mobile default running-message mode for the composer", async () => {
    const thread = {
      id: "thread-1",
      title: "Running task",
      status: "running",
      turnOrder: ["turn-1"],
      turns: { "turn-1": { id: "turn-1", status: "inProgress", itemOrder: [], items: {} } },
      desktopMirror: true,
    };
    const value = codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready",
      desktopControlAvailable: true,
      selectedThreadId: thread.id,
      selectedThread: thread,
    });
    useCodexMock.mockReturnValue(value);

    render(<App remote={{
      connectionId: "mac-1",
      name: "macmini",
      baseUrl: "http://192.168.1.10:4321",
      token: "test-token",
      messageSendMode: "steer",
      language: "en",
      onManageConnections: vi.fn(),
    }} />);

    await userEvent.click(screen.getByRole("textbox", { name: "Instruction" }));
    expect(screen.getByRole("button", { name: "Steer" })).toBeVisible();
    await userEvent.type(screen.getByRole("textbox", { name: "Instruction" }), "Guide now");
    await userEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(value.sendInstruction).toHaveBeenCalledWith("Guide now", [], "steer");
  });

  it("wires the visible assistant identity to the dedicated question RPC", async () => {
    const thread = {
      id: "thread-1", title: "Task", status: "idle", turnOrder: ["turn-1"],
      turns: { "turn-1": { id: "turn-1", status: "completed", itemOrder: ["answer-1"], items: {
        "answer-1": { id: "answer-1", type: "agentMessage", text: "回答正文" },
      } } },
    };
    const readQuestionContext = vi.fn(async (request) => ({
      ...request, state: "ready", revision: "1",
      question: { id: "question-1", text: "解释这段日志", imageCount: 0, source: "user", truncated: false, textOffset: 0 },
    }));
    useCodexMock.mockReturnValue(codexState({
      state: { threadOrder: [thread.id], threads: { [thread.id]: thread }, stale: false },
      connection: "ready", selectedThreadId: thread.id, selectedThread: thread, readQuestionContext,
    }));
    const { container } = render(<App />);
    const viewport = screen.getByTestId("timeline-scroll");
    const answer = container.querySelector<HTMLElement>('[data-anchor-item-id="answer-1"]')!;
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 } as DOMRect);
    answer.getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);

    fireEvent.scroll(viewport);

    expect(await screen.findByRole("button", { name: /原始问题：解释这段日志/ })).toBeVisible();
    expect(readQuestionContext).toHaveBeenCalledWith(
      { threadId: "thread-1", turnId: "turn-1", anchorItemId: "answer-1" },
      expect.any(AbortSignal),
    );
  });
});
