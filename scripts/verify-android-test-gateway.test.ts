// @vitest-environment node

import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { verifyAndroidTestGateway } from "./verify-android-test-gateway";

describe("verifyAndroidTestGateway", () => {
  it("refuses the App-managed production gateway port", async () => {
    await expect(verifyAndroidTestGateway({ host: "127.0.0.1", port: 4321 }))
      .rejects.toThrow("android-test-gateway-production-port-forbidden");
  });

  it("requires a free isolated port before launching acceptance", async () => {
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const port = (occupied.address() as AddressInfo).port;

    await expect(verifyAndroidTestGateway({ host: "127.0.0.1", port }))
      .rejects.toThrow("android-test-gateway-port-in-use");

    occupied.close();
    await once(occupied, "close");
    await expect(verifyAndroidTestGateway({ host: "127.0.0.1", port }))
      .resolves.toBeUndefined();
  });
});
