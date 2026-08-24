import { describe, expect, it } from "vitest";
import {
  ConnectionStore,
  InMemoryConnectionPersistence,
  normalizeRemoteUrl,
} from "./connection-store";

describe("mobile connection store", () => {
  it("normalizes a private-network URL and rejects credentials, query strings, and public HTTP", () => {
    expect(normalizeRemoteUrl("http://192.168.50.8:4321/")).toBe("http://192.168.50.8:4321");
    expect(normalizeRemoteUrl("https://remote.example.test/base/")).toBe("https://remote.example.test/base");
    expect(() => normalizeRemoteUrl("http://user:pass@192.168.1.2:4321")).toThrow("remote-url-credentials");
    expect(() => normalizeRemoteUrl("http://192.168.1.2:4321/?token=secret")).toThrow("remote-url-query");
    expect(() => normalizeRemoteUrl("http://example.com:4321")).toThrow("remote-url-insecure-public-host");
  });

  it("creates, edits, selects, and removes connections without exposing tokens in metadata", async () => {
    const persistence = new InMemoryConnectionPersistence();
    const store = new ConnectionStore(persistence, () => "connection-1", () => 1234);

    const created = await store.save({
      name: "Office Mac",
      baseUrl: "http://10.20.30.40:4321/",
      token: "private-token",
    });

    expect(created).toEqual({
      id: "connection-1",
      name: "Office Mac",
      baseUrl: "http://10.20.30.40:4321",
      lastUsedAt: 1234,
    });
    expect(JSON.stringify(await store.list())).not.toContain("private-token");
    expect(await persistence.readSecret("connection-1")).toBe("private-token");

    await store.save({
      id: "connection-1",
      name: "Updated Mac",
      baseUrl: "http://10.20.30.41:4321",
      token: "new-token",
    });
    expect((await store.getSelected())?.name).toBe("Updated Mac");
    expect(await persistence.readSecret("connection-1")).toBe("new-token");

    await store.remove("connection-1");
    expect(await store.list()).toEqual([]);
    expect(await persistence.readSecret("connection-1")).toBeUndefined();
  });
});
