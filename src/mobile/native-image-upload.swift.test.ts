// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")("the Swift upload delegate reports sent bytes and still refuses redirects", () => {
  const source = readFileSync("ios/App/CapApp-SPM/Sources/CapApp-SPM/CodexRemoteNativePlugin.swift", "utf8");
  // Compile the actual Foundation-only delegate, without needing an iOS simulator.
  const delegate = source.slice(source.indexOf("private final class NoRedirectSessionDelegate"), source.indexOf("private final class CodexRemoteQRScannerViewController"));
  const directory = mkdtempSync(join(tmpdir(), "native-image-progress-"));
  try {
    writeFileSync(join(directory, "main.swift"), `import Foundation
${delegate}
private let delegate = NoRedirectSessionDelegate(onProgress: { loaded, total in
    print("progress \\(loaded)/\\(total)")
})
let session = URLSession(configuration: .ephemeral)
let url = URL(string: "https://example.test/api/images")!
let task = session.uploadTask(with: URLRequest(url: url), from: Data([1, 2, 3, 4, 5]))
delegate.urlSession(session, task: task, didSendBodyData: 2, totalBytesSent: 2, totalBytesExpectedToSend: 5)
delegate.urlSession(session, task: task, didSendBodyData: 3, totalBytesSent: 5, totalBytesExpectedToSend: 5)
let response = HTTPURLResponse(url: url, statusCode: 307, httpVersion: nil, headerFields: nil)!
delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
    newRequest: URLRequest(url: URL(string: "https://other.test/api/images")!)) { redirected in
    precondition(redirected == nil)
    print("redirect refused")
}
session.invalidateAndCancel()
`);
    const output = execFileSync("xcrun", ["swift", "-swift-version", "5", join(directory, "main.swift")], { encoding: "utf8", timeout: 60_000 });
    expect(output.trim()).toBe("progress 2/5\nprogress 5/5\nredirect refused");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 75_000);
