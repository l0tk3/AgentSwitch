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
            return healthy ? StatusLine("运行中 · 127.0.0.1:\(port)（pid \(pid)）", .ok) : StatusLine("启动中…（pid \(pid)）", .busy)
        case .external:
            return healthy ? StatusLine("复用已在运行的网关 · 127.0.0.1:\(port)", .ok) : StatusLine("已有的网关没有响应", .warning)
        default:
            return common(s, now: now)
        }
    }

    public static func daemon(_ s: SupervisorState, ready: Bool, port: Int, now: Date = Date()) -> StatusLine {
        switch s.phase {
        case .running(let pid, _):
            return ready ? StatusLine("运行中 · 127.0.0.1:\(port)（pid \(pid)）", .ok) : StatusLine("启动中…（pid \(pid)）", .busy)
        default:
            return common(s, now: now)
        }
    }

    static func common(_ s: SupervisorState, now: Date) -> StatusLine {
        switch s.phase {
        case .stopped: return StatusLine("已停止", .off)
        case .starting: return StatusLine("启动中…", .busy)
        case .stopping: return StatusLine("正在停止…", .busy)
        case .waitingToRestart(let attempt, let until):
            let wait = max(0, Int(until.timeIntervalSince(now).rounded(.up)))
            let why = s.lastExit?.summary ?? "异常退出"
            return StatusLine("\(why)；\(wait) 秒后第 \(attempt) 次重启", .warning)
        case .failed(let why): return StatusLine(why, .error)
        case .external(let what): return StatusLine(what, .ok)
        case .running(let pid, _): return StatusLine("运行中（pid \(pid)）", .ok)
        }
    }

    /// Shown for the remote listener and for Bonjour while 通用 › 允许 iPhone 连接 is off.
    public static let remoteOff = StatusLine("远程已关闭", .off)

    public static func remote(_ info: RemoteInfo?, problem: String?, daemonReady: Bool, enabled: Bool = true) -> StatusLine {
        guard enabled else { return remoteOff }
        guard daemonReady else { return StatusLine("等待守护进程", .off) }
        if let problem { return StatusLine(problem, .warning) }
        guard let info else { return StatusLine("读取中…", .busy) }
        guard info.enabled, let port = info.port else { return StatusLine("远程模式没有打开", .warning) }
        let fp = info.fingerprint.flatMap(BonjourRecord.fingerprintPrefix).map { " · 指纹 \($0.prefix(8))…" } ?? ""
        return StatusLine("HTTPS 0.0.0.0:\(port)\(fp)", .ok)
    }

    /// The advertiser's own status, unless remote access is off (then nothing is advertised).
    public static func bonjour(_ advertiser: StatusLine, remoteEnabled: Bool) -> StatusLine {
        remoteEnabled ? advertiser : remoteOff
    }

    public static func devices(_ devices: [Device], online: Int?) -> StatusLine {
        let active = devices.filter { !$0.isRevoked }
        guard !active.isEmpty else { return StatusLine("还没有配对的设备", .off) }
        let live = online ?? active.filter { $0.online == true }.count
        return StatusLine("\(active.count) 台（在线 \(live)）", .ok)
    }

    /// The menu-bar icon's level: the worst of gate and daemon.
    public static func overall(_ lines: [StatusLine]) -> StatusLevel {
        lines.map(\.level).max() ?? .off
    }
}
