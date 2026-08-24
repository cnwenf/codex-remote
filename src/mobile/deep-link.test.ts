import { describe, expect, it } from "vitest";
import { mobileThreadUrl, parseMobileDeepLink } from "./deep-link";

describe("mobile deep links", () => {
  it("round trips a connection and thread target", () => {
    const url = mobileThreadUrl("office mac", "01a0/thread");
    expect(parseMobileDeepLink(url)).toEqual({
      connectionId: "office mac",
      threadId: "01a0/thread",
    });
  });

  it("rejects unrelated or incomplete links", () => {
    expect(parseMobileDeepLink("https://example.test/thread/1")).toBeUndefined();
    expect(parseMobileDeepLink("codex-remote://connection/only-id/thread/")).toBeUndefined();
    expect(parseMobileDeepLink("not a URL")).toBeUndefined();
  });
});
