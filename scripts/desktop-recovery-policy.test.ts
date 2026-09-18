// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

it.skipIf(process.platform !== "darwin")("waits for stable Desktop failure and recovers at most once per process", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-recovery-policy-"));
  try {
    const source = readFileSync("macos/CodexRemoteApp/Sources/CodexRemoteApp/DesktopRecoveryPolicy.swift", "utf8");
    const script = join(directory, "check.swift");
    writeFileSync(script, source + `
var policy = DesktopRecoveryPolicy()
assert(!policy.observe(processIdentifier: nil, bridgeAvailable: false, now: 0))
assert(!policy.observe(processIdentifier: 10, bridgeAvailable: false, now: 0))
assert(!policy.observe(processIdentifier: 10, bridgeAvailable: false, now: 19))
assert(policy.observe(processIdentifier: 10, bridgeAvailable: false, now: 20))
assert(!policy.observe(processIdentifier: 10, bridgeAvailable: false, now: 200))
assert(!policy.observe(processIdentifier: 10, bridgeAvailable: true, now: 205))
assert(!policy.observe(processIdentifier: 10, bridgeAvailable: false, now: 210))
assert(!policy.observe(processIdentifier: 10, bridgeAvailable: false, now: 250))
assert(!policy.observe(processIdentifier: 11, bridgeAvailable: false, now: 260))
assert(!policy.observe(processIdentifier: 11, bridgeAvailable: true, now: 270))
assert(!policy.observe(processIdentifier: 11, bridgeAvailable: false, now: 275))
assert(!policy.observe(processIdentifier: 11, bridgeAvailable: false, now: 290))
assert(policy.observe(processIdentifier: 11, bridgeAvailable: false, now: 295))
assert(!policy.observe(processIdentifier: nil, bridgeAvailable: false, now: 400))
assert(!policy.observe(processIdentifier: nil, bridgeAvailable: false, now: 500))
`);
    execFileSync("swift", [script]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
