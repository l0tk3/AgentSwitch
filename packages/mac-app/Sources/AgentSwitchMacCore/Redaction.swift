import Foundation

/// The words the model never sees and the model traffic gateway's logs (packages/daemon/src/vault, api/redaction.ts;
/// user #318-#332): this Mac's service only.
public struct RedactSettings: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var username: Bool
    public var host: Bool
    public var log: Bool
    /// Only these terminals are written down; none: every terminal (user #595).
    public var logTerminals: [String]
    public var keepDays: Int
    public var hosts: [String]

    private enum CodingKeys: String, CodingKey { case enabled, username, host, log, logTerminals, keepDays, hosts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        username = try c.decode(Bool.self, forKey: .username)
        host = try c.decode(Bool.self, forKey: .host)
        log = try c.decode(Bool.self, forKey: .log)
        // A service from before #595 has none: every terminal.
        logTerminals = try c.decodeIfPresent([String].self, forKey: .logTerminals) ?? []
        keepDays = try c.decode(Int.self, forKey: .keepDays)
        hosts = try c.decode([String].self, forKey: .hosts)
    }
}

public struct RedactWord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let value: String
    public let replace: String?
    public let restore: Bool
    /// `value` is a regular expression (user #596): what it matches is replaced, each piece by its own placeholder.
    public let regex: Bool?
    public let addedAt: Int64

    public var isRegex: Bool { regex == true }
    /// As the lists show it: a pattern between slashes.
    public var shown: String { isRegex ? "/\(value)/" : value }
}

public struct RedactLog: Decodable, Equatable, Sendable, Identifiable {
    public let terminal: String
    public let day: String
    public let before: Int64
    public let after: Int64
    public var id: String { "\(terminal)/\(day)" }
}

public struct RedactionState: Decodable, Equatable, Sendable {
    public let settings: RedactSettings
    public let words: [RedactWord]
    /// Whether terminals go through the gateway (it is on, and this machine has it).
    public let gateway: Bool
    public let logDir: String
}

public extension DaemonClient {
    func redaction() async throws -> RedactionState { try decode(RedactionState.self, try await call("GET", "/redaction", timeout: 10)) }

    /// `patch`: JSON of the settings to change.
    func setRedaction(_ patch: Data) async throws -> RedactSettings {
        struct Answer: Decodable { let settings: RedactSettings }
        return try decode(Answer.self, try await call("PATCH", "/redaction/settings", body: patch, timeout: 10)).settings
    }

    /// A word added (to a room's list when `room`), and the warning when its replacement goes one way only.
    func addRedactWord(_ value: String, replace: String?, regex: Bool = false, room: String? = nil) async throws -> (word: RedactWord, warning: String?) {
        struct Answer: Decodable { let word: RedactWord; let warning: String? }
        var body: [String: Any] = ["value": value]
        if regex { body["regex"] = true }
        if let replace, !replace.isEmpty { body["replace"] = replace }
        let path = room.map { "/rooms/\(DaemonClient.segment($0))/redaction/words" } ?? "/redaction/words"
        let a = try decode(Answer.self, try await call("POST", path, body: try JSONSerialization.data(withJSONObject: body), timeout: 10))
        return (a.word, a.warning)
    }

    func removeRedactWord(_ id: String, room: String? = nil) async throws {
        let path = room.map { "/rooms/\(DaemonClient.segment($0))/redaction/words/\(DaemonClient.segment(id))" } ?? "/redaction/words/\(DaemonClient.segment(id))"
        _ = try await call("DELETE", path, timeout: 10)
    }

    func roomRedactWords(_ room: String) async throws -> [RedactWord] {
        struct Answer: Decodable { let words: [RedactWord] }
        return try decode(Answer.self, try await call("GET", "/rooms/\(DaemonClient.segment(room))/redaction/words", timeout: 10)).words
    }

    func redactLogs() async throws -> (dir: String, logs: [RedactLog]) {
        struct Answer: Decodable { let dir: String; let logs: [RedactLog] }
        let a = try decode(Answer.self, try await call("GET", "/redaction/logs", timeout: 10))
        return (a.dir, a.logs)
    }

    /// Logs removed: all, or those older than `days` days. How many files went.
    @discardableResult
    func cleanRedactLogs(olderThan days: Int? = nil) async throws -> Int {
        struct Answer: Decodable { let removed: Int }
        let path = days.map { "/redaction/logs?days=\($0)" } ?? "/redaction/logs"
        return try decode(Answer.self, try await call("DELETE", path, timeout: 30)).removed
    }
}
