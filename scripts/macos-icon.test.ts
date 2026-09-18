import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")("renders only the brand silhouette in the menu-bar template alpha mask", () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-remote-menu-icon-"));
  const output = join(fixture, "menu.png");
  const probe = join(fixture, "check.swift");
  try {
    execFileSync("swift", ["scripts/render-menu-bar-icon.swift", "assets/app-icon.png", output]);
    writeFileSync(probe, `import AppKit
let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
assert(bitmap.pixelsWide == 36 && bitmap.pixelsHigh == 36)
for (x, y) in [(0, 0), (18, 0), (0, 18), (35, 18), (18, 35), (18, 18)] {
  assert(bitmap.colorAt(x: x, y: y)!.alphaComponent == 0, "Background and inner cutout must be transparent")
}
assert(bitmap.colorAt(x: 18, y: 6)!.alphaComponent > 0.8, "Brand silhouette must be visible")
var opaque = 0
var antialiased = 0
for y in 0..<36 { for x in 0..<36 {
  let color = bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
  if color.alphaComponent > 0.5 { opaque += 1 }
  if color.alphaComponent > 0 && color.alphaComponent < 1 { antialiased += 1 }
  assert(color.redComponent == 0 && color.greenComponent == 0 && color.blueComponent == 0)
} }
assert(opaque > 200 && opaque < 650, "Template must not be an opaque square")
assert(antialiased > 30, "Keep smooth Retina edges")
`);
    execFileSync("swift", [probe, output]);
    expect(readFileSync("scripts/build-macos-app.sh", "utf8"))
      .toContain('swift scripts/render-menu-bar-icon.swift assets/app-icon.png "$RES/MenuBarIcon.png"');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(process.platform !== "darwin")("renders a borderless Dock tile with transparent padding and an opaque interior", () => {
  const fixture = mkdtempSync(join(tmpdir(), "codex-remote-icon-"));
  const output = join(fixture, "icon.png");
  const probe = join(fixture, "check.swift");
  try {
    execFileSync("swift", ["scripts/render-macos-icon.swift", "assets/app-icon.png", output]);
    writeFileSync(probe, `import AppKit
let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!
assert(bitmap.pixelsWide == 1024 && bitmap.pixelsHigh == 1024)
for (x, y) in [(0, 0), (512, 0), (0, 512), (1023, 512), (512, 1023), (99, 512), (924, 512), (110, 110)] {
  assert(bitmap.colorAt(x: x, y: y)!.alphaComponent == 0, "Dock padding must be transparent")
}
for (x, y) in [(105, 512), (918, 512), (512, 105), (512, 918), (512, 512)] {
  let color = bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
  assert(color.alphaComponent == 1, "Tile must be opaque")
  assert(max(color.redComponent, color.greenComponent, color.blueComponent) < 0.05, "No light border")
}
let mark = bitmap.colorAt(x: 512, y: 220)!.usingColorSpace(.deviceRGB)!
assert(mark.redComponent > 0.9 && mark.greenComponent > 0.9 && mark.blueComponent > 0.9, "White brand mark must remain visible")
`);
    execFileSync("swift", [probe, output]);
    const build = readFileSync("scripts/build-macos-app.sh", "utf8");
    expect(build).toContain('swift scripts/render-macos-icon.swift assets/app-icon.png "$macos_icon"');
    expect(build).not.toMatch(/sips .*assets\/app-icon\.png/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
