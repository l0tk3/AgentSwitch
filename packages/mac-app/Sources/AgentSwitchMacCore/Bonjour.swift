import Foundation

/// `_agentswitch._tcp` on the remote port, TXT `v=1` and `fp=<first 16 hex of the certificate fingerprint>`
/// (app-v0 §4 Bonjour). The phone prefers a discovered address whose `fp` matches the one it pinned.
public enum BonjourRecord {
    public static let serviceType = "_agentswitch._tcp."
    public static let domain = "local."
    public static let prefixLength = 16

    /// Lowercase hex without separators, first 16 characters; nil when it is not a SHA-256 hex string.
    public static func fingerprintPrefix(_ fingerprint: String) -> String? {
        let hex = fingerprint.lowercased().filter { $0 != ":" && !$0.isWhitespace }
        guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return nil }
        return String(hex.prefix(prefixLength))
    }

    public static func txt(fingerprint: String) -> [String: Data]? {
        guard let fp = fingerprintPrefix(fingerprint) else { return nil }
        return ["v": Data("1".utf8), "fp": Data(fp.utf8)]
    }

    /// `AgentSwitch on <Mac 名称>`, the name the pairing payload's `bonjour` field carries.
    public static func serviceName(computerName: String) -> String {
        "AgentSwitch on \(computerName)"
    }

    /// What to advertise, or nil while the remote listener is not known.
    public struct Advertisement: Equatable, Sendable {
        public let name: String
        public let port: Int
        public let txt: [String: Data]
    }

    public static func advertisement(info: RemoteInfo?, fallbackPort: Int, computerName: String) -> Advertisement? {
        guard let info, info.enabled, let fp = info.fingerprint, let txt = txt(fingerprint: fp) else { return nil }
        return Advertisement(name: info.bonjour ?? serviceName(computerName: computerName),
                             port: info.port ?? fallbackPort, txt: txt)
    }
}
