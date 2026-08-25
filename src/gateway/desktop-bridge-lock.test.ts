import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDesktopBridgeLock } from "./desktop-bridge-lock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop bridge lock", () => {
  it("rejects a second live gateway and releases ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-remote-lock-"));
    roots.push(root);
    const path = join(root, "desktop-bridge.lock");
    const first = acquireDesktopBridgeLock(path, 101, (pid) => pid === 101);

    expect(() => acquireDesktopBridgeLock(path, 202, (pid) => pid === 101))
      .toThrow("desktop-bridge-already-owned:101");

    first.release();
    const second = acquireDesktopBridgeLock(path, 202, () => false);
    expect(readFileSync(path, "utf8").trim()).toBe("202");
    second.release();
  });

  it("replaces a stale or malformed lock", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-remote-lock-"));
    roots.push(root);
    const path = join(root, "desktop-bridge.lock");
    writeFileSync(path, "not-a-pid\n", { mode: 0o600 });

    const lock = acquireDesktopBridgeLock(path, 303, () => false);
    expect(readFileSync(path, "utf8").trim()).toBe("303");
    lock.release();
  });

  it("does not remove a lock that another process replaced", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-remote-lock-"));
    roots.push(root);
    const path = join(root, "desktop-bridge.lock");
    const lock = acquireDesktopBridgeLock(path, 404, () => false);
    writeFileSync(path, "505\n", { mode: 0o600 });

    lock.release();
    expect(readFileSync(path, "utf8").trim()).toBe("505");
  });
});
