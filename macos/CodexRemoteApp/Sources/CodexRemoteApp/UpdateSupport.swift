import AppKit
import CryptoKit
import Foundation

enum UpdateError: LocalizedError {
  case invalidReleaseURL
  case invalidChecksum
  case checksumMismatch
  case unsupportedArchitecture
  case invalidPackage(String)
  case commandFailed(String)

  var errorDescription: String? {
    switch self {
    case .invalidReleaseURL: return "GitHub did not return a valid Codex Remote release."
    case .invalidChecksum: return "The release checksum is missing or invalid."
    case .checksumMismatch: return "The downloaded DMG failed SHA-256 verification."
    case .unsupportedArchitecture: return "This Mac architecture is not supported."
    case .invalidPackage(let detail): return "The downloaded app is invalid: \(detail)"
    case .commandFailed(let detail): return detail
    }
  }
}

func compareReleaseVersions(_ lhs: String, _ rhs: String) -> ComparisonResult {
  let left = lhs.trimmingCharacters(in: CharacterSet(charactersIn: "vV")).split(separator: ".").map { Int($0) ?? 0 }
  let right = rhs.trimmingCharacters(in: CharacterSet(charactersIn: "vV")).split(separator: ".").map { Int($0) ?? 0 }
  for index in 0..<max(left.count, right.count) {
    let a = index < left.count ? left[index] : 0
    let b = index < right.count ? right[index] : 0
    if a < b { return .orderedAscending }
    if a > b { return .orderedDescending }
  }
  return .orderedSame
}

func releaseVersion(from url: URL) throws -> String {
  guard url.scheme == "https", url.host == "github.com" else { throw UpdateError.invalidReleaseURL }
  let components = url.pathComponents
  guard components.count == 6,
        components[1] == "cnwenf", components[2] == "codex-remote",
        components[3] == "releases", components[4] == "tag" else {
    throw UpdateError.invalidReleaseURL
  }
  let version = components[5].trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
  guard !version.isEmpty, version.split(separator: ".").allSatisfy({ Int($0) != nil }) else {
    throw UpdateError.invalidReleaseURL
  }
  return version
}

func expectedChecksum(from manifest: String, asset: String) throws -> String {
  for line in manifest.split(whereSeparator: \Character.isNewline) {
    let fields = line.split(whereSeparator: \Character.isWhitespace)
    guard fields.count >= 2 else { continue }
    let digest = String(fields[0]).lowercased()
    let filename = String(fields[fields.count - 1]).trimmingCharacters(in: CharacterSet(charactersIn: "*"))
    if filename == asset, digest.count == 64, digest.allSatisfy({ $0.isHexDigit }) { return digest }
  }
  throw UpdateError.invalidChecksum
}

func sha256(of file: URL) throws -> String {
  let handle = try FileHandle(forReadingFrom: file)
  defer { try? handle.close() }
  var hash = SHA256()
  while true {
    let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
    if data.isEmpty { break }
    hash.update(data: data)
  }
  return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

func currentArchitecture() throws -> String {
  #if arch(arm64)
  return "arm64"
  #elseif arch(x86_64)
  return "x86_64"
  #else
  throw UpdateError.unsupportedArchitecture
  #endif
}

struct CommandResult {
  let output: String
  let status: Int32
}

@discardableResult
func runCommand(_ executable: String, _ arguments: [String]) throws -> CommandResult {
  let process = Process()
  let pipe = Pipe()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  process.standardOutput = pipe
  process.standardError = pipe
  try process.run()
  process.waitUntilExit()
  let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  guard process.terminationStatus == 0 else {
    throw UpdateError.commandFailed(output.trimmingCharacters(in: .whitespacesAndNewlines))
  }
  return CommandResult(output: output, status: process.terminationStatus)
}

@MainActor
final class UpdateController {
  private let currentVersion: String
  private let status: (String) -> Void
  private var checking = false

  init(currentVersion: String, status: @escaping (String) -> Void) {
    self.currentVersion = currentVersion
    self.status = status
  }

  func checkAndInstall() {
    guard !checking else { return }
    checking = true
    status("Checking for updates…")
    Task {
      do {
        let version = try await latestVersion()
        guard compareReleaseVersions(version, currentVersion) == .orderedDescending else {
          status("Codex Remote \(currentVersion) is up to date")
          checking = false
          return
        }
        status("Downloading Codex Remote \(version)…")
        let staged = try await downloadAndStage(version: version)
        status("Installing Codex Remote \(version)…")
        try launchInstaller(stagedApp: staged, version: version)
        NSApp.terminate(nil)
      } catch {
        status("Update failed: \(error.localizedDescription)")
        checking = false
      }
    }
  }

  private func latestVersion() async throws -> String {
    var request = URLRequest(url: URL(string: "https://github.com/cnwenf/codex-remote/releases/latest")!)
    request.httpMethod = "HEAD"
    let (_, response) = try await URLSession.shared.data(for: request)
    guard let url = response.url else { throw UpdateError.invalidReleaseURL }
    return try releaseVersion(from: url)
  }

  private func downloadAndStage(version: String) async throws -> URL {
    let arch = try currentArchitecture()
    let asset = "Codex-Remote-\(arch).dmg"
    let base = "https://github.com/cnwenf/codex-remote/releases/download/v\(version)"
    let (checksumData, checksumResponse) = try await URLSession.shared.data(from: URL(string: "\(base)/\(asset).sha256")!)
    guard (checksumResponse as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.invalidChecksum }
    let expected = try expectedChecksum(from: String(decoding: checksumData, as: UTF8.self), asset: asset)
    let (download, response) = try await URLSession.shared.download(from: URL(string: "\(base)/\(asset)")!)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.invalidPackage("download failed") }

    let root = FileManager.default.temporaryDirectory.appendingPathComponent("codex-remote-update-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let dmg = root.appendingPathComponent(asset)
    try FileManager.default.moveItem(at: download, to: dmg)
    guard try sha256(of: dmg) == expected else { throw UpdateError.checksumMismatch }

    let mount = root.appendingPathComponent("mount", isDirectory: true)
    try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
    try runCommand("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-mountpoint", mount.path, "-quiet"])
    defer { _ = try? runCommand("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"]) }
    let source = mount.appendingPathComponent("Codex Remote.app", isDirectory: true)
    guard FileManager.default.fileExists(atPath: source.path) else { throw UpdateError.invalidPackage("app is missing") }
    try runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", source.path])
    let binary = source.appendingPathComponent("Contents/MacOS/Codex Remote")
    let fileInfo = try runCommand("/usr/bin/file", [binary.path]).output
    guard fileInfo.contains(arch) else { throw UpdateError.invalidPackage("architecture mismatch") }
    let staged = root.appendingPathComponent("Codex Remote.app", isDirectory: true)
    try runCommand("/usr/bin/ditto", [source.path, staged.path])
    return staged
  }

  private func launchInstaller(stagedApp: URL, version: String) throws {
    let currentApp = Bundle.main.bundleURL
    guard currentApp.pathExtension == "app", FileManager.default.isWritableFile(atPath: currentApp.deletingLastPathComponent().path) else {
      throw UpdateError.invalidPackage("Codex Remote must be installed in a writable Applications folder")
    }
    guard let script = Bundle.main.url(forResource: "perform-macos-update", withExtension: "sh") else {
      throw UpdateError.invalidPackage("updater helper is missing")
    }
    let copiedScript = stagedApp.deletingLastPathComponent().appendingPathComponent("perform-macos-update.sh")
    try FileManager.default.copyItem(at: script, to: copiedScript)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: copiedScript.path)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = [copiedScript.path, String(ProcessInfo.processInfo.processIdentifier), currentApp.path, stagedApp.path, version]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
  }
}

func runUpdateSelfTest(requirePackagedResources: Bool) throws {
  guard compareReleaseVersions("0.3.10", "0.3.9") == .orderedDescending,
        compareReleaseVersions("v1.0.0", "1.0.0") == .orderedSame,
        compareReleaseVersions("1.2", "1.2.1") == .orderedAscending else {
    throw UpdateError.invalidPackage("version comparison self-test failed")
  }
  guard try releaseVersion(from: URL(string: "https://github.com/cnwenf/codex-remote/releases/tag/v0.4.0")!) == "0.4.0" else {
    throw UpdateError.invalidPackage("release URL self-test failed")
  }
  let asset = "Codex-Remote-\(try currentArchitecture()).dmg"
  let digest = String(repeating: "a", count: 64)
  guard try expectedChecksum(from: "\(digest)  \(asset)\n", asset: asset) == digest else {
    throw UpdateError.invalidPackage("checksum manifest self-test failed")
  }
  guard requirePackagedResources else { return }
  guard let resources = Bundle.main.resourceURL else { throw UpdateError.invalidPackage("resources are missing") }
  for relative in ["bin/node", "gateway/index.mjs", "web/index.html", "launch-gateway.sh", "perform-macos-update.sh", "MenuBarIcon.png"] {
    guard FileManager.default.fileExists(atPath: resources.appendingPathComponent(relative).path) else {
      throw UpdateError.invalidPackage("packaged resource \(relative) is missing")
    }
  }
  if FileManager.default.fileExists(atPath: resources.appendingPathComponent("bin/cloudflared").path) {
    let info = try runCommand("/usr/bin/file", [resources.appendingPathComponent("bin/cloudflared").path]).output
    guard info.contains(try currentArchitecture()) else { throw UpdateError.invalidPackage("cloudflared architecture mismatch") }
  }
}
