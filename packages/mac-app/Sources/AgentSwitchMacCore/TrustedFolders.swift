import Foundation

/// `GET|PUT /settings/trusted-folders` → `{folders}`: folders trusted once in AgentSwitch. An agent it starts in one,
/// or below one, finds the folder already trusted in its own configuration and does not ask (Claude Code, Codex).
/// The service refuses the home folder, a folder above it, `/` and a relative path; a 400 says which.
public struct TrustedFolders: Codable, Equatable, Sendable {
    /// Trusted with everything below them.
    public let folders: [String]
    /// Trusted by themselves: a folder below one is asked about again (user #463).
    public let only: [String]

    public init(folders: [String], only: [String] = []) {
        self.folders = folders
        self.only = only
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        folders = (try? c.decodeIfPresent([String].self, forKey: .folders)) ?? []
        only = (try? c.decodeIfPresent([String].self, forKey: .only)) ?? []
    }

    /// The list with `path` and all below it trusted (once; a trailing `/` dropped).
    public func adding(_ path: String) -> TrustedFolders {
        let p = Self.trimmed(path)
        return folders.contains { Self.trimmed($0) == p } ? self : TrustedFolders(folders: folders + [p], only: only.filter { Self.trimmed($0) != p })
    }

    /// The list with `path` trusted by itself, unless it is trusted already.
    public func addingOnly(_ path: String) -> TrustedFolders {
        let p = Self.trimmed(path)
        return covers(p) ? self : TrustedFolders(folders: folders, only: only + [p])
    }

    public func removing(_ path: String) -> TrustedFolders {
        let p = Self.trimmed(path)
        return TrustedFolders(folders: folders.filter { Self.trimmed($0) != p }, only: only.filter { Self.trimmed($0) != p })
    }

    /// `path` is a trusted folder, inside one trusted with all below it, or one trusted by itself.
    public func covers(_ path: String) -> Bool {
        let p = Self.trimmed(path)
        return only.contains { Self.trimmed($0) == p }
            || folders.contains { f in let f = Self.trimmed(f); return p == f || p.hasPrefix(f == "/" ? f : f + "/") }
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

    /// One more folder on the list (read, added, saved): with all below it, or by itself.
    @discardableResult
    func trustFolder(_ path: String, alone: Bool = false) async throws -> TrustedFolders {
        let list = try await trustedFolders()
        return try await saveTrustedFolders(alone ? list.addingOnly(path) : list.adding(path))
    }

    /// `GET /settings/trusted-folders/check?cwd=` (local only): is the folder trusted already, and may it be.
    func trustCheck(_ cwd: String) async throws -> TrustCheck {
        var q = URLComponents()
        q.queryItems = [URLQueryItem(name: "cwd", value: cwd)]
        return try decode(TrustCheck.self, try await call("GET", "/settings/trusted-folders/check?\(q.percentEncodedQuery ?? "")"))
    }
}

public struct TrustCheck: Codable, Equatable, Sendable {
    public let trusted: Bool
    public let allowed: Bool
}

/// What a new session's folder is asked about before the agent starts (user #463), in the order shown.
public enum TrustChoice: Int, CaseIterable, Sendable {
    case no, folder, below

    public var title: String {
        switch self {
        case .no: "Don't Trust"
        case .folder: "Trust This Folder"
        case .below: "Trust This Folder and All Subfolders"
        }
    }

    /// The agents that ask about a folder themselves; the others are started without the question.
    public static func asks(_ harness: String) -> Bool { harness == "claude-code" || harness == "codex" }
}
