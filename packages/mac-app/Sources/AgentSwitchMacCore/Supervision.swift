import Foundation

/// Exponential restart delays. A run that lasted `stableAfter` resets the count, so one crash after a day of
/// uptime restarts after `initial`, while a crash loop settles at `maximum`.
public struct BackoffPolicy: Sendable, Equatable {
    public let initial: TimeInterval
    public let multiplier: Double
    public let maximum: TimeInterval
    public let stableAfter: TimeInterval

    public static let standard = BackoffPolicy(initial: 1, multiplier: 2, maximum: 60, stableAfter: 30)

    public init(initial: TimeInterval, multiplier: Double, maximum: TimeInterval, stableAfter: TimeInterval) {
        self.initial = initial
        self.multiplier = multiplier
        self.maximum = maximum
        self.stableAfter = stableAfter
    }

    /// Delay before restart number `attempt` (1-based).
    public func delay(forAttempt attempt: Int) -> TimeInterval {
        let exponent = Double(max(0, attempt - 1))
        return min(maximum, initial * pow(multiplier, exponent))
    }
}

public struct ExitRecord: Sendable, Equatable {
    public let status: Int32
    public let signaled: Bool
    public let at: Date
    public let uptime: TimeInterval
    /// Set when the process never started (spawn error).
    public let detail: String?

    public init(status: Int32, signaled: Bool, at: Date, uptime: TimeInterval, detail: String? = nil) {
        self.status = status
        self.signaled = signaled
        self.at = at
        self.uptime = uptime
        self.detail = detail
    }

    public var summary: String {
        if let detail { return "无法启动：\(detail)" }
        return signaled ? "被信号 \(status) 终止（运行 \(Int(uptime)) 秒）" : "退出码 \(status)（运行 \(Int(uptime)) 秒）"
    }
}

public enum SupervisorPhase: Sendable, Equatable {
    case stopped
    case starting
    case running(pid: Int32, since: Date)
    case waitingToRestart(attempt: Int, until: Date)
    case stopping(pid: Int32)
    /// Someone else's listener passed the probe and is used instead of our own child (the gate on a busy port).
    case external(String)
    /// Needs the user (port taken by something else, runtime missing): no automatic retry.
    case failed(String)
}

public struct SupervisorState: Sendable, Equatable {
    public let phase: SupervisorPhase
    /// Whether the process should be up; `stop` clears it, `start` sets it.
    public let wanted: Bool
    /// Consecutive short-lived runs, the backoff exponent.
    public let failures: Int
    public let restarts: Int
    public let lastExit: ExitRecord?

    public static let initial = SupervisorState(phase: .stopped, wanted: false, failures: 0, restarts: 0, lastExit: nil)

    public init(phase: SupervisorPhase, wanted: Bool, failures: Int, restarts: Int, lastExit: ExitRecord?) {
        self.phase = phase
        self.wanted = wanted
        self.failures = failures
        self.restarts = restarts
        self.lastExit = lastExit
    }

    func with(phase: SupervisorPhase? = nil, wanted: Bool? = nil, failures: Int? = nil, restarts: Int? = nil,
              lastExit: ExitRecord?? = nil) -> SupervisorState {
        SupervisorState(phase: phase ?? self.phase, wanted: wanted ?? self.wanted, failures: failures ?? self.failures,
                        restarts: restarts ?? self.restarts, lastExit: lastExit ?? self.lastExit)
    }

    public var pid: Int32? {
        switch phase {
        case .running(let pid, _), .stopping(let pid): return pid
        default: return nil
        }
    }

    public var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    /// True while the service is usable: our child is up or an external one was adopted.
    public var isServing: Bool {
        switch phase {
        case .running, .external: return true
        default: return false
        }
    }
}

public enum SupervisorEvent: Sendable, Equatable {
    case startRequested
    case stopRequested
    /// Stop and start again at once (settings changed, user asked); no backoff.
    case restartRequested
    case preflightFailed(String)
    case adoptedExternal(String)
    case launched(pid: Int32, at: Date)
    case launchFailed(String, at: Date)
    case exited(status: Int32, signaled: Bool, at: Date)
    case retryDue
    /// Process alive but its health check keeps failing: restart it, counting as a failure.
    case unhealthy(String)
    /// The adopted external listener went away: bring up our own.
    case externalLost
}

public enum SupervisorEffect: Sendable, Equatable {
    case preflightAndLaunch
    case scheduleRetry(after: TimeInterval)
    case cancelRetry
    case terminate(pid: Int32)
}

/// The supervision rules as a pure function; `ProcessSupervisor` only performs the effects.
public enum SupervisorMachine {
    public static func reduce(_ s: SupervisorState, _ event: SupervisorEvent,
                              policy: BackoffPolicy = .standard) -> (SupervisorState, [SupervisorEffect]) {
        switch (s.phase, event) {
        case (.running, .startRequested), (.starting, .startRequested), (.stopping, .startRequested):
            return (s.with(wanted: true), [])
        case (.waitingToRestart, .startRequested):
            return (s.with(phase: .starting, wanted: true), [.cancelRetry, .preflightAndLaunch])
        case (_, .startRequested):
            return (s.with(phase: .starting, wanted: true, failures: 0), [.preflightAndLaunch])

        case (.running(let pid, _), .stopRequested):
            return (s.with(phase: .stopping(pid: pid), wanted: false), [.terminate(pid: pid)])
        case (.waitingToRestart, .stopRequested):
            return (s.with(phase: .stopped, wanted: false), [.cancelRetry])
        case (.starting, .stopRequested), (.stopping, .stopRequested):
            return (s.with(wanted: false), [])
        case (_, .stopRequested):
            return (s.with(phase: .stopped, wanted: false), [])

        case (.running(let pid, _), .restartRequested):
            return (s.with(phase: .stopping(pid: pid), wanted: true, failures: 0), [.terminate(pid: pid)])
        case (.stopping, .restartRequested), (.starting, .restartRequested):
            return (s.with(wanted: true), [])
        case (.waitingToRestart, .restartRequested):
            return (s.with(phase: .starting, wanted: true, failures: 0), [.cancelRetry, .preflightAndLaunch])
        case (_, .restartRequested):
            return (s.with(phase: .starting, wanted: true, failures: 0), [.preflightAndLaunch])

        case (.starting, .preflightFailed(let why)):
            return (s.with(phase: s.wanted ? .failed(why) : .stopped), [])
        case (.starting, .adoptedExternal(let what)):
            return (s.with(phase: s.wanted ? .external(what) : .stopped), [])
        case (.starting, .launched(let pid, let at)):
            if s.wanted { return (s.with(phase: .running(pid: pid, since: at)), []) }
            return (s.with(phase: .stopping(pid: pid)), [.terminate(pid: pid)])
        case (.starting, .launchFailed(let why, let at)):
            let record = ExitRecord(status: -1, signaled: false, at: at, uptime: 0, detail: why)
            guard s.wanted else { return (s.with(phase: .stopped, lastExit: record), []) }
            return backoff(s.with(lastExit: record), failures: s.failures + 1, at: at, policy: policy)

        case (.running(_, let since), .exited(let status, let signaled, let at)):
            let record = ExitRecord(status: status, signaled: signaled, at: at, uptime: at.timeIntervalSince(since))
            guard s.wanted else { return (s.with(phase: .stopped, lastExit: record), []) }
            let failures = record.uptime >= policy.stableAfter ? 1 : s.failures + 1
            return backoff(s.with(lastExit: record), failures: failures, at: at, policy: policy)
        case (.stopping, .exited(let status, let signaled, let at)):
            let record = ExitRecord(status: status, signaled: signaled, at: at, uptime: 0)
            if s.wanted { return (s.with(phase: .starting, lastExit: record), [.preflightAndLaunch]) }
            return (s.with(phase: .stopped, lastExit: record), [])

        case (.waitingToRestart, .retryDue):
            return (s.with(phase: .starting, restarts: s.restarts + 1), [.preflightAndLaunch])

        case (.running(let pid, _), .unhealthy):
            return (s.with(phase: .stopping(pid: pid), failures: s.failures + 1), [.terminate(pid: pid)])

        case (.external, .externalLost):
            guard s.wanted else { return (s.with(phase: .stopped), []) }
            return (s.with(phase: .starting), [.preflightAndLaunch])

        default:
            return (s, [])   // stale timers, late reports: nothing to do
        }
    }

    private static func backoff(_ s: SupervisorState, failures: Int, at: Date,
                                policy: BackoffPolicy) -> (SupervisorState, [SupervisorEffect]) {
        let delay = policy.delay(forAttempt: failures)
        let phase = SupervisorPhase.waitingToRestart(attempt: failures, until: at.addingTimeInterval(delay))
        return (s.with(phase: phase, failures: failures), [.scheduleRetry(after: delay)])
    }
}
