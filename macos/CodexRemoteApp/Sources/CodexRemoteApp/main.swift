import AppKit
import CoreImage
import Darwin
import Foundation

private func bundledVersion() -> String {
  // LaunchServices can return the Info.plist of an older installed bundle when
  // two ad-hoc signed builds share one bundle identifier during an in-place
  // update. The resource travels with this executable, so it is authoritative.
  let executableResources = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("Resources", isDirectory: true)
  if let version = try? String(contentsOf: executableResources.appendingPathComponent("VERSION"), encoding: .utf8)
       .trimmingCharacters(in: .whitespacesAndNewlines),
     !version.isEmpty {
    return version
  }
  if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
     !version.isEmpty {
    return version
  }
  return "dev"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var window: NSWindow!
  private var gateway: Process?
  private var tunnel: Process?
  private var tunnelOutput: Pipe?
  private var publicURL: String?
  private var serviceGeneration = 0
  private var gatewayRestart: DispatchWorkItem?
  private var tunnelRestart: DispatchWorkItem?
  private var tunnelRestartAttempt = 0
  private var tunnelLogBuffer = ""
  private let support = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Codex Remote", isDirectory: true)
  private var passwordField = NSSecureTextField()
  private var hostField = NSTextField()
  private var addressField = NSTextField()
  private var statusLabel = NSTextField(labelWithString: "Stopped")
  private var bridgeStatusLabel = NSTextField(labelWithString: "Checking…")
  private var restartDesktopButton = NSButton(title: "Restart Desktop", target: nil, action: nil)
  private var bridgeTimer: Timer?
  private var gatewayHealthPolicy = GatewayHealthPolicy()
  private var toggle = NSButton(checkboxWithTitle: "Remote enabled", target: nil, action: nil)
  private var connectionMode = NSPopUpButton()
  private var pairingImageView = NSImageView()
  private var pairingPlaceholder = NSTextField(wrappingLabelWithString: "Generate a one-time QR code, then scan it with the iPhone or Android app.")
  private var pairingAddressLabel = NSTextField(wrappingLabelWithString: "")
  private var updateController: UpdateController!

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    configureMenu()
    configureWindow()
    loadConfiguration()
    let version = bundledVersion()
    updateController = UpdateController(currentVersion: version) { [weak self] message in self?.statusLabel.stringValue = message }
    writeUpdateReadiness(version: version)
    #if DEBUG
    if ProcessInfo.processInfo.environment["CODEX_REMOTE_UI_PREVIEW"] == "pairing" {
      toggle.state = .off
      showSettings()
      presentPairingInManagementWindow(payload: "codex-remote-preview", baseURL: "http://private-mac.local:4321")
      return
    }
    if ProcessInfo.processInfo.environment["CODEX_REMOTE_UI_PREVIEW"] == "management" {
      toggle.state = .off
      statusLabel.stringValue = "Ready to configure"
      showSettings()
      return
    }
    #endif
    if toggle.state == .on { startGateway() }
    refreshDesktopBridgeStatus()
    bridgeTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshDesktopBridgeStatus() }
    }
    if ProcessInfo.processInfo.environment["CODEX_REMOTE_BACKGROUND_LAUNCH"] != "1" {
      showSettings()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    bridgeTimer?.invalidate()
    stopGateway(force: true)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showSettings()
    return false
  }

  private func configureMenu() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menuIcon = menuBarIcon()
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
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 660), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Codex Remote"
    window.titlebarAppearsTransparent = true
    window.backgroundColor = .windowBackgroundColor
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 780, height: 640)
    window.center()
    guard let content = window.contentView else { return }

    let root = NSView()
    root.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(root)

    let iconView = NSImageView(image: appBrandIcon(size: 44))
    iconView.imageScaling = .scaleProportionallyUpOrDown
    iconView.widthAnchor.constraint(equalToConstant: 44).isActive = true
    iconView.heightAnchor.constraint(equalToConstant: 44).isActive = true
    let title = NSTextField(labelWithString: "Codex Remote")
    title.font = .systemFont(ofSize: 22, weight: .semibold)
    title.alignment = .left
    let subtitle = NSTextField(wrappingLabelWithString: "Manage secure access to the Codex Desktop sessions on this Mac.")
    subtitle.textColor = .secondaryLabelColor
    subtitle.font = .systemFont(ofSize: 12.5)
    subtitle.alignment = .left
    let titleStack = NSStackView(views: [title, subtitle])
    titleStack.orientation = .vertical
    titleStack.alignment = .leading
    titleStack.spacing = 3
    let header = NSStackView(views: [iconView, titleStack])
    header.orientation = .horizontal
    header.alignment = .centerY
    header.spacing = 12
    header.translatesAutoresizingMaskIntoConstraints = false

    toggle.target = self
    toggle.action = #selector(toggleRemote)
    toggle.title = "Enable remote access"
    toggle.setButtonType(.switch)
    hostField.placeholderString = "Private IPv4 address"
    passwordField.placeholderString = "Required for Web and app access"
    connectionMode.addItems(withTitles: ["Private network", "Public HTTPS (experimental)"])

    addressField.isEditable = false
    addressField.isSelectable = true
    addressField.isBordered = false
    addressField.drawsBackground = false
    addressField.font = .monospacedSystemFont(ofSize: 12.5, weight: .semibold)
    addressField.lineBreakMode = .byTruncatingMiddle
    let addressTitle = NSTextField(labelWithString: "Current access address")
    addressTitle.font = .systemFont(ofSize: 12, weight: .medium)
    addressTitle.textColor = .secondaryLabelColor
    addressTitle.alignment = .left
    let copyAddress = NSButton(title: "Copy", target: self, action: #selector(copyRemoteAddress))
    let openRemote = NSButton(title: "Open Remote", target: self, action: #selector(openBrowser))
    openRemote.bezelStyle = .rounded
    let addressActions = NSStackView(views: [copyAddress, openRemote])
    addressActions.orientation = .horizontal
    addressActions.spacing = 8
    let addressDetails = NSStackView(views: [addressTitle, addressField])
    addressDetails.orientation = .vertical
    addressDetails.alignment = .leading
    addressDetails.spacing = 4
    addressDetails.setContentHuggingPriority(.defaultLow, for: .horizontal)
    addressActions.setContentHuggingPriority(.required, for: .horizontal)
    let addressContent = NSStackView(views: [addressDetails, addressActions])
    addressContent.orientation = .horizontal
    addressContent.alignment = .centerY
    addressContent.spacing = 16
    let addressCard = card(content: addressContent)
    addressCard.translatesAutoresizingMaskIntoConstraints = false

    let save = NSButton(title: "Save Settings", target: self, action: #selector(saveSettings))
    save.keyEquivalent = "\r"
    save.bezelStyle = .rounded
    let update = NSButton(title: "Check for Updates", target: self, action: #selector(checkForUpdates))
    let version = NSTextField(labelWithString: "Version \(bundledVersion())")
    version.textColor = .tertiaryLabelColor
    version.font = .systemFont(ofSize: 11.5)
    let pairing = NSButton(title: "Get Link QR Code", target: self, action: #selector(showPairingQR))

    let settingsTitle = NSTextField(labelWithString: "Connection")
    settingsTitle.font = .systemFont(ofSize: 16, weight: .semibold)
    settingsTitle.alignment = .left
    let settingsHelp = NSTextField(wrappingLabelWithString: "Choose how this Mac is reached and protect it with a login token.")
    settingsHelp.font = .systemFont(ofSize: 11.5)
    settingsHelp.textColor = .secondaryLabelColor
    settingsHelp.alignment = .left
    let bridgeTitle = NSTextField(labelWithString: "Desktop bridge")
    bridgeTitle.font = .systemFont(ofSize: 12, weight: .medium)
    bridgeStatusLabel.font = .systemFont(ofSize: 11.5, weight: .medium)
    bridgeStatusLabel.textColor = .secondaryLabelColor
    restartDesktopButton.target = self
    restartDesktopButton.action = #selector(confirmDesktopRestart)
    restartDesktopButton.bezelStyle = .rounded
    let bridgeSpacer = NSView()
    bridgeSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let bridgeRow = NSStackView(views: [bridgeStatusLabel, bridgeSpacer, restartDesktopButton])
    bridgeRow.orientation = .horizontal
    bridgeRow.alignment = .centerY
    let bridgeSection = labelled(bridgeTitle, bridgeRow)
    let tokenTitle = NSTextField(labelWithString: "Authentication token")
    tokenTitle.font = .systemFont(ofSize: 12, weight: .medium)
    tokenTitle.alignment = .left
    let modeTitle = NSTextField(labelWithString: "Network mode")
    modeTitle.font = .systemFont(ofSize: 12, weight: .medium)
    modeTitle.alignment = .left
    let hostTitle = NSTextField(labelWithString: "Bind address")
    hostTitle.font = .systemFont(ofSize: 12, weight: .medium)
    hostTitle.alignment = .left
    let saveSpacer = NSView()
    saveSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let saveRow = NSStackView(views: [saveSpacer, save])
    saveRow.orientation = .horizontal
    saveRow.alignment = .centerY
    let settingsStack = NSStackView(views: [
      settingsTitle,
      settingsHelp,
      bridgeSection,
      toggle,
      labelled(modeTitle, connectionMode),
      labelled(hostTitle, hostField),
      labelled(tokenTitle, passwordField),
      saveRow,
    ])
    settingsStack.orientation = .vertical
    settingsStack.alignment = .leading
    settingsStack.spacing = 12
    for control in [bridgeSection, connectionMode, hostField, passwordField, saveRow] {
      control.widthAnchor.constraint(equalTo: settingsStack.widthAnchor).isActive = true
    }
    let settingsCard = card(content: settingsStack)
    settingsCard.translatesAutoresizingMaskIntoConstraints = false

    let pairingTitle = NSTextField(labelWithString: "Connect a mobile device")
    pairingTitle.font = .systemFont(ofSize: 16, weight: .semibold)
    pairingTitle.alignment = .left
    let pairingHelp = NSTextField(wrappingLabelWithString: "Scan a one-time code in the Codex Remote mobile app.")
    pairingHelp.font = .systemFont(ofSize: 11.5)
    pairingHelp.textColor = .secondaryLabelColor
    pairingHelp.alignment = .left
    pairingImageView.imageScaling = .scaleProportionallyUpOrDown
    pairingImageView.isHidden = true
    pairingImageView.wantsLayer = true
    pairingImageView.layer?.backgroundColor = NSColor.white.cgColor
    pairingImageView.layer?.cornerRadius = 12
    pairingImageView.widthAnchor.constraint(equalToConstant: 184).isActive = true
    pairingImageView.heightAnchor.constraint(equalToConstant: 184).isActive = true
    pairingPlaceholder.textColor = .secondaryLabelColor
    pairingPlaceholder.alignment = .center
    pairingPlaceholder.maximumNumberOfLines = 3
    pairingPlaceholder.translatesAutoresizingMaskIntoConstraints = false
    pairingAddressLabel.isHidden = true
    pairingAddressLabel.alignment = .center
    pairingAddressLabel.maximumNumberOfLines = 2
    pairingAddressLabel.font = .monospacedSystemFont(ofSize: 10.5, weight: .medium)
    let pairingStage = NSView()
    pairingStage.addSubview(pairingImageView)
    pairingStage.addSubview(pairingPlaceholder)
    pairingImageView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      pairingStage.heightAnchor.constraint(equalToConstant: 190),
      pairingImageView.centerXAnchor.constraint(equalTo: pairingStage.centerXAnchor),
      pairingImageView.centerYAnchor.constraint(equalTo: pairingStage.centerYAnchor),
      pairingPlaceholder.centerXAnchor.constraint(equalTo: pairingStage.centerXAnchor),
      pairingPlaceholder.centerYAnchor.constraint(equalTo: pairingStage.centerYAnchor),
      pairingPlaceholder.widthAnchor.constraint(lessThanOrEqualTo: pairingStage.widthAnchor, constant: -22),
    ])
    let pairingStack = NSStackView(views: [pairingTitle, pairingHelp, pairingStage, pairingAddressLabel, pairing])
    pairingStack.orientation = .vertical
    pairingStack.alignment = .width
    pairingStack.spacing = 10
    pairing.alignment = .center
    let pairingCard = card(content: pairingStack)
    pairingCard.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
    statusLabel.textColor = .secondaryLabelColor
    let footerSpacer = NSView()
    footerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let footer = NSStackView(views: [statusLabel, footerSpacer, version, update])
    footer.orientation = .horizontal
    footer.alignment = .centerY
    footer.spacing = 10
    footer.translatesAutoresizingMaskIntoConstraints = false

    [header, addressCard, settingsCard, pairingCard, footer].forEach(root.addSubview)
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      root.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
      root.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),

      header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      header.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor),
      header.topAnchor.constraint(equalTo: root.topAnchor),

      addressCard.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      addressCard.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      addressCard.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 18),
      addressCard.heightAnchor.constraint(equalToConstant: 86),

      settingsCard.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      settingsCard.topAnchor.constraint(equalTo: addressCard.bottomAnchor, constant: 16),
      settingsCard.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16),
      settingsCard.widthAnchor.constraint(equalTo: root.widthAnchor, multiplier: 0.57),

      pairingCard.leadingAnchor.constraint(equalTo: settingsCard.trailingAnchor, constant: 16),
      pairingCard.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      pairingCard.topAnchor.constraint(equalTo: settingsCard.topAnchor),
      pairingCard.bottomAnchor.constraint(equalTo: settingsCard.bottomAnchor),

      footer.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      footer.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      footer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
      footer.heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
    ])
  }

  private func card(content: NSView) -> NSBox {
    let box = NSBox()
    box.boxType = .custom
    box.borderWidth = 1
    box.cornerRadius = 16
    box.borderColor = NSColor.separatorColor.withAlphaComponent(0.58)
    box.fillColor = NSColor.controlBackgroundColor.withAlphaComponent(0.78)
    let container = NSView()
    content.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
      content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
      content.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
      content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -16),
    ])
    box.contentView = container
    return box
  }

  private func labelled(_ title: NSTextField, _ control: NSView) -> NSView {
    let stack = NSStackView(views: [title, control])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 5
    control.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    return stack
  }

  private func menuBarIcon() -> NSImage? {
    guard let iconURL = Bundle.main.url(forResource: "MenuBarIcon", withExtension: "png"),
          let image = NSImage(contentsOf: iconURL) else { return nil }
    image.size = NSSize(width: 18, height: 18)
    image.isTemplate = true
    image.accessibilityDescription = "Codex Remote"
    return image
  }

  private func appBrandIcon(size: CGFloat) -> NSImage {
    let source = NSApplication.shared.applicationIconImage
      ?? NSImage(size: NSSize(width: size, height: size))
    let image = (source.copy() as? NSImage) ?? source
    image.size = NSSize(width: size, height: size)
    return image
  }

  private func loadConfiguration() {
    let config = NSDictionary(contentsOf: support.appendingPathComponent("config.plist"))
    hostField.stringValue = config?["BindHost"] as? String ?? "127.0.0.1"
    toggle.state = (config?["RemoteEnabled"] as? Bool ?? true) ? .on : .off
    connectionMode.selectItem(at: (config?["ConnectionMode"] as? String) == "public" ? 1 : 0)
    passwordField.stringValue = (try? String(contentsOf: support.appendingPathComponent("token"), encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines)) ?? ""
    refreshAccessAddress()
  }

  @objc private func saveSettings() {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if !passwordField.stringValue.isEmpty {
      try? passwordField.stringValue.write(to: support.appendingPathComponent("token"), atomically: true, encoding: .utf8)
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: support.appendingPathComponent("token").path)
    }
    let config: NSDictionary = ["BindHost": hostField.stringValue, "Port": 4321, "RemoteEnabled": toggle.state == .on, "ConnectionMode": connectionMode.indexOfSelectedItem == 1 ? "public" : "private"]
    config.write(to: support.appendingPathComponent("config.plist"), atomically: true)
    pairingImageView.image = nil
    pairingImageView.isHidden = true
    pairingPlaceholder.isHidden = false
    pairingAddressLabel.isHidden = true
    restartGateway()
  }

  @objc private func toggleRemote() { saveSettings() }
  @objc private func showSettings() {
    refreshAccessAddress()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // AppKit otherwise promotes the first editable control in the key-view
    // loop (the private IP field) when this window becomes key. Keep the
    // window itself focused on open; users can still click any field to edit.
    window.makeFirstResponder(nil)
    DispatchQueue.main.async { [weak self] in
      self?.window.makeFirstResponder(nil)
    }
  }
  @objc private func copyRemoteAddress() {
    refreshAccessAddress()
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(addressField.stringValue, forType: .string)
    statusLabel.stringValue = "Access address copied"
  }
  @objc private func openBrowser() {
    let value = effectiveRemoteURL()
    guard let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
  }
  @objc private func checkForUpdates() { updateController.checkAndInstall() }
  private func refreshDesktopBridgeStatus() {
    guard let token = try? String(contentsOf: support.appendingPathComponent("token"), encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
      bridgeStatusLabel.stringValue = "Set a login password"
      bridgeStatusLabel.textColor = .systemOrange
      restartDesktopButton.isEnabled = true
      return
    }
    guard let url = URL(string: "http://127.0.0.1:4321/api/bridge/status") else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = 2
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      let httpResponse = response as? HTTPURLResponse
      let ready = httpResponse?.statusCode == 200 && body?["available"] as? Bool == true
      Task { @MainActor in
        guard let self else { return }
        let shouldRestartGateway = self.gatewayHealthPolicy.observe(healthy: httpResponse != nil)
        if shouldRestartGateway, self.toggle.state == .on, self.gateway?.isRunning == true {
          self.statusLabel.stringValue = "Gateway stopped responding; reconnecting…"
          self.restartGateway()
          return
        }
        self.bridgeStatusLabel.stringValue = ready ? "Connected" : "Unavailable"
        self.bridgeStatusLabel.textColor = ready ? .systemGreen : .systemOrange
        self.restartDesktopButton.isEnabled = !ready
      }
    }.resume()
  }

  @objc private func confirmDesktopRestart() {
    let alert = NSAlert()
    alert.messageText = "Restart Codex Desktop?"
    alert.informativeText = "Desktop will quit once and reopen with its loopback bridge enabled. Running work may be interrupted."
    alert.addButton(withTitle: "Restart Desktop")
    alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    restartDesktopOnce()
  }

  private func restartDesktopOnce() {
    let script = Bundle.main.resourceURL!.appendingPathComponent("restart-codex-desktop.sh")
    guard FileManager.default.isExecutableFile(atPath: script.path) else {
      bridgeStatusLabel.stringValue = "Restart helper is unavailable"
      return
    }
    restartDesktopButton.isEnabled = false
    bridgeStatusLabel.stringValue = "Restarting Desktop…"
    let process = Process()
    process.executableURL = script
    process.arguments = ["--execute"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self] process in
      Task { @MainActor in
        self?.bridgeStatusLabel.stringValue = process.terminationStatus == 0 ? "Waiting for gateway bridge…" : "Desktop restart failed"
        self?.restartDesktopButton.isEnabled = process.terminationStatus != 0
        self?.refreshDesktopBridgeStatus()
      }
    }
    do { try process.run() }
    catch {
      bridgeStatusLabel.stringValue = "Desktop restart failed"
      restartDesktopButton.isEnabled = true
    }
  }
  private func writeUpdateReadiness(version: String) {
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try? version.write(to: support.appendingPathComponent("update-ready"), atomically: true, encoding: .utf8)
  }
  private func restartGateway() {
    let oldGateway = gateway
    stopGateway()
    guard toggle.state == .on else { return }
    guard let oldGateway, oldGateway.isRunning else {
      startGateway()
      return
    }

    // A Node process with a blocked event loop can defer its JavaScript SIGTERM
    // handler indefinitely. Give it a short graceful window, then force it out
    // before starting the replacement so the PID lock and listening sockets
    // cannot strand the Remote gateway in an unavailable state.
    let oldPID = oldGateway.processIdentifier
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) { [weak self, weak oldGateway] in
      if oldGateway?.isRunning == true {
        Darwin.kill(oldPID, SIGKILL)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
        guard let self, self.toggle.state == .on, self.gateway == nil else { return }
        self.startGateway()
      }
    }
  }
  private func refreshAccessAddress() { addressField.stringValue = effectiveRemoteURL() }
  private func startGateway() {
    guard gateway == nil else { return }
    let generation = serviceGeneration
    let resources = Bundle.main.resourceURL!
    let process = Process(); process.executableURL = resources.appendingPathComponent("launch-gateway.sh")
    let isPublic = connectionMode.indexOfSelectedItem == 1
    process.arguments = [isPublic ? "127.0.0.1" : hostField.stringValue, "4321"]
    var env = ProcessInfo.processInfo.environment
    env["ACCESS_TOKEN_FILE"] = support.appendingPathComponent("token").path
    env["CODEX_REMOTE_GATEWAY_PID_FILE"] = support.appendingPathComponent("gateway.pid").path
    env["CODEX_REMOTE_PUBLIC_TUNNEL"] = isPublic ? "1" : "0"
    process.environment = env; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    process.terminationHandler = { [weak self, weak process] _ in
      guard let process else { return }
      Task { @MainActor in self?.gatewayDidExit(process, generation: generation) }
    }
    do {
      try process.run(); gateway = process
      if isPublic { startTunnel() }
      else { statusLabel.stringValue = "Remote is running"; refreshAccessAddress() }
    } catch { statusLabel.stringValue = "Failed: \(error.localizedDescription)" }
  }
  private func stopGateway(force: Bool = false) {
    serviceGeneration += 1
    gatewayRestart?.cancel(); gatewayRestart = nil
    tunnelRestart?.cancel(); tunnelRestart = nil
    stopTunnel()
    gateway?.terminationHandler = nil
    if let gateway {
      let pid = gateway.processIdentifier
      gateway.terminate()
      if force, gateway.isRunning {
        Darwin.kill(pid, SIGKILL)
      }
    }
    gateway = nil
    statusLabel.stringValue = "Stopped"
    refreshAccessAddress()
  }

  private func gatewayDidExit(_ process: Process, generation: Int) {
    guard gateway === process else { return }
    gateway = nil
    stopTunnel()
    guard generation == serviceGeneration, toggle.state == .on else { return }
    statusLabel.stringValue = "Gateway stopped; reconnecting…"
    let work = DispatchWorkItem { [weak self] in
      Task { @MainActor in self?.startGateway() }
    }
    gatewayRestart = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
  }

  private func effectiveRemoteURL() -> String {
    publicURL ?? "http://\(hostField.stringValue):4321"
  }

  private func startTunnel() {
    guard tunnel == nil else { return }
    let generation = serviceGeneration
    let binary = Bundle.main.resourceURL!.appendingPathComponent("bin/cloudflared")
    guard FileManager.default.isExecutableFile(atPath: binary.path) else {
      statusLabel.stringValue = "Public HTTPS helper is unavailable in this build"; return
    }
    publicURL = nil
    tunnelLogBuffer = ""
    let output = Pipe()
    let process = Process()
    process.executableURL = binary
    process.arguments = ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321"]
    process.standardOutput = output
    process.standardError = output
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let text = String(decoding: handle.availableData, as: UTF8.self)
      guard !text.isEmpty else { return }
      Task { @MainActor in self?.consumeTunnelOutput(text) }
    }
    process.terminationHandler = { [weak self, weak process] _ in
      guard let process else { return }
      Task { @MainActor in self?.tunnelDidExit(process, generation: generation) }
    }
    do { try process.run(); tunnel = process; tunnelOutput = output; statusLabel.stringValue = "Starting public HTTPS…" }
    catch { statusLabel.stringValue = "Public HTTPS failed: \(error.localizedDescription)" }
  }

  private func consumeTunnelOutput(_ text: String) {
    tunnelLogBuffer = String((tunnelLogBuffer + text).suffix(16_384))
    guard let match = tunnelLogBuffer.range(of: #"https://[a-z0-9-]+\.trycloudflare\.com"#, options: .regularExpression) else { return }
    let url = String(tunnelLogBuffer[match])
    publicURL = url
    tunnelRestartAttempt = 0
    statusLabel.stringValue = "Running at \(url)"
    refreshAccessAddress()
  }

  private func tunnelDidExit(_ process: Process, generation: Int) {
    guard tunnel === process else { return }
    tunnelOutput?.fileHandleForReading.readabilityHandler = nil
    tunnel = nil; tunnelOutput = nil; publicURL = nil
    guard generation == serviceGeneration, toggle.state == .on,
          connectionMode.indexOfSelectedItem == 1, gateway?.isRunning == true else { return }
    tunnelRestartAttempt += 1
    let delay = min(pow(2.0, Double(tunnelRestartAttempt - 1)), 30)
    statusLabel.stringValue = "Public HTTPS disconnected; retrying in \(Int(delay))s…"
    let work = DispatchWorkItem { [weak self] in
      Task { @MainActor in self?.startTunnel() }
    }
    tunnelRestart = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func stopTunnel() {
    tunnelRestart?.cancel(); tunnelRestart = nil
    tunnelOutput?.fileHandleForReading.readabilityHandler = nil
    tunnel?.terminationHandler = nil
    tunnel?.terminate(); tunnel = nil; tunnelOutput = nil; publicURL = nil
    tunnelLogBuffer = ""
    refreshAccessAddress()
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
      Task { @MainActor in self?.presentPairingInManagementWindow(payload: payload, baseURL: baseURL) }
    }.resume()
  }

  private func presentPairingInManagementWindow(payload: String, baseURL: String) {
    guard let image = qrImage(payload) else { statusLabel.stringValue = "Could not render pairing code"; return }
    pairingImageView.image = image
    pairingImageView.isHidden = false
    pairingPlaceholder.isHidden = true
    pairingAddressLabel.stringValue = baseURL
    pairingAddressLabel.isHidden = false
    statusLabel.stringValue = "Pairing code expires in 5 minutes and works once"
    showSettings()
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

if CommandLine.arguments.contains("--self-test") {
  do {
    try runUpdateSelfTest(requirePackagedResources: Bundle.main.bundleURL.pathExtension == "app")
    print("Codex Remote self-test passed (\(try currentArchitecture()))")
    exit(0)
  } catch {
    fputs("Codex Remote self-test failed: \(error.localizedDescription)\n", stderr)
    exit(1)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
