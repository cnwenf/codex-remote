import { describe, expect, it } from "vitest";
import { PairingStore } from "./pairing-store";

describe("PairingStore", () => {
  it("issues a token-free QR payload and consumes a pairing only once", () => {
    const store = new PairingStore(() => "pair-code", () => 1_000);
    const pairing = store.create("https://example.trycloudflare.com", "secret-token");

    expect(pairing.payload).toBe(
      "codex-remote://pair?url=https%3A%2F%2Fexample.trycloudflare.com&code=pair-code",
    );
    expect(pairing.payload).not.toContain("secret-token");
    expect(store.consume("pair-code")).toEqual({
      baseUrl: "https://example.trycloudflare.com",
      token: "secret-token",
    });
    expect(store.consume("pair-code")).toBeUndefined();
  });

  it("expires unused pairing codes", () => {
    let now = 1_000;
    const store = new PairingStore(() => "pair-code", () => now, 5_000);
    store.create("http://192.168.1.20:4321", "secret-token");
    now = 6_001;
    expect(store.consume("pair-code")).toBeUndefined();
  });
});
