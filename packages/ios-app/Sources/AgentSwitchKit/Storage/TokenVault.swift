import Foundation
import Security

public enum VaultError: Error, Equatable, LocalizedError {
    case keychain(OSStatus)
    case corrupt

    public var errorDescription: String? {
        switch self {
        case .keychain(let status): return "钥匙串错误 \(status)"
        case .corrupt: return "钥匙串中的令牌已损坏"
        }
    }
}

/// Where the device token lives. One token per paired Mac, keyed by its certificate fingerprint.
public protocol TokenVault: Sendable {
    func save(_ token: String, account: String) throws
    func load(account: String) throws -> String?
    func delete(account: String) throws
}

/// Keychain generic password, readable only while this device is unlocked and never synced or restored to another
/// device (kSecAttrAccessibleWhenUnlockedThisDeviceOnly).
public struct KeychainTokenVault: TokenVault {
    public static let defaultService = "com.agentswitch.ios.device-token"
    public let service: String

    public init(service: String = KeychainTokenVault.defaultService) {
        self.service = service
    }

    public func save(_ token: String, account: String) throws {
        try delete(account: account)
        var query = baseQuery(account: account)
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
    }

    public func load(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw VaultError.keychain(status) }
        guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else { throw VaultError.corrupt }
        return token
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError.keychain(status) }
    }

    /// The attributes that identify the item (exposed for tests; no data or access flags).
    public func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}

/// In-memory vault for tests and previews.
public final class MemoryTokenVault: TokenVault {
    private let items = LockedBox<[String: String]>([:])

    public init() {}

    public func save(_ token: String, account: String) throws { items.withLock { $0[account] = token } }
    public func load(account: String) throws -> String? { items.withLock { $0[account] } }
    public func delete(account: String) throws { _ = items.withLock { $0.removeValue(forKey: account) } }
}
