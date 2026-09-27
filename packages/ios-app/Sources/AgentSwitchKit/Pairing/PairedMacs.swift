import Foundation

/// Every Mac this phone is paired with and the one it talks to now (app-v0 §5 多台 Mac). Macs are told apart by their
/// certificate fingerprint, which also keys each one's device token in the Keychain.
public struct PairedMacs: Codable, Sendable, Equatable {
    public private(set) var servers: [ServerProfile]
    /// Fingerprint of the current Mac; nil only when there is none.
    public private(set) var active: String?

    public init(servers: [ServerProfile] = [], active: String? = nil) {
        self.servers = servers
        self.active = active.flatMap { fp in servers.contains { $0.fingerprint == fp } ? fp : nil } ?? servers.first?.fingerprint
    }

    public var current: ServerProfile? { active.flatMap(server) }
    public var isEmpty: Bool { servers.isEmpty }

    public func server(_ fingerprint: String) -> ServerProfile? {
        servers.first { $0.fingerprint == fingerprint }
    }

    /// A fresh pairing: replaces the Mac with the same fingerprint in place, or adds it at the end; either way it
    /// becomes the current one.
    public func adding(_ profile: ServerProfile) -> PairedMacs {
        var next = servers
        if let i = next.firstIndex(where: { $0.fingerprint == profile.fingerprint }) { next[i] = profile } else { next.append(profile) }
        return PairedMacs(servers: next, active: profile.fingerprint)
    }

    /// A saved Mac with new details (addresses, gate key); unknown fingerprints change nothing.
    public func updating(_ profile: ServerProfile) -> PairedMacs {
        guard let i = servers.firstIndex(where: { $0.fingerprint == profile.fingerprint }) else { return self }
        var next = servers
        next[i] = profile
        return PairedMacs(servers: next, active: active)
    }

    /// Drops a Mac; when it was the current one, the first that is left takes over.
    public func removing(_ fingerprint: String) -> PairedMacs {
        PairedMacs(servers: servers.filter { $0.fingerprint != fingerprint }, active: active == fingerprint ? nil : active)
    }

    /// Another saved Mac as the current one; unknown fingerprints change nothing.
    public func activating(_ fingerprint: String) -> PairedMacs {
        guard server(fingerprint) != nil else { return self }
        return PairedMacs(servers: servers, active: fingerprint)
    }
}
