import Foundation
import Security

/// The key of the daemon's encrypted store (packages/daemon/src/vault: the words the model never sees, the salts), in
/// the user's Keychain (2026-11-25, user #328: 保存在哪保险？). Made here the first time, readable by this app without a
/// prompt; another program asking for it gets the system's prompt. The daemon gets it on its stdin when it starts.
public enum VaultKey {
    static let service = "AgentSwitch Vault"
    static let account = "store-key"

    /// The key as hex, made when there is none; nil when the Keychain can not be used (the daemon then keeps a file).
    public static func hex() -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var found: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data, data.count == 32 {
            return data.map { String(format: "%02x", $0) }.joined()
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                  kSecAttrAccount as String: account, kSecValueData as String: Data(bytes),
                                  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                  kSecAttrLabel as String: "AgentSwitch Vault"]
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
