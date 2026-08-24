import { describe, expect, it } from "vitest";
import { RpcRouter } from "./rpc-router";

describe("RpcRouter", () => {
  it("maps overlapping browser ids to unique server ids", () => {
    const router = new RpcRouter();
    const first = router.fromBrowser("a", {
      id: 1,
      method: "thread/list",
      params: {},
    });
    const second = router.fromBrowser("b", {
      id: 1,
      method: "thread/list",
      params: {},
    });

    expect(first.id).not.toBe(second.id);
  });

  it("routes a server response back to the originating browser", () => {
    const router = new RpcRouter();
    const sent = router.fromBrowser("phone", {
      id: 7,
      method: "thread/list",
      params: {},
    });

    expect(router.fromServer({ id: sent.id, result: { data: [] } })).toEqual({
      clientId: "phone",
      message: { id: 7, result: { data: [] } },
    });
  });

  it("maps a server request id until the browser responds", () => {
    const router = new RpcRouter();
    const routed = router.fromServer({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test" },
    });

    expect("broadcast" in routed && routed.broadcast.id).not.toBe(91);
    if (!("broadcast" in routed)) {
      throw new Error("Expected a broadcast request");
    }
    expect(
      router.fromBrowser("phone", {
        id: routed.broadcast.id,
        result: { decision: "decline" },
      }),
    ).toEqual({ id: 91, result: { decision: "decline" } });
  });

  it("ignores later responses after another browser resolved a server request", () => {
    const router = new RpcRouter();
    const routed = router.fromServer({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test" },
    });
    if (!("broadcast" in routed)) throw new Error("Expected a broadcast request");

    expect(router.fromBrowser("first", {
      id: routed.broadcast.id,
      result: { decision: "accept" },
    })).toEqual({ id: 91, result: { decision: "accept" } });
    expect(router.fromBrowser("second", {
      id: routed.broadcast.id,
      result: { decision: "decline" },
    })).toBeUndefined();
  });

  it("rejects an unmapped server response", () => {
    const router = new RpcRouter();

    expect(() => router.fromServer({ id: 404, result: {} })).toThrow(
      "unmapped-server-response",
    );
  });
});
