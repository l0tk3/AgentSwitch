import Foundation

/// `GET|PUT /settings/trusted-folders` → `{folders}`: folders trusted once in AgentSwitch. An agent it starts in one,
/// or below one, finds the folder already trusted in its own configuration and does not ask (Claude Code, Codex).
/// The service refuses the home folder, a folder above it, `/` and a relative path; a 400 says which.
public struct TrustedFolders: Codable, Equatable, Sendable {
    public let folders: [String]

    public init(folders: [String]) { self.folders = folders }

    /// The list with `path` on it (once; a trailing `/` dropped).
    public func adding(_ path: String) -> TrustedFolders {
        let p = Self.trimmed(path)
        return folders.contains { Self.trimmed($0) == p } ? self : TrustedFolders(folders: folders + [p])
    }

    public func removing(_ path: String) -> TrustedFolders {
        let p = Self.trimmed(path)
        return TrustedFolders(folders: folders.filter { Self.trimmed($0) != p })
    }

    /// `path` is a trusted folder or inside one.
    public func covers(_ path: String) -> Bool {
        let p = Self.trimmed(path)
        return folders.contains { f in let f = Self.trimmed(f); return p == f || p.hasPrefix(f == "/" ? f : f + "/") }
    }

    static func trimmed(_ s: String) -> String { s.count > 1 && s.hasSuffix("/") ? String(s.dropLast()) : s }
}

public extension DaemonClient {
    /// `GET /settings/trusted-folders` (local only).
    func trustedFolders() async throws -> TrustedFolders {
        try decode(TrustedFolders.self, try await call("GET", "/settings/trusted-folders"))
    }

    /// `PUT /settings/trusted-folders {folders}` (local only): the whole list; the answer is what was kept.
    @discardableResult
    func saveTrustedFolders(_ list: TrustedFolders) async throws -> TrustedFolders {
        try decode(TrustedFolders.self, try await call("PUT", "/settings/trusted-folders", body: try JSONEncoder().encode(list)))
    }

    /// One more folder on the list (read, added, saved).
    @discardableResult
    func trustFolder(_ path: String) async throws -> TrustedFolders {
        try await saveTrustedFolders(try await trustedFolders().adding(path))
    }
}
