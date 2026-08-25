import BackgroundTasks
import AVFoundation
import Capacitor
import Foundation
import Security
import UIKit
import UserNotifications

private let monitorTaskIdentifier = "com.cnwenf.codexremote.refresh"
private let monitorDefaultsKey = "codex-remote.monitor.v1"
private let monitorStatesKey = "codex-remote.monitor.states.v1"
private let launchTargetKey = "codex-remote.launch-target.v1"
private let openThreadNotification = Notification.Name("CodexRemoteOpenThread")

@objc(CodexRemoteNativePlugin)
public final class CodexRemoteNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CodexRemoteNativePlugin"
    public let jsName = "CodexRemoteNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "readSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLaunchTarget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternalUrl", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(openThread(_:)),
            name: openThreadNotification,
            object: nil
        )
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc public func readSecret(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.reject("id-required"); return }
        do {
            if let value = try CodexRemoteKeychain.read(id: id) { call.resolve(["value": value]) }
            else { call.resolve() }
        } catch { call.reject("secure-storage-read-failed", nil, error) }
    }

    @objc public func writeSecret(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let value = call.getString("value"), !id.isEmpty, !value.isEmpty else {
            call.reject("secret-required"); return
        }
        do { try CodexRemoteKeychain.write(id: id, value: value); call.resolve() }
        catch { call.reject("secure-storage-write-failed", nil, error) }
    }

    @objc public func removeSecret(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.reject("id-required"); return }
        CodexRemoteKeychain.remove(id: id)
        call.resolve()
    }

    @objc public func startMonitoring(_ call: CAPPluginCall) {
        guard
            let id = call.getString("connectionId"),
            let name = call.getString("name"),
            let baseURL = call.getString("baseUrl"),
            let token = call.getString("token")
        else { call.reject("monitor-options-required"); return }
        do {
            try CodexRemoteKeychain.write(id: id, value: token)
            UserDefaults.standard.set(["connectionId": id, "name": name, "baseUrl": baseURL], forKey: monitorDefaultsKey)
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
            CodexRemoteMonitor.refresh { _ in CodexRemoteMonitor.schedule() }
            call.resolve()
        } catch { call.reject("monitor-start-failed", nil, error) }
    }

    @objc public func stopMonitoring(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: monitorDefaultsKey)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: monitorTaskIdentifier)
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["codex-remote-running-summary"])
        center.removeDeliveredNotifications(withIdentifiers: ["codex-remote-running-summary"])
        call.resolve()
    }

    @objc public func getLaunchTarget(_ call: CAPPluginCall) {
        guard let target = UserDefaults.standard.dictionary(forKey: launchTargetKey) else { call.resolve(); return }
        UserDefaults.standard.removeObject(forKey: launchTargetKey)
        call.resolve(target)
    }

    @objc public func scanConnection(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else {
                call.reject("pairing-scanner-unavailable"); return
            }
            let scanner = CodexRemoteQRScannerViewController()
            scanner.onResult = { value in
                scanner.dismiss(animated: true) {
                    if let value { call.resolve(["value": value]) }
                    else { call.reject("pairing-scan-cancelled") }
                }
            }
            presenter.present(scanner, animated: true)
        }
    }

    @objc public func openExternalUrl(_ call: CAPPluginCall) {
        guard
            let value = call.getString("url"),
            let url = URL(string: value),
            url.scheme?.lowercased() == "https"
        else { call.reject("external-url-insecure"); return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() }
                else { call.reject("external-url-open-failed") }
            }
        }
    }

    @objc private func openThread(_ notification: Notification) {
        guard let target = notification.userInfo as? [String: String] else { return }
        notifyListeners("openThread", data: target)
    }
}

private final class CodexRemoteQRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onResult: ((String?) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.tintColor = .white
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        view.addSubview(cancel)
        NSLayoutConstraint.activate([
            cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            cancel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
        configureCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    private func configureCamera() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else { onResult?(nil); return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { onResult?(nil); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.session.startRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = code.stringValue else { return }
        session.stopRunning()
        onResult?(value)
        onResult = nil
    }

    @objc private func cancelScan() { session.stopRunning(); onResult?(nil); onResult = nil }
}

public enum CodexRemoteMonitor {
    public static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: monitorTaskIdentifier, using: nil) { task in
            guard let refreshTask = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            refreshTask.expirationHandler = { refreshTask.setTaskCompleted(success: false) }
            refresh { success in
                refreshTask.setTaskCompleted(success: success)
                schedule()
            }
        }
    }

    public static func schedule() {
        guard UserDefaults.standard.dictionary(forKey: monitorDefaultsKey) != nil else { return }
        let request = BGAppRefreshTaskRequest(identifier: monitorTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    public static func refresh(completion: @escaping (Bool) -> Void = { _ in }) {
        guard
            let monitor = UserDefaults.standard.dictionary(forKey: monitorDefaultsKey),
            let id = monitor["connectionId"] as? String,
            let base = monitor["baseUrl"] as? String,
            let url = URL(string: base + "/api/mobile/status"),
            let token = try? CodexRemoteKeychain.read(id: id)
        else { completion(false); return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard
                let response = response as? HTTPURLResponse, response.statusCode == 200,
                let data,
                let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let threads = payload["threads"] as? [[String: Any]]
            else { completion(false); return }
            updateNotifications(threads: threads, connectionId: id)
            completion(true)
        }.resume()
    }

    public static func handleNotificationResponse(_ userInfo: [AnyHashable: Any]) {
        guard
            let connectionId = userInfo["connectionId"] as? String,
            let threadId = userInfo["threadId"] as? String
        else { return }
        let target = ["connectionId": connectionId, "threadId": threadId]
        UserDefaults.standard.set(target, forKey: launchTargetKey)
        NotificationCenter.default.post(name: openThreadNotification, object: nil, userInfo: target)
    }

    private static func updateNotifications(threads: [[String: Any]], connectionId: String) {
        let defaults = UserDefaults.standard
        let previous = defaults.dictionary(forKey: monitorStatesKey) as? [String: String] ?? [:]
        var current: [String: String] = [:]
        var running: [(String, String)] = []
        for thread in threads {
            guard let id = thread["id"] as? String else { continue }
            let title = thread["title"] as? String ?? "Untitled task"
            let status = thread["status"] as? String ?? "unknown"
            current[id] = status
            if status == "running" { running.append((id, title)) }
            if previous[id] == "running" && (status == "idle" || status == "error") {
                notify(
                    identifier: "codex-remote-completed-\(id)-\(thread["updatedAt"] ?? "now")",
                    title: status == "error" ? "对话执行失败" : "对话已完成",
                    body: title,
                    connectionId: connectionId,
                    threadId: id
                )
            }
        }
        defaults.set(current, forKey: monitorStatesKey)
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["codex-remote-running-summary"])
        center.removeDeliveredNotifications(withIdentifiers: ["codex-remote-running-summary"])
        if let first = running.first {
            notify(
                identifier: "codex-remote-running-summary",
                title: "\(running.count) 个对话运行中",
                body: running.prefix(3).map { $0.1 }.joined(separator: "、"),
                connectionId: connectionId,
                threadId: first.0,
                sound: nil
            )
        }
    }

    private static func notify(
        identifier: String,
        title: String,
        body: String,
        connectionId: String,
        threadId: String,
        sound: UNNotificationSound? = .default
    ) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = sound
        content.userInfo = [
            "connectionId": connectionId,
            "threadId": threadId,
            "link": "codex-remote://connection/\(connectionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? connectionId)/thread/\(threadId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? threadId)",
        ]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
}

private enum CodexRemoteKeychain {
    private static let service = "com.cnwenf.codexremote.tokens"

    static func read(id: String) throws -> String? {
        var query = base(id: id)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return String(data: data, encoding: .utf8)
    }

    static func write(id: String, value: String) throws {
        let data = Data(value.utf8)
        let query = base(id: id)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            var create = query
            attributes.forEach { create[$0.key] = $0.value }
            let status = SecItemAdd(create as CFDictionary, nil)
            if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        } else if updated != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(updated))
        }
    }

    static func remove(id: String) { SecItemDelete(base(id: id) as CFDictionary) }

    private static func base(id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
        ]
    }
}
