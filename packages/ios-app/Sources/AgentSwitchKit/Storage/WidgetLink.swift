import AgentSwitchLive
import Foundation
import Security

/// How the Channels widget reaches the current Mac on its own (docs/app-v0.md §5), where it cannot read the app's copy
/// of the rooms (no app group: a free personal team's signature gets none). Kept in a keychain group the app and the
/// widget share (`AgentSwitchKeychainGroup` in both Info.plists, the team's prefix and `com.agentswitch.shared` — a
/// development profile allows every group under the team's prefix, so nothing has to be registered): the Mac's
/// addresses, its certificate's fingerprint, the token, and the app's look. This device only; readable after the first
/// unlock, as a widget draws while the phone is locked.
public struct WidgetLink: Codable, Sendable, Hashable {
    public let fingerprint: String
    /// Tried in this order: the one in use first.
    public let endpoints: [APIEndpoint]
    public let token: String
    public let classic: Bool

    public init(fingerprint: String, endpoints: [APIEndpoint], token: String, classic: Bool) {
        self.fingerprint = fingerprint
        self.endpoints = endpoints
        self.token = token
        self.classic = classic
    }

    /// The Mac's addresses as the app knows them, `inUse` first, then the LAN's and Tailscale's, each once.
    public static func endpoints(of profile: ServerProfile, inUse: APIEndpoint?) -> [APIEndpoint] {
        var all: [APIEndpoint] = inUse.map { [$0] } ?? []
        for host in profile.lan { all.append(APIEndpoint(host: host, port: profile.port, kind: .lan)) }
        for host in profile.tailnet { all.append(APIEndpoint(host: host, port: profile.port, kind: .tailnet)) }
        var seen = Set<String>()
        return all.filter { seen.insert($0.authority).inserted }
    }

    /// The rooms read from the first address that answers, as the widget's copy; nil where none does.
    public func readRooms(timeout: TimeInterval = 6, tries: Int = 4) async -> ChannelsSnapshot? {
        let config = PinnedSessionTransport.defaultConfiguration()
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let transport = PinnedSessionTransport(fingerprint: fingerprint, configuration: config)
        for endpoint in endpoints.prefix(tries) {
            let api = AgentSwitchAPI(endpoints: FixedEndpoint(endpoint), transport: transport, token: token)
            if let read = try? await api.rooms(etag: nil) { return ChannelsSnapshot(read.list, classic: classic) }
        }
        return nil
    }
}

/// The shared keychain item that holds the link (one: the current Mac's).
public enum WidgetLinkStore {
    static let service = "com.agentswitch.widget-link"
    static let account = "current"

    /// The group named in the bundle's Info.plist; nil where it has none (the item is not written).
    public static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "AgentSwitchKeychainGroup") as? String,
              !g.isEmpty, !g.hasPrefix("$(") else { return nil }
        return g
    }

    private static func query(_ group: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group]
    }

    /// Written over what was there. False where the group is missing or the keychain refused.
    @discardableResult
    public static func save(_ link: WidgetLink, group: String? = group) -> Bool {
        guard let group, let data = try? JSONEncoder().encode(link) else { return false }
        let q = query(group)
        let update: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = q
        add.merge(update) { _, new in new }
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    public static func load(group: String? = group) -> WidgetLink? {
        guard let group else { return nil }
        var q = query(group)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(WidgetLink.self, from: data)
    }

    /// No Mac, or another: the widget no longer reaches the one before.
    public static func clear(group: String? = group) {
        guard let group else { return }
        SecItemDelete(query(group) as CFDictionary)
    }
}
