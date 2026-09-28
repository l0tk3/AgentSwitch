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
            return healthy ? StatusLine("ok · 127.0.0.1:\(port) · pid \(pid)", .ok) : StatusLine("starting · pid \(pid)", .busy)
        case .external:
            return healthy ? StatusLine("ok · reusing running gateway · 127.0.0.1:\(port)", .ok) : StatusLine("running gateway: no response", .warning)
        default:
            return common(s, now: now)
        }
    }

    public static func daemon(_ s: SupervisorState, ready: Bool, port: Int, now: Date = Date()) -> StatusLine {
        switch s.phase {
        case .running(let pid, _):
            return ready ? StatusLine("ok · 127.0.0.1:\(port) · pid \(pid)", .ok) : StatusLine("starting · pid \(pid)", .busy)
        default:
            return common(s, now: now)
        }
    }

    static func common(_ s: SupervisorState, now: Date) -> StatusLine {
        switch s.phase {
        case .stopped: return StatusLine("stopped", .off)
        case .starting: return StatusLine("starting", .busy)
        case .stopping: return StatusLine("stopping", .busy)
        case .waitingToRestart(let attempt, let until):
            let wait = max(0, Int(until.timeIntervalSince(now).rounded(.up)))
            let why = s.lastExit?.summary ?? "异常退出"
            return StatusLine("\(why)；\(wait) 秒后第 \(attempt) 次重启", .warning)
        case .failed(let why): return StatusLine(why, .error)
        case .external(let what): return StatusLine(what, .ok)
        case .running(let pid, _): return StatusLine("ok · pid \(pid)", .ok)
        }
    }

    /// Shown for the remote listener and for Bonjour while 通用 › 允许 iPhone 连接 is off.
    public static let remoteOff = StatusLine("off", .off)

    public static func remote(_ info: RemoteInfo?, problem: String?, daemonReady: Bool, enabled: Bool = true) -> StatusLine {
        guard enabled else { return remoteOff }
        guard daemonReady else { return StatusLine("waiting for service", .off) }
        if let problem { return StatusLine(problem, .warning) }
        guard let info else { return StatusLine("loading", .busy) }
        guard info.enabled, let port = info.port else { return StatusLine("remote port off", .warning) }
        let fp = info.fingerprint.flatMap(BonjourRecord.fingerprintPrefix).map { " · fingerprint \($0.prefix(8))…" } ?? ""
        return StatusLine("HTTPS 0.0.0.0:\(port)\(fp)", .ok)
    }

    /// The advertiser's own status, unless remote access is off (then nothing is advertised).
    public static func bonjour(_ advertiser: StatusLine, remoteEnabled: Bool) -> StatusLine {
        remoteEnabled ? advertiser : remoteOff
    }

    public static func devices(_ devices: [Device], online: Int?) -> StatusLine {
        let active = devices.filter { !$0.isRevoked }
        guard !active.isEmpty else { return StatusLine("not paired", .off) }
        let live = online ?? active.filter { $0.online == true }.count
        return StatusLine("\(active.count) paired · \(live) online", .ok)
    }

    /// The menu-bar icon's level: the worst of gate and daemon.
    public static func overall(_ lines: [StatusLine]) -> StatusLevel {
        lines.map(\.level).max() ?? .off
    }

    // MARK: short words (menu rows, docs/ui-v0.md §7.2.7: lowercase English); the full lines above are the details

    /// A supervised service in one word. `ready`: its health check passes.
    public static func service(_ s: SupervisorState, ready: Bool) -> StatusLine {
        switch s.phase {
        case .running: return ready ? StatusLine("ok", .ok) : StatusLine("starting", .busy)
        case .external: return ready ? StatusLine("ok", .ok) : StatusLine("no response", .warning)
        case .starting: return StatusLine("starting", .busy)
        case .stopping: return StatusLine("stopping", .busy)
        case .waitingToRestart: return StatusLine("restarting", .warning)
        case .failed: return StatusLine("failed", .error)
        case .stopped: return StatusLine("stopped", .off)
        }
    }

    /// The whole app in one word, from the worst service level.
    public static func headline(_ level: StatusLevel) -> String {
        switch level {
        case .ok: return "ok"
        case .busy: return "starting"
        case .off: return "stopped"
        case .warning: return "issue"
        case .error: return "failed"
        }
    }

    /// iPhone access: off, not usable, or how many paired phones are online.
    public static func phone(remote: StatusLine, enabled: Bool, devices: [Device], online: Int?) -> StatusLine {
        guard enabled else { return StatusLine("off", .off) }
        switch remote.level {
        case .warning, .error: return StatusLine("unavailable", remote.level)
        case .busy: return StatusLine("starting", .busy)
        case .off: return StatusLine("not ready", .off)
        case .ok: break
        }
        let active = devices.filter { !$0.isRevoked }
        guard !active.isEmpty else { return StatusLine("not paired", .off) }
        let live = online ?? active.filter { $0.online == true }.count
        return StatusLine(live > 0 ? "\(live) online" : "\(active.count) paired", .ok)
    }

    /// Tailscale: the Mac's tailnet address when there is one.
    public static func tailscale(_ status: TailscaleStatus?, tailnet: [String]) -> StatusLine {
        if let address = tailnet.first { return StatusLine(address, .ok) }
        switch status?.state {
        case .none: return StatusLine("checking", .busy)
        case .notInstalled: return StatusLine("not installed", .off)
        case .stopped: return StatusLine("disconnected", .warning)
        case .running: return StatusLine(status?.ipv4.first ?? "connected", .ok)
        }
    }

    /// A harness: ok, signed out, not installed.
    public static func harness(_ state: HarnessState) -> StatusLine {
        switch state {
        case .ready: return StatusLine("ok", .ok)
        case .notLoggedIn: return StatusLine("signed out", .warning)
        case .missing: return StatusLine("not installed", .off)
        }
    }
}
