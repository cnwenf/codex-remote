// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CodexRemoteApp",
  platforms: [.macOS(.v13)],
  targets: [.executableTarget(name: "CodexRemoteApp")]
)
