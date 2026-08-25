import AppKit

@main
struct PairingPanelLifetimeTest {
  @MainActor
  static func main() {
    let retainer = PairingPanelRetainer()
    weak var observedPanel: NSPanel?

    autoreleasepool {
      let panel = NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 390, height: 460),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
      )
      observedPanel = panel
      retainer.retain(panel)
    }

    precondition(observedPanel != nil, "pairing panel was released before it could be scanned")
    retainer.releasePanel()
    precondition(observedPanel == nil, "pairing panel remained retained after closing")
  }
}
