import AppKit

// Legacy ICNS artwork needs its own rounded tile and transparent Dock padding.
// Keep the shared brand/menu-bar asset unchanged.
let source = NSImage(contentsOfFile: CommandLine.arguments[1])!
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
shape.addClip()
NSColor.black.setFill()
shape.fill()
context.imageInterpolation = .high
source.draw(in: tile, from: .zero, operation: .sourceOver, fraction: 1)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(
  to: URL(fileURLWithPath: CommandLine.arguments[2])
)
