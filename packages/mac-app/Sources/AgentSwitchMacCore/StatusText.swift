import Foundation

/// How a status line should look; the UI maps it to a colour.
public enum StatusLevel: Int, Sendable, Comparable {
    case ok, off, busy, warning, error

    public static func < (a: StatusLevel, b: StatusLevel) -> Bool { a.rawValue < b.rawValue }
}

public struct StatusLine: Sendable, Equatable {
    public let text: String
    public let level: StatusLevel

    public init(_ text: String, _ level: StatusLevel) {
        self.text = text
        self.level = level
    }
}

/// The menu's status lines, as pure functions of supervisor state and the last poll.
public enum StatusText {
    public static func gate(_ s: SupervisorState, healthy: Bool, port: Int, now: Date = Date()) -> StatusLine {
        switch s.phase {
        case .running(let pid, _):
            return healthy ? StatusLine("OK · 127.0.0.1:\(port) · PID \(pid)", .ok) : StatusLine("Starting · PID \(pid)", .busy)
        case .external:
            return healthy ? StatusLine("OK · Reusing Running Gateway · 127.0.0.1:\(port)", .ok) : StatusLine("Running Gateway: No Response", .warning)
        default:
            return common(s, now: now)
        }
    }

    public static func daemon(_ s: SupervisorState, ready: Bool, port: Int, now: Date = Date()) -> StatusLine {
        switch s.phase {
        case .running(let pid, _):
            return ready ? StatusLine("OK · 127.0.0.1:\(port) · PID \(pid)", .ok) : StatusLine("Starting · PID \(pid)", .busy)
        default:
            return common(s, now: now)
        }
    }

    static func common(_ s: SupervisorState, now: Date) -> StatusLine {
        switch s.phase {
        case .stopped: return StatusLine("Stopped", .off)
        case .starting: return StatusLine("Starting", .busy)
        case .stopping: return StatusLine("Stopping", .busy)
        case .waitingToRestart(let attempt, let until):
            let wait = max(0, Int(until.timeIntervalSince(now).rounded(.up)))
            let why = s.lastExit?.summary ?? "异常退出"
            return StatusLine("\(why)；\(wait) 秒后第 \(attempt) 次重启", .warning)
        case .failed(let why): return StatusLine(why, .error)
        case .external(let what): return StatusLine(what, .ok)
        case .running(let pid, _): return StatusLine("OK · PID \(pid)", .ok)
        }
    }

    /// Shown for the remote listener and for Bonjour while 通用 › 允许 iPhone 连接 is off.
    public static let remoteOff = StatusLine("Off", .off)

    public static func remote(_ info: RemoteInfo?, problem: String?, daemonReady: Bool, enabled: Bool = true) -> StatusLine {
        guard enabled else { return remoteOff }
        guard daemonReady else { return StatusLine("Waiting for Service", .off) }
        if let problem { return StatusLine(problem, .warning) }
        guard let info else { return StatusLine("Loading", .busy) }
        guard info.enabled, let port = info.port else { return StatusLine("Remote Port Off", .warning) }
        let fp = info.fingerprint.flatMap(BonjourRecord.fingerprintPrefix).map { " · Fingerprint \($0.prefix(8))…" } ?? ""
        return StatusLine("HTTPS 0.0.0.0:\(port)\(fp)", .ok)
    }

    /// The advertiser's own status, unless remote access is off (then nothing is advertised).
    public static func bonjour(_ advertiser: StatusLine, remoteEnabled: Bool) -> StatusLine {
        remoteEnabled ? advertiser : remoteOff
    }

    public static func devices(_ devices: [Device], online: Int?) -> StatusLine {
        let active = devices.filter { !$0.isRevoked }
        guard !active.isEmpty else { return StatusLine("Not Paired", .off) }
        let live = online ?? active.filter { $0.online == true }.count
        return StatusLine("\(active.count) Paired · \(live) Online", .ok)
    }

    /// The menu-bar icon's level: the worst of gate and daemon.
    public static func overall(_ lines: [StatusLine]) -> StatusLevel {
        lines.map(\.level).max() ?? .off
    }

    // MARK: short words (menu rows, docs/ui-v0.md §7.2.7: English in title case); the full lines above are the details

    /// A supervised service in one word. `ready`: its health check passes.
    public static func service(_ s: SupervisorState, ready: Bool) -> StatusLine {
        switch s.phase {
        case .running: return ready ? StatusLine("OK", .ok) : StatusLine("Starting", .busy)
        case .external: return ready ? StatusLine("OK", .ok) : StatusLine("No Response", .warning)
        case .starting: return StatusLine("Starting", .busy)
        case .stopping: return StatusLine("Stopping", .busy)
        case .waitingToRestart: return StatusLine("Restarting", .warning)
        case .failed: return StatusLine("Failed", .error)
        case .stopped: return StatusLine("Stopped", .off)
        }
    }

    /// The whole app in one word, from the worst service level.
    public static func headline(_ level: StatusLevel) -> String {
        switch level {
        case .ok: return "OK"
        case .busy: return "Starting"
        case .off: return "Stopped"
        case .warning: return "Issue"
        case .error: return "Failed"
        }
    }

    /// iPhone access: off, not usable, or how many paired phones are online.
    public static func phone(remote: StatusLine, enabled: Bool, devices: [Device], online: Int?) -> StatusLine {
        guard enabled else { return StatusLine("Off", .off) }
        switch remote.level {
        case .warning, .error: return StatusLine("Unavailable", remote.level)
        case .busy: return StatusLine("Starting", .busy)
        case .off: return StatusLine("Not Ready", .off)
        case .ok: break
        }
        let active = devices.filter { !$0.isRevoked }
        guard !active.isEmpty else { return StatusLine("Not Paired", .off) }
        let live = online ?? active.filter { $0.online == true }.count
        return StatusLine(live > 0 ? "\(live) Online" : "\(active.count) Paired", .ok)
    }

    /// Tailscale: the Mac's tailnet address when there is one.
    public static func tailscale(_ status: TailscaleStatus?, tailnet: [String]) -> StatusLine {
        if let address = tailnet.first { return StatusLine(address, .ok) }
        switch status?.state {
        case .none: return StatusLine("Checking", .busy)
        case .notInstalled: return StatusLine("Not Installed", .off)
        case .stopped: return StatusLine("Disconnected", .warning)
        case .running: return StatusLine(status?.ipv4.first ?? "Connected", .ok)
        }
    }

    /// A harness: OK, Signed Out, Not Installed.
    public static func harness(_ state: HarnessState) -> StatusLine {
        switch state {
        case .ready: return StatusLine("OK", .ok)
        case .notLoggedIn: return StatusLine("Signed Out", .warning)
        case .missing: return StatusLine("Not Installed", .off)
        }
    }
}
