import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const installer = readFileSync(join(root, "install.sh"), "utf8");
const agents = readFileSync(join(root, "scripts/install-launch-agents.sh"), "utf8");

describe("native installer contract", () => {
  it("uses an interactive tty and stable checksum-verified release assets", () => {
    expect(installer).toContain("</dev/tty");
    expect(installer).toContain('"$BASE_URL/$ASSET.sha256"');
    expect(installer).toContain("shasum -a 256 -c");
    expect(installer).toContain("uname -m");
  });

  it("never puts the password in launch agents or command arguments", () => {
    expect(agents).not.toMatch(/token|password|CODEX_WEB_TOKEN/i);
    expect(installer).toContain('chmod 600 "$support/token"');
  });

  it("uses explicit persistent agents and never launchctl submit", () => {
    expect(agents).toContain("RunAtLoad");
    expect(agents).toContain("KeepAlive");
    expect(`${installer}\n${agents}`).not.toMatch(/launchctl\s+submit/);
  });

  it("ships executable install and packaging scripts", () => {
    for (const file of ["install.sh", "scripts/build-macos-app.sh", "scripts/package-macos-dmg.sh"]) {
      expect(statSync(join(root, file)).mode & 0o111).not.toBe(0);
    }
  });
});
