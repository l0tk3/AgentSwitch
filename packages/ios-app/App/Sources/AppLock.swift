import LocalAuthentication
import SwiftUI

/// The Face ID gate in front of the whole app (app-v0 §6: a lost phone must not send tasks). Off by default; when on,
/// the app locks at launch and whenever it goes to the background.
@MainActor
@Observable
final class AppLock {
    private static let key = "faceIDLockEnabled"

    private(set) var enabled: Bool
    private(set) var locked: Bool
    var lastError: String?

    init() {
        let on = UserDefaults.standard.bool(forKey: Self.key)
        enabled = on
        locked = on
    }

    /// "Face ID", "Touch ID" or the passcode, for labels.
    var biometryName: String {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "设备密码"
        }
    }

    func lockIfEnabled() {
        if enabled { locked = true }
    }

    func unlock() async {
        if await authenticate(reason: "解锁 AgentSwitch") { locked = false }
    }

    /// Turning the lock on or off both need the owner, so a borrowed unlocked phone cannot switch it off.
    func setEnabled(_ on: Bool) async {
        guard on != enabled else { return }
        guard await authenticate(reason: on ? "开启解锁保护" : "关闭解锁保护") else { return }
        enabled = on
        UserDefaults.standard.set(on, forKey: Self.key)
    }

    private func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            lastError = "这台设备没有设置密码或生物识别：\(error?.localizedDescription ?? "")"
            return false
        }
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
            lastError = nil
            return ok
        } catch {
            lastError = (error as? LAError)?.code == .userCancel ? nil : error.localizedDescription
            return false
        }
    }
}
