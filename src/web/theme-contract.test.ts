import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/web/styles.css"), "utf8");

describe("responsive theme contract", () => {
  it("defines system-driven light and dark product surfaces", () => {
    expect(styles).toContain("color-scheme: light");
    expect(styles).toContain("@media (prefers-color-scheme: dark)");
    expect(styles).toContain("color-scheme: dark");
    expect(styles).toContain("--action:");
    expect(styles).toContain("--floating-surface:");
  });

  it("includes the mobile navigation and conversation layout surfaces", () => {
    expect(styles).toContain(".task-nav-footer");
    expect(styles).toContain(".mobile-remote-header");
    expect(styles).toContain(".task-header");
  });
});
