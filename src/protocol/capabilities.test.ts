import { describe, expect, it } from "vitest";
import {
  compareProtocolVersions,
  createProtocolCapabilities,
  isAllowedClientMethod,
  isSupportedServerRequest,
} from "./capabilities";

describe("protocol capabilities", () => {
  it("compares stable and prerelease protocol versions", () => {
    expect(compareProtocolVersions("0.148.0-alpha.15", "0.141.0")).toBeGreaterThan(0);
    expect(compareProtocolVersions("0.141.0", "0.141.0")).toBe(0);
    expect(compareProtocolVersions("0.140.9", "0.141.0")).toBeLessThan(0);
    expect(compareProtocolVersions("0.148.0-alpha.1", "0.148.0")).toBeLessThan(0);
  });

  it("fails closed below the supported protocol floor", () => {
    const result = createProtocolCapabilities("0.140.0");
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe("app-server-version-unsupported");
    expect(result.clientMethods).toEqual([]);
  });

  it("allows the Desktop thread and turn operations used by Remote", () => {
    const result = createProtocolCapabilities("0.148.0-alpha.15");
    expect(result.compatible).toBe(true);
    expect(isAllowedClientMethod(result, "thread/name/set")).toBe(true);
    expect(isAllowedClientMethod(result, "thread/metadata/update")).toBe(true);
    expect(isAllowedClientMethod(result, "turn/steer")).toBe(true);
    expect(isAllowedClientMethod(result, "shell/arbitrary")).toBe(false);
  });

  it("recognizes approval and user-input server requests", () => {
    const result = createProtocolCapabilities("0.148.0-alpha.15");
    expect(isSupportedServerRequest(result, "item/commandExecution/requestApproval")).toBe(true);
    expect(isSupportedServerRequest(result, "item/tool/requestUserInput")).toBe(true);
    expect(isSupportedServerRequest(result, "item/unknown/requestApproval")).toBe(false);
  });
});
