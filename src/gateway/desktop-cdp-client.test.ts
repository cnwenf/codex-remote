// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCdpServer } from "../../tests/fixtures/fake-cdp-server";
import * as poisonedDesktopModule from "../../tests/fixtures/app-initial-poisoned";
import { DesktopCdpClient } from "./desktop-cdp-client";
import { DesktopBridgeTransport } from "./desktop-bridge-transport";
import type { RpcMessage } from "../protocol/types";

let server: FakeCdpServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe("DesktopCdpClient", () => {
  it("selects the Codex renderer and installs the message binding", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const client = new DesktopCdpClient({ endpoint });

    await client.start(() => undefined, () => undefined);

    expect(server.requests.map((request) => request.method)).toEqual([
      "Runtime.enable",
      "Runtime.removeBinding",
      "Runtime.addBinding",
      "Runtime.evaluate",
    ]);
    expect(server.requests[1]?.params).toEqual({ name: "__codexLocalDesktopEvent" });
    expect(server.requests[2]?.params).toEqual({ name: "__codexLocalDesktopEvent" });
    expect(String(server.requests[3]?.params?.expression)).toContain("mcp-notification");
    expect(String(server.requests[3]?.params?.expression))
      .toContain("removeEventListener");
    expect(String(server.requests[3]?.params?.expression)).toContain("fetch-response");
    expect(String(server.requests[3]?.params?.expression)).toContain("pinned-threads-updated");
    expect(String(server.requests[3]?.params?.expression))
      .toContain("__codexRemoteVisibleSettingsHelperVersion");
    expect(String(server.requests[3]?.params?.expression))
      .toContain("__codexRemoteVisibleAgentMessageObserverVersion");
    expect(String(server.requests[3]?.params?.expression))
      .toContain('[data-markdown-text-style="assistant-message"]');
    expect(String(server.requests[3]?.params?.expression))
      .toContain("desktop-visible-agent-message");
    await client.stop();
  });

  it("forwards Desktop messages and sends through electronBridge", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const messages: unknown[] = [];
    const client = new DesktopCdpClient({ endpoint });
    await client.start((message) => messages.push(message), () => undefined);

    server.emitBinding({ type: "mcp-response", hostId: "local", message: { id: 9 } });
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await client.sendDesktopMessage({
      type: "mcp-request",
      hostId: "local",
      request: { id: 9, method: "thread/list", params: {} },
    });

    const send = server.requests.at(-1);
    expect(send?.method).toBe("Runtime.callFunctionOn");
    expect(send?.params?.arguments).toEqual([{
      value: {
        type: "mcp-request",
        hostId: "local",
        request: { id: 9, method: "thread/list", params: {} },
      },
    }]);
    await client.stop();
  });

  it("uses a neutral renderer to call the current thread owner without self-routing", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, () => undefined);

    const result = await client.requestThreadOwner(
      "thread-follower-update-thread-settings",
      { conversationId: "thread-1", threadSettings: { model: "gpt-test" } },
    );

    expect(result).toEqual({
      method: "thread-follower-update-thread-settings",
      result: { ok: true },
    });
    expect(server.ownerRequests.map((request) => request.method)).toEqual([
      "Runtime.enable",
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
    ]);
    expect(String(server.ownerRequests[1]?.params?.expression))
      .toContain("__codexRemoteRequestThreadOwnerVersion");
    expect(String(server.ownerRequests[1]?.params?.expression))
      .toContain("coordination.requestThreadFollower({ hostId: 'local', request: { method, params } })");
    expect(String(server.ownerRequests[1]?.params?.expression))
      .not.toContain("coordination.findThreadOwner");
    expect(server.ownerRequests.at(-1)?.params?.arguments).toEqual([
      { value: "thread-follower-update-thread-settings" },
      { value: { conversationId: "thread-1", threadSettings: { model: "gpt-test" } } },
    ]);
    const visibleSync = server.requests.at(-1);
    expect(visibleSync?.method).toBe("Runtime.callFunctionOn");
    expect(String(visibleSync?.params?.functionDeclaration))
      .toContain("__codexRemoteSyncVisibleThreadSettings");
    expect(visibleSync?.params?.arguments).toEqual([{
      value: { conversationId: "thread-1", threadSettings: { model: "gpt-test" } },
    }]);
    await client.stop();
  });

  it("broadcasts queued follow-ups through Desktop client coordination without an owner request", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, () => undefined);

    await client.broadcastQueuedFollowUps("thread-1", [{ id: "queued-1", text: "Run next" }]);

    expect(String(server.ownerRequests[1]?.params?.expression))
      .toContain("coordination.threadQueuedFollowUpsChanged");
    expect(String(server.ownerRequests.at(-1)?.params?.functionDeclaration))
      .toContain("__codexRemoteBroadcastQueuedFollowUps");
    expect(server.ownerRequests.at(-1)?.params?.arguments).toEqual([
      { value: "thread-1" },
      { value: [{ id: "queued-1", text: "Run next" }] },
    ]);
    await client.stop();
  });

  it("skips Desktop class exports and callables whose string conversion throws when finding the RPC factory", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, () => undefined);
    await client.broadcastQueuedFollowUps("thread-1", []);

    const expression = String(server.ownerRequests[1]?.params?.expression).replace(
      "const loaded = await import(moduleUrl);",
      "const loaded = window.__testDesktopModule;",
    );
    const window = {
      location: { origin: "app://-" },
      postMessage: vi.fn(),
      __testDesktopModule: poisonedDesktopModule,
    } as Record<string, unknown>;
    const document = {
      querySelectorAll: () => [{ href: "app://-/assets/app-initial-fixture.js" }],
    };
    const performance = { getEntriesByType: () => [] };
    class MessageChannel {
      port1 = {};
      port2 = {};
    }

    const installedWindow = eval(expression) as typeof window;
    const broadcast = installedWindow.__codexRemoteBroadcastQueuedFollowUps as (
      conversationId: string,
      messages: unknown[],
    ) => Promise<unknown>;
    await expect(broadcast("thread-1", [])).resolves.toEqual({
      hostId: "local",
      conversationId: "thread-1",
      messages: [],
    });
    await client.stop();
  });

  it("serializes visible Desktop setting updates", async () => {
    server = new FakeCdpServer();
    server.visibleSettingsSyncDelayMs = 40;
    const endpoint = await server.start();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, () => undefined);

    await Promise.all([
      client.requestThreadOwner(
        "thread-follower-update-thread-settings",
        { conversationId: "thread-1", threadSettings: { model: "gpt-test" } },
      ),
      client.requestThreadOwner(
        "thread-follower-update-thread-settings",
        { conversationId: "thread-1", threadSettings: { effort: "high" } },
      ),
    ]);

    expect(server.maxConcurrentVisibleSettingsSyncRequests).toBe(1);
    await client.stop();
  });

  it("discovers the RPC factory in app-shared and uses the dedicated queue service", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    await client.start(() => undefined, () => undefined);
    await client.broadcastQueuedFollowUps("thread-1", []);
    const expression = String(server.ownerRequests[1]?.params?.expression).replace(
      "await import(moduleUrl)", "await window.__testImport(moduleUrl)",
    );
    const read = vi.fn(async () => ({ state: { other: [{ id: "keep" }] } }));
    const write = vi.fn(async (_value: unknown) => undefined);
    const broadcast = vi.fn(async (value: unknown) => value);
    const services = { queuedFollowUps: { read, write }, clientCoordination: { threadQueuedFollowUpsChanged: broadcast } };
    const window = {
      location: { origin: "app://-" }, postMessage: vi.fn(),
      __testImport: vi.fn(async (url: string) => url.includes("app-shared-") ? {
        factory: function createRemoteMain() { const getRemoteMain = () => ({ services }); return getRemoteMain(); },
      } : {}),
    } as Record<string, any>;
    const document = { querySelectorAll: () => [{ href: "app://-/assets/app-initial-new.js" }] };
    const performance = { getEntriesByType: () => [{ name: "app://-/assets/app-shared-new.js" }] };
    class MessageChannel { port1 = {}; port2 = {}; }
    try {
      eval(expression);
      await expect(window.__codexRemoteRequestThreadOwner("codex-remote-queue-state", { operation: "read" }))
        .resolves.toEqual({ value: { other: [{ id: "keep" }] } });
      await window.__codexRemoteBroadcastQueuedFollowUps("t", []);
      expect(broadcast).toHaveBeenCalledWith({ hostId: "local", conversationId: "t", messages: [] });
    } finally { await client.stop(); }
  });

  it("adapts only queue fetches to app-host services and preserves fetch response correlation", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    const received: unknown[] = [];
    await client.start((message) => received.push(message), () => undefined);
    server.ownerResponse = { value: { t: [] } };
    try {
      await client.sendDesktopMessage({ type: "fetch", method: "POST", requestId: "queue-read",
        url: "vscode://codex/get-global-state", body: JSON.stringify({ key: "queued-follow-ups" }) });
      expect(received).toContainEqual({ type: "fetch-response", requestId: "queue-read",
        responseType: "success", status: 200, bodyJsonString: JSON.stringify({ value: { t: [] } }) });
      expect(server.ownerRequests.at(-1)?.params?.arguments).toEqual([
        { value: "codex-remote-queue-state" }, { value: { operation: "read" } },
      ]);
      const original = { type: "fetch", method: "POST", requestId: "unrelated",
        url: "vscode://codex/get-global-state", body: JSON.stringify({ key: "other" }) };
      await client.sendDesktopMessage(original);
      expect(server.requests.at(-1)?.params?.arguments).toEqual([{ value: original }]);
    } finally { await client.stop(); }
  });

  it.each(["read", "write"] as const)("keeps the bridge writable after a queue %s owner rejection", async (phase) => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    const transport = new DesktopBridgeTransport({ client, appServerVersion: "0.148.0-alpha.15", reconnectDelayMs: 5 });
    const messages: RpcMessage[] = [];
    const diagnostics: string[] = [];
    const error = "Error: Please continue this conversation on the window where it was started.";
    try {
      await transport.start(message => messages.push(message), diagnostic => diagnostics.push(diagnostic.message));
      server.ownerException = error;
      server.ownerExceptionOperation = phase;
      server.ownerResponse = { value: {} };
      transport.send({ id: 1, method: "desktop/queue/add", params: { threadId: "t", text: "next" } });
      await vi.waitFor(() => expect(messages).toContainEqual({ id: 1, error: {
        code: -32002, message: `desktop-thread-owner-request-failed:${error}`,
      } }));
      expect(transport.state).toBe("live");
      expect(diagnostics).toEqual([]);
      server.ownerException = undefined;
      server.ownerResponse = { value: {} };
      transport.send({ id: 2, method: "desktop/queue/list", params: { threadId: "other" } });
      await vi.waitFor(() => expect(messages).toContainEqual({ id: 2, result: { messages: [] } }));
      transport.send({ id: 3, method: "thread/list", params: {} });
      server.emitBinding({ type: "mcp-response", hostId: "local", message: { id: 3, result: { data: [] } } });
      await vi.waitFor(() => expect(messages).toContainEqual({ id: 3, result: { data: [] } }));
      expect(server.requests.filter(request => request.method === "Runtime.enable")).toHaveLength(1);
    } finally { await transport.stop(); }
  });

  it("returns an IPC queue rejection without invalidating CDP or replaying the write", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    const received: unknown[] = [];
    try {
      await client.start(message => received.push(message), () => undefined);
      server.ownerResponse = { resultType: "error", error: "owner denied" };
      await expect(client.sendDesktopMessage({ type: "fetch", method: "POST", requestId: "queue-write",
        url: "vscode://codex/set-global-state", body: JSON.stringify({ key: "queued-follow-ups", threadId: "t", value: { t: [] } }),
      })).resolves.toBeUndefined();
      expect(received).toContainEqual({ type: "fetch-response", requestId: "queue-write",
        responseType: "error", status: 500, error: "owner denied" });
      expect(server.ownerRequests.filter(request => request.method === "Runtime.callFunctionOn")).toHaveLength(1);
      await expect(client.sendDesktopMessage({ type: "mcp-request", hostId: "local", request: { id: 1, method: "thread/list" } }))
        .resolves.toBeUndefined();
    } finally { await client.stop(); }
  });

  it("still propagates a queue CDP timeout instead of claiming an owner rejection", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    const received: unknown[] = [];
    try {
      await client.start(message => received.push(message), () => undefined);
      vi.spyOn(client, "requestThreadOwner").mockRejectedValueOnce(new Error("desktop-cdp-owner-call-timeout"));
      await expect(client.sendDesktopMessage({ type: "fetch", method: "POST", requestId: "queue-write",
        url: "vscode://codex/set-global-state", body: JSON.stringify({ key: "queued-follow-ups", threadId: "t", value: { t: [] } }),
      })).rejects.toThrow("desktop-cdp-owner-call-timeout");
      expect(received).toEqual([]);
    } finally { await client.stop(); }
  });

  it("uses the main-process owner for control and thread-scoped queue writes", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    await client.start(() => undefined, () => undefined);
    await client.broadcastQueuedFollowUps("t", []);
    const expression = String(server.ownerRequests[1]?.params?.expression).replace(
      "await import(moduleUrl)", "await window.__testImport(moduleUrl)",
    );
    const handleThreadFollowerRequest = vi.fn(async (request: unknown) => ({ result: { ok: true }, request }));
    const dispose = vi.fn();
    const requestThreadFollower = vi.fn();
    const write = vi.fn();
    const services = {
      appServerManagers: { open: vi.fn(async () => ({ status: "ready", manager: {
        getStreamRole: async () => ({ role: "owner" }), handleThreadFollowerRequest, [Symbol.dispose]: dispose,
      } })) },
      clientCoordination: { requestThreadFollower }, queuedFollowUps: { write },
    };
    const window = { location: { origin: "app://-" }, postMessage: vi.fn(),
      __testImport: async () => ({ factory: function() { const getRemoteMain = () => ({ services }); return getRemoteMain(); } }),
    } as Record<string, any>;
    const document = { querySelectorAll: () => [{ href: "app://-/assets/app-shared-new.js" }] };
    const performance = { getEntriesByType: () => [] };
    class MessageChannel { port1 = {}; port2 = {}; }
    try {
      eval(expression);
      await window.__codexRemoteRequestThreadOwner("thread-follower-interrupt-turn", { conversationId: "t", mode: "user-stop" });
      await window.__codexRemoteRequestThreadOwner("codex-remote-queue-state", {
        operation: "write", threadId: "t", value: { t: [{ id: "new" }], other: [{ id: "stale" }] },
      });
      expect(handleThreadFollowerRequest.mock.calls.map(([request]) => request)).toEqual([
        { method: "thread-follower-interrupt-turn", params: { conversationId: "t", mode: "user-stop" } },
        { method: "thread-follower-set-queued-follow-ups-state", params: { conversationId: "t", state: { t: [{ id: "new" }] } } },
      ]);
      expect(write).not.toHaveBeenCalled();
      expect(requestThreadFollower).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally { await client.stop(); }
  });

  it("stops an ownerless thread through bounded Desktop hydration without resuming or changing its configuration", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    await client.start(() => undefined, () => undefined);
    await client.broadcastQueuedFollowUps("t", []);
    const expression = String(server.ownerRequests[1]?.params?.expression).replace(
      "await import(moduleUrl)", "await window.__testImport(moduleUrl)",
    );
    const handleThreadFollowerRequest = vi.fn(async () => { throw new Error("Please continue this conversation on the window where it was started."); });
    const hydrateBackgroundThreads = vi.fn();
    const setThreadGoalStatus = vi.fn();
    const interruptConversation = vi.fn(async () => "active-turn");
    const resumeConversation = vi.fn();
    const sendRequest = vi.fn(async (method: string) => method === "thread/goal/get"
      ? { goal: { status: "active" } } : { turnId: "active-turn" });
    const dispose = vi.fn();
    let role: { role: string; ownerClientId?: string } | null = null;
    const removeQueuedMessage = vi.fn();
    const restoreQueuedMessage = vi.fn();
    const releaseDeferral = vi.fn();
    const releaseCoordinator = vi.fn();
    const manager = { getStreamRole: async () => role, handleThreadFollowerRequest, hydrateBackgroundThreads,
      getThreadExecutionState: async () => ({ inProgress: true }), setThreadGoalStatus, interruptConversation,
      getLatestTurnId: async () => "active-turn", resumeConversation, sendRequest, [Symbol.dispose]: dispose,
      getTurnCoordinator: async () => ({ removeQueuedMessage, restoreQueuedMessage,
        deferAutomaticTurns: async () => ({ [Symbol.dispose]: releaseDeferral }), [Symbol.dispose]: releaseCoordinator }),
    };
    const requestThreadFollower = vi.fn(async () => ({ result: { ok: true } }));
    const write = vi.fn();
    const services = { appServerManagers: { open: async () => ({ status: "ready", manager }) },
      clientCoordination: { requestThreadFollower }, queuedFollowUps: { write } };
    const window = { location: { origin: "app://-" }, postMessage: vi.fn(),
      __testImport: async () => ({ factory: function() { const getRemoteMain = () => ({ services }); return getRemoteMain(); } }),
    } as Record<string, any>;
    const document = { querySelectorAll: () => [{ href: "app://-/assets/app-shared-new.js" }] };
    const performance = { getEntriesByType: () => [] };
    class MessageChannel { port1 = {}; port2 = {}; }
    try {
      eval(expression);
      await expect(window.__codexRemoteRequestThreadOwner("thread-follower-interrupt-turn", {
        conversationId: "t", mode: "user-stop",
      })).resolves.toMatchObject({ result: { interruptedTurnId: "active-turn", ok: true } });
      expect(hydrateBackgroundThreads).toHaveBeenCalledWith(["t"], { includeTurns: true, maxTurns: 1, refreshExisting: true });
      expect(setThreadGoalStatus).toHaveBeenCalledWith("t", { status: "paused" });
      expect(interruptConversation).toHaveBeenCalledWith("t", "user-stop");
      expect(handleThreadFollowerRequest).not.toHaveBeenCalled();
      expect(resumeConversation).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      await window.__codexRemoteRequestThreadOwner("thread-follower-steer-turn", {
        conversationId: "t", input: [{ type: "text", text: "next" }], clientUserMessageId: "stable-id",
      });
      expect(sendRequest).toHaveBeenLastCalledWith("turn/steer", {
        threadId: "t", expectedTurnId: "active-turn", input: [{ type: "text", text: "next" }],
        clientUserMessageId: "stable-id", additionalContext: undefined,
      });
      const message = { id: "new", text: "next" };
      for (const operation of ["add", "steer", "restore"]) {
        await window.__codexRemoteRequestThreadOwner("codex-remote-queue-state", {
          operation: "write", threadId: "t", value: { t: [message], other: [] },
          queueMutation: { operation, message },
        });
      }
      expect(removeQueuedMessage).toHaveBeenCalledExactlyOnceWith("t", "new");
      expect(restoreQueuedMessage).toHaveBeenCalledTimes(2);
      expect(restoreQueuedMessage).toHaveBeenLastCalledWith("t", {
        message, index: 0, previousMessageId: undefined, nextMessageId: undefined,
      });
      expect(write).not.toHaveBeenCalled();
      expect(releaseDeferral).toHaveBeenCalledTimes(3);
      expect(releaseCoordinator).toHaveBeenCalledTimes(3);
      role = { role: "follower", ownerClientId: "actual-owner" };
      const stopParams = { conversationId: "t", mode: "user-stop" };
      await window.__codexRemoteRequestThreadOwner("thread-follower-interrupt-turn", stopParams);
      expect(requestThreadFollower).toHaveBeenCalledExactlyOnceWith({ hostId: "local", targetClientId: "actual-owner",
        request: { method: "thread-follower-interrupt-turn", params: stopParams } });
      role = null;
      setThreadGoalStatus.mockRejectedValueOnce(new Error("pause denied"));
      await expect(window.__codexRemoteRequestThreadOwner("thread-follower-interrupt-turn", stopParams))
        .rejects.toThrow("desktop-thread-goal-pause-failed");
      expect(interruptConversation).toHaveBeenCalledTimes(2);
      interruptConversation.mockResolvedValueOnce(null as any);
      await expect(window.__codexRemoteRequestThreadOwner("thread-follower-interrupt-turn", stopParams))
        .rejects.toThrow("desktop-thread-interrupt-unconfirmed");
    } finally { await client.stop(); }
  });

  it("routes queue changes through the renderer owner rather than replacing shared storage", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    await client.start(() => undefined, () => undefined);
    await client.broadcastQueuedFollowUps("t", []);
    const expression = String(server.ownerRequests[1]?.params?.expression).replace(
      "await import(moduleUrl)", "await window.__testImport(moduleUrl)",
    );
    const requestThreadFollower = vi.fn(async () => ({ resultType: "success", result: { ok: true } }));
    const write = vi.fn();
    const services = { clientCoordination: { requestThreadFollower }, queuedFollowUps: { write } };
    const window = { location: { origin: "app://-" }, postMessage: vi.fn(),
      __testImport: async () => ({ factory: function() { const getRemoteMain = () => ({ services }); return getRemoteMain(); } }),
    } as Record<string, any>;
    const document = { querySelectorAll: () => [{ href: "app://-/assets/app-shared-new.js" }] };
    const performance = { getEntriesByType: () => [] };
    class MessageChannel { port1 = {}; port2 = {}; }
    try {
      eval(expression);
      await window.__codexRemoteRequestThreadOwner("codex-remote-queue-state", { operation: "write", threadId: "t", value: { t: [], other: [] } });
      expect(requestThreadFollower).toHaveBeenCalledWith({ hostId: "local", request: {
        method: "thread-follower-set-queued-follow-ups-state", params: { conversationId: "t", state: { t: [] } },
      } });
      expect(write).not.toHaveBeenCalled();
    } finally { await client.stop(); }
  });

  it("surfaces rejected owner responses instead of acknowledging a stop that did not happen", async () => {
    server = new FakeCdpServer();
    const client = new DesktopCdpClient({ endpoint: await server.start() });
    await client.start(() => undefined, () => undefined);
    server.ownerResponse = { resultType: "error", error: "owner denied" };
    try {
      await expect(client.requestThreadOwner("thread-follower-interrupt-turn", { conversationId: "t", mode: "user-stop" }))
        .rejects.toThrow("owner denied");
    } finally { await client.stop(); }
  });

  it("reads the visible Desktop composer settings for live E2E verification", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, () => undefined);

    await expect(client.inspectVisibleThreadSettings()).resolves.toEqual({
      conversationId: "thread-1",
      permissionLabel: "完全访问",
      modelLabel: "5.6 Sol",
      reasoningEffort: "high",
    });
    await expect(client.visibleConversationContainsText("visible steer")).resolves.toBe(true);
    await expect(client.visibleConversationContainsText("missing steer")).resolves.toBe(false);
    await client.stop();
  });

  it("rejects a non-loopback DevTools endpoint", async () => {
    const client = new DesktopCdpClient({ endpoint: "http://192.0.2.8:9222" });
    await expect(client.start(() => undefined, () => undefined))
      .rejects.toThrow("desktop-cdp-endpoint-not-loopback");
  });

  it("notifies once when the renderer disconnects", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const disconnected = vi.fn();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, disconnected);

    server.disconnect();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    await client.stop();
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("can attach again after the renderer disconnects", async () => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const disconnected = vi.fn();
    const client = new DesktopCdpClient({ endpoint });
    await client.start(() => undefined, disconnected);

    server.disconnect();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
    await client.start(() => undefined, disconnected);

    expect(server.requests.filter((request) => request.method === "Runtime.enable"))
      .toHaveLength(2);
    await client.stop();
  });

  it("does not retain a stale window when a context clears during bridge installation", async () => {
    server = new FakeCdpServer();
    server.clearContextDuringInstall = true;
    const endpoint = await server.start();
    const disconnected = vi.fn();
    const client = new DesktopCdpClient({ endpoint });
    try {
      const outcome = await client.start(() => undefined, disconnected).then(() => "started", () => "failed");
      await vi.waitFor(() => expect(outcome === "failed" || disconnected.mock.calls.length > 0).toBe(true));
      server.clearContextDuringInstall = false;
      await client.start(() => undefined, disconnected);
      await expect(client.sendDesktopMessage({ type: "mcp-request" })).resolves.toBeUndefined();
    } finally {
      await client.stop();
    }
  });

  it.each(["Runtime.executionContextsCleared", "Inspector.detached"])("reattaches both bridge connections after %s without restarting Desktop", async (method) => {
    server = new FakeCdpServer();
    const endpoint = await server.start();
    const disconnected = vi.fn();
    const messages: unknown[] = [];
    const client = new DesktopCdpClient({ endpoint });
    try {
      await client.start((message) => messages.push(message), disconnected);
      await client.broadcastQueuedFollowUps("thread-1", []);
      server.emitRendererEvent(method);
      await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
      await client.start((message) => messages.push(message), disconnected);
      await client.broadcastQueuedFollowUps("thread-1", []);
      expect(server.requests.filter((request) => request.method === "Runtime.enable")).toHaveLength(2);
      expect(server.ownerRequests.filter((request) => request.method === "Runtime.enable")).toHaveLength(2);
      server.emitBinding({ type: "mcp-notification", message: { method: "thread/started" } });
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(disconnected).toHaveBeenCalledTimes(1);
    } finally {
      await client.stop();
    }
  });
});
