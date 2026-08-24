import AppKit
import Foundation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var window: NSWindow!
  private var gateway: Process?
  private let support = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Codex Remote", isDirectory: true)
  private var passwordField = NSSecureTextField()
  private var hostField = NSTextField()
  private var statusLabel = NSTextField(labelWithString: "Stopped")
  private var toggle = NSButton(checkboxWithTitle: "Remote enabled", target: nil, action: nil)

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    configureMenu()
    configureWindow()
    loadConfiguration()
    if toggle.state == .on { startGateway() }
  }

  func applicationWillTerminate(_ notification: Notification) { stopGateway() }

  private func configureMenu() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menuIcon = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("MenuIcon.png")) ?? NSImage(systemSymbolName: "dot.radiowaves.right", accessibilityDescription: "Codex Remote")
    menuIcon?.isTemplate = true
    statusItem.button?.image = menuIcon
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Codex Remote", action: #selector(showSettings), keyEquivalent: "")
    menu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
    menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    statusItem.menu = menu
  }

  private func configureWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 300), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Codex Remote"
    window.center()
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    toggle.target = self
    toggle.action = #selector(toggleRemote)
    hostField.placeholderString = "Private IPv4 address"
    passwordField.placeholderString = "Web login password"
    let save = NSButton(title: "Save Settings", target: self, action: #selector(saveSettings))
    let update = NSButton(title: "Check for Updates", target: self, action: #selector(checkForUpdates))
    let version = NSTextField(labelWithString: "Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")")
    [toggle, labelled("Address", hostField), labelled("Password", passwordField), statusLabel, version, save, update].forEach(stack.addArrangedSubview)
    window.contentView?.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
  }

  private func labelled(_ title: String, _ field: NSTextField) -> NSView {
    let row = NSStackView(views: [NSTextField(labelWithString: title), field]); row.orientation = .horizontal; row.spacing = 12; field.widthAnchor.constraint(equalToConstant: 300).isActive = true; return row
  }

  private func loadConfiguration() {
    let config = NSDictionary(contentsOf: support.appendingPathComponent("config.plist"))
    hostField.stringValue = config?["BindHost"] as? String ?? "127.0.0.1"
    toggle.state = (config?["RemoteEnabled"] as? Bool ?? true) ? .on : .off
  }

  @objc private func saveSettings() {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if !passwordField.stringValue.isEmpty {
      try? passwordField.stringValue.write(to: support.appendingPathComponent("token"), atomically: true, encoding: .utf8)
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: support.appendingPathComponent("token").path)
    }
    let config: NSDictionary = ["BindHost": hostField.stringValue, "Port": 4321, "RemoteEnabled": toggle.state == .on]
    config.write(to: support.appendingPathComponent("config.plist"), atomically: true)
    restartGateway()
  }

  @objc private func toggleRemote() { saveSettings(); if toggle.state == .on { startGateway() } else { stopGateway() } }
  @objc private func showSettings() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
  @objc private func openBrowser() { NSWorkspace.shared.open(URL(string: "http://\(hostField.stringValue):4321")!) }
  @objc private func checkForUpdates() { NSWorkspace.shared.open(URL(string: "https://github.com/cnwenf/codex-remote/releases/latest")!) }
  private func restartGateway() { stopGateway(); if toggle.state == .on { startGateway() } }
  private func startGateway() {
    guard gateway == nil else { return }
    let resources = Bundle.main.resourceURL!
    let process = Process(); process.executableURL = resources.appendingPathComponent("launch-gateway.sh")
    process.arguments = [hostField.stringValue, "4321"]
    var env = ProcessInfo.processInfo.environment
    env["ACCESS_TOKEN_FILE"] = support.appendingPathComponent("token").path
    process.environment = env; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    do { try process.run(); gateway = process; statusLabel.stringValue = "Running at http://\(hostField.stringValue):4321" } catch { statusLabel.stringValue = "Failed: \(error.localizedDescription)" }
  }
  private func stopGateway() { gateway?.terminate(); gateway = nil; statusLabel.stringValue = "Stopped" }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
