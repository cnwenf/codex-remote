import { describe, expect, it } from "vitest";
import { exchangePairing, parsePairingPayload } from "./pairing";

describe("parsePairingPayload", () => {
  it("parses a private or HTTPS one-time pairing link", () => {
    expect(parsePairingPayload(
      "codex-remote://pair?url=http%3A%2F%2F192.168.1.20%3A4321&code=abc123",
    )).toEqual({ baseUrl: "http://192.168.1.20:4321", code: "abc123" });
  });

  it.each([
    "https://example.com",
    "codex-remote://pair?url=https%3A%2F%2Fexample.com",
    "codex-remote://pair?url=http%3A%2F%2Fexample.com&code=abc",
  ])("rejects an invalid or insecure payload: %s", (value) => {
    expect(() => parsePairingPayload(value)).toThrow();
  });
});

describe("exchangePairing", () => {
  it("times out instead of waiting forever for an unreachable Remote", async () => {
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;

    await expect(exchangePairing(
      "codex-remote://pair?url=http%3A%2F%2F192.168.1.20%3A4321&code=abc123",
      fetcher,
      5,
    )).rejects.toThrow("pairing-exchange-timeout");
  });
});
