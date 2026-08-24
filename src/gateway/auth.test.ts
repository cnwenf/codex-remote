// @vitest-environment node

import { describe, expect, it } from "vitest";
import { decodeTokenProtocol, isAuthorized, isAllowedOrigin } from "./auth";

describe("gateway authentication", () => {
  it("rejects the wrong token using constant-time comparison", () => {
    expect(isAuthorized("wrong", "correct")).toBe(false);
    expect(isAuthorized("correct", "correct")).toBe(true);
  });

  it("decodes a token carried in a websocket subprotocol", () => {
    const encoded = Buffer.from("phone secret", "utf8").toString("base64url");
    expect(decodeTokenProtocol(["codex-local", `token.${encoded}`])).toBe(
      "phone secret",
    );
  });

  it("uses exact origin matching", () => {
    const allowed = new Set(["http://127.0.0.1:4310"]);
    expect(isAllowedOrigin("http://127.0.0.1:4310", allowed)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4310.evil.test", allowed)).toBe(false);
  });
});
