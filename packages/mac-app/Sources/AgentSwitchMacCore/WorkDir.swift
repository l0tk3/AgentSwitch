import Foundation

/// `GET /settings/workdir` → `{path, default, problem}` (docs/control-v0.md §2): where tasks without a folder get their
/// own subfolder. `default` is read as the default path, or as a flag when the daemon sends a boolean.
public struct WorkDirSettings: Decodable, Equatable, Sendable {
    public let path: String
    public let defaultPath: String?
    /// Why the folder cannot be used right now (not writable, gone), in the daemon's words; nil when it is fine.
    public let problem: String?
    public let isDefault: Bool

    public init(path: String, defaultPath: String?, problem: String?) {
        self.path = path
        self.defaultPath = defaultPath
        self.problem = problem
        isDefault = defaultPath.map { WorkDirSettings.same($0, path) } ?? false
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let path = try c.require(String.self, "path")
        let defaultPath = c.first(String.self, "default", "defaultPath")
        let problem = c.first(String.self, "problem")?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.path = path
        self.defaultPath = defaultPath
        self.problem = problem?.isEmpty == false ? problem : nil
        isDefault = c.first(Bool.self, "default", "isDefault") ?? defaultPath.map { WorkDirSettings.same($0, path) } ?? false
    }

    /// The default when the daemon does not say it: `~/AgentSwitch`.
    public static func fallbackDefault(home: String) -> String {
        (home.hasSuffix("/") ? String(home.dropLast()) : home) + "/AgentSwitch"
    }

    /// What 恢复默认 sends.
    public func defaultToRestore(home: String) -> String {
        defaultPath ?? WorkDirSettings.fallbackDefault(home: home)
    }

    static func same(_ a: String, _ b: String) -> Bool {
        func trimmed(_ s: String) -> String { s.count > 1 && s.hasSuffix("/") ? String(s.dropLast()) : s }
        return trimmed(a) == trimmed(b)
    }
}

/// `PUT /settings/workdir {path}`.
public struct WorkDirUpdate: Encodable, Equatable, Sendable {
    public let path: String

    public init(path: String) { self.path = path }
}

/// What the app knows about the work dir: not read yet, a daemon without the route (older build), or its settings.
public enum WorkDirFact: Equatable, Sendable {
    case unknown
    case unsupported
    case known(WorkDirSettings)

    public var settings: WorkDirSettings? {
        if case .known(let s) = self { return s }
        return nil
    }
}
