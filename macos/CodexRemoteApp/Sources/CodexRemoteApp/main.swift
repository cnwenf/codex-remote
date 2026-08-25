import AppKit
import CoreImage
import Foundation

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var window: NSWindow!
  private var gateway: Process?
  private var tunnel: Process?
  private var tunnelOutput: Pipe?
  private var publicURL: String?
  private let support = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Codex Remote", isDirectory: true)
  private var passwordField = NSSecureTextField()
  private var hostField = NSTextField()
  private var statusLabel = NSTextField(labelWithString: "Stopped")
  private var toggle = NSButton(checkboxWithTitle: "Remote enabled", target: nil, action: nil)
  private var connectionMode = NSPopUpButton()

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    configureMenu()
    configureWindow()
    loadConfiguration()
    if toggle.state == .on { startGateway() }
  }

  func applicationWillTerminate(_ notification: Notification) { stopGateway() }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openBrowser()
    return false
  }

  private func configureMenu() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 16, weight: .regular)
    let menuIcon = NSImage(systemSymbolName: "dot.radiowaves.right", accessibilityDescription: "Codex Remote")?
      .withSymbolConfiguration(symbolConfiguration)
    menuIcon?.isTemplate = true
    statusItem.button?.image = menuIcon
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Codex Remote", action: #selector(showSettings), keyEquivalent: "")
    menu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "")
    menu.addItem(withTitle: "Show Pairing QR…", action: #selector(showPairingQR), keyEquivalent: "")
    menu.addItem(.separator())
    menu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
    menu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    statusItem.menu = menu
  }

  private func configureWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 370), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
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
    connectionMode.addItems(withTitles: ["Private network", "Public HTTPS (experimental)"])
    let save = NSButton(title: "Save Settings", target: self, action: #selector(saveSettings))
    let update = NSButton(title: "Check for Updates", target: self, action: #selector(checkForUpdates))
    let version = NSTextField(labelWithString: "Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")")
    let pairing = NSButton(title: "Show Pairing QR", target: self, action: #selector(showPairingQR))
    [toggle, labelled("Connection", connectionMode), labelled("Address", hostField), labelled("Password", passwordField), statusLabel, version, save, pairing, update].forEach(stack.addArrangedSubview)
    window.contentView?.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
  }

  private func labelled(_ title: String, _ field: NSTextField) -> NSView {
    let row = NSStackView(views: [NSTextField(labelWithString: title), field]); row.orientation = .horizontal; row.spacing = 12; field.widthAnchor.constraint(equalToConstant: 300).isActive = true; return row
  }

  private func labelled(_ title: String, _ control: NSView) -> NSView {
    let row = NSStackView(views: [NSTextField(labelWithString: title), control]); row.orientation = .horizontal; row.spacing = 12; control.widthAnchor.constraint(equalToConstant: 300).isActive = true; return row
  }

  private func loadConfiguration() {
    let config = NSDictionary(contentsOf: support.appendingPathComponent("config.plist"))
    hostField.stringValue = config?["BindHost"] as? String ?? "127.0.0.1"
    toggle.state = (config?["RemoteEnabled"] as? Bool ?? true) ? .on : .off
    connectionMode.selectItem(at: (config?["ConnectionMode"] as? String) == "public" ? 1 : 0)
  }

  @objc private func saveSettings() {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if !passwordField.stringValue.isEmpty {
      try? passwordField.stringValue.write(to: support.appendingPathComponent("token"), atomically: true, encoding: .utf8)
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: support.appendingPathComponent("token").path)
    }
    let config: NSDictionary = ["BindHost": hostField.stringValue, "Port": 4321, "RemoteEnabled": toggle.state == .on, "ConnectionMode": connectionMode.indexOfSelectedItem == 1 ? "public" : "private"]
    config.write(to: support.appendingPathComponent("config.plist"), atomically: true)
    restartGateway()
  }

  @objc private func toggleRemote() { saveSettings(); if toggle.state == .on { startGateway() } else { stopGateway() } }
  @objc private func showSettings() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
  @objc private func openBrowser() {
    let value = effectiveRemoteURL()
    guard let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
  }
  @objc private func checkForUpdates() { NSWorkspace.shared.open(URL(string: "https://github.com/cnwenf/codex-remote/releases/latest")!) }
  private func restartGateway() { stopGateway(); if toggle.state == .on { startGateway() } }
  private func startGateway() {
    guard gateway == nil else { return }
    let resources = Bundle.main.resourceURL!
    let process = Process(); process.executableURL = resources.appendingPathComponent("launch-gateway.sh")
    let isPublic = connectionMode.indexOfSelectedItem == 1
    process.arguments = [isPublic ? "127.0.0.1" : hostField.stringValue, "4321"]
    var env = ProcessInfo.processInfo.environment
    env["ACCESS_TOKEN_FILE"] = support.appendingPathComponent("token").path
    env["CODEX_REMOTE_GATEWAY_PID_FILE"] = support.appendingPathComponent("gateway.pid").path
    env["CODEX_REMOTE_PUBLIC_TUNNEL"] = isPublic ? "1" : "0"
    process.environment = env; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    do {
      try process.run(); gateway = process
      if isPublic { startTunnel() }
      else { statusLabel.stringValue = "Running at \(effectiveRemoteURL())" }
    } catch { statusLabel.stringValue = "Failed: \(error.localizedDescription)" }
  }
  private func stopGateway() { stopTunnel(); gateway?.terminate(); gateway = nil; statusLabel.stringValue = "Stopped" }

  private func effectiveRemoteURL() -> String {
    publicURL ?? "http://\(hostField.stringValue):4321"
  }

  private func startTunnel() {
    guard tunnel == nil else { return }
    let binary = Bundle.main.resourceURL!.appendingPathComponent("bin/cloudflared")
    guard FileManager.default.isExecutableFile(atPath: binary.path) else {
      statusLabel.stringValue = "Public HTTPS helper is unavailable in this build"; return
    }
    publicURL = nil
    let output = Pipe()
    let process = Process()
    process.executableURL = binary
    process.arguments = ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321"]
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let text = String(decoding: handle.availableData, as: UTF8.self)
      guard let match = text.range(of: #"https://[a-z0-9-]+\.trycloudflare\.com"#, options: .regularExpression) else { return }
      let url = String(text[match])
      Task { @MainActor in self?.publicURL = url; self?.statusLabel.stringValue = "Running at \(url)" }
    }
    do { try process.run(); tunnel = process; tunnelOutput = output; statusLabel.stringValue = "Starting public HTTPS…" }
    catch { statusLabel.stringValue = "Public HTTPS failed: \(error.localizedDescription)" }
  }

  private func stopTunnel() {
    tunnelOutput?.fileHandleForReading.readabilityHandler = nil
    tunnel?.terminate(); tunnel = nil; tunnelOutput = nil; publicURL = nil
  }

  @objc private func showPairingQR() {
    let baseURL = effectiveRemoteURL()
    guard connectionMode.indexOfSelectedItem == 0 || publicURL != nil else {
      statusLabel.stringValue = "Wait for the public HTTPS address"; showSettings(); return
    }
    guard let token = try? String(contentsOf: support.appendingPathComponent("token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
      statusLabel.stringValue = "Set a login password first"; showSettings(); return
    }
    var request = URLRequest(url: URL(string: "http://127.0.0.1:4321/api/mobile/pairing")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["baseUrl": baseURL])
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      guard let response = response as? HTTPURLResponse, response.statusCode == 201,
            let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let payload = body["payload"] as? String else {
        Task { @MainActor in self?.statusLabel.stringValue = "Could not create pairing code" }
        return
      }
      Task { @MainActor in self?.presentPairingWindow(payload: payload, baseURL: baseURL) }
    }.resume()
  }

  private func presentPairingWindow(payload: String, baseURL: String) {
    guard let image = qrImage(payload) else { statusLabel.stringValue = "Could not render pairing code"; return }
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 390, height: 460), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    panel.title = "Pair Codex Remote"
    let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .centerX; stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = false
    let imageView = NSImageView(image: image); imageView.widthAnchor.constraint(equalToConstant: 300).isActive = true; imageView.heightAnchor.constraint(equalToConstant: 300).isActive = true
    let address = NSTextField(wrappingLabelWithString: baseURL); address.alignment = .center; address.maximumNumberOfLines = 2
    let note = NSTextField(labelWithString: "Scan in the iPhone or Android app. Expires in 5 minutes and works once."); note.textColor = .secondaryLabelColor
    stack.addArrangedSubview(imageView); stack.addArrangedSubview(address); stack.addArrangedSubview(note)
    panel.contentView?.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 24)])
    panel.center(); panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
  }

  private func qrImage(_ value: String) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(value.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else { return nil }
    let representation = NSCIImageRep(ciImage: output)
    let image = NSImage(size: representation.size); image.addRepresentation(representation); return image
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
