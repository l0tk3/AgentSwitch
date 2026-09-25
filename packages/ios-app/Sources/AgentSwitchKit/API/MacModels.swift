import Foundation

/// A newer AgentSwitch.app waiting on the Mac, and how the last switch went (assistant-v0 §5). Build times are the ISO
/// strings of the Mac's build script.
public struct AppUpdateInfo: Decodable, Sendable, Equatable {
    public let running: String?
    public let staged: String?
    public let last: UpdateOutcome?

    public var canInstall: Bool { staged != nil }
}

public struct UpdateOutcome: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let reverted: Bool
    public let from: String
    public let to: String
    public let reason: String
}

struct InstallRequested: Decodable { let requested: Bool }

/// A folder on the Mac a phone task may run in, by name (assistant-v0 §5); added and removed on the Mac only.
public struct ProjectFolder: Decodable, Sendable, Hashable, Identifiable {
    public let name: String
    public let path: String
    /// Why it cannot be used right now (moved, deleted), if so.
    public let problem: String?

    public var id: String { name }
}

struct ProjectFolders: Decodable { let projects: [ProjectFolder] }
