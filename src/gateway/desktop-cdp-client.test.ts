// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCdpServer } from "../../tests/fixtures/fake-cdp-server";
import { DesktopCdpClient } from "./desktop-cdp-client";

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
      "Runtime.addBinding",
      "Runtime.evaluate",
    ]);
    expect(server.requests[1]?.params).toEqual({ name: "__codexLocalDesktopEvent" });
    expect(String(server.requests[2]?.params?.expression)).toContain("mcp-notification");
    expect(String(server.requests[2]?.params?.expression))
      .toContain("__codexLocalDesktopNotificationListenerInstalled");
    expect(String(server.requests[2]?.params?.expression)).toContain("fetch-response");
    expect(String(server.requests[2]?.params?.expression)).toContain("pinned-threads-updated");
    expect(String(server.requests[2]?.params?.expression))
      .toContain("__codexRemoteVisibleSettingsHelperVersion");
    expect(String(server.requests[2]?.params?.expression))
      .toContain("__codexRemoteVisibleAgentMessageObserverVersion");
    expect(String(server.requests[2]?.params?.expression))
      .toContain('[data-markdown-text-style="assistant-message"]');
    expect(String(server.requests[2]?.params?.expression))
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

  it("uses an auxiliary Desktop renderer to call the current thread owner", async () => {
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
});
