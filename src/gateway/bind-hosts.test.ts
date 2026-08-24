import { describe, expect, it } from "vitest";
import { parseAdditionalBindHosts } from "./bind-hosts";

describe("additional bind hosts", () => {
  it("normalizes the configured host list", () => {
    expect(
      parseAdditionalBindHosts(" 127.0.0.1,192.168.2.10,,127.0.0.1 "),
    ).toEqual(["127.0.0.1", "192.168.2.10"]);
  });

  it("returns no additional hosts when configuration is absent", () => {
    expect(parseAdditionalBindHosts(undefined)).toEqual([]);
  });
});
