import AppKit

// NSImage templates use alpha, not color: turn the white mark into coverage
// rather than treating the shared asset's opaque black background as artwork.
let source = NSImage(contentsOfFile: CommandLine.arguments[1])!
let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: 36, pixelsHigh: 36,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.clear(CGRect(x: 0, y: 0, width: 36, height: 36))
context.imageInterpolation = .high
source.draw(in: NSRect(x: 0, y: 0, width: 36, height: 36), from: .zero, operation: .sourceOver, fraction: 1)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
for y in 0..<36 {
  for x in 0..<36 {
    let color = bitmap.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
    let luminance = 0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent
    // Remove near-black texture noise while retaining antialiased mark edges.
    let alpha = min(1, max(0, (luminance - 0.05) / 0.90)) * color.alphaComponent
    bitmap.setColor(NSColor(deviceRed: 0, green: 0, blue: 0, alpha: alpha), atX: x, y: y)
  }
}
try bitmap.representation(using: .png, properties: [:])!.write(
  to: URL(fileURLWithPath: CommandLine.arguments[2])
)
