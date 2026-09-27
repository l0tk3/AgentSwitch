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
