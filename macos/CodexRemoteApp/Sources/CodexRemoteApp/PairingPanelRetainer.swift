import AppKit

@MainActor
final class PairingPanelRetainer: NSObject, NSWindowDelegate {
  private(set) var panel: NSPanel?

  func retain(_ panel: NSPanel) {
    if let current = self.panel, current !== panel {
      current.delegate = nil
      current.close()
    }
    self.panel = panel
    panel.delegate = self
  }

  func releasePanel() {
    panel?.delegate = nil
    panel = nil
  }

  func windowWillClose(_ notification: Notification) {
    releasePanel()
  }
}
