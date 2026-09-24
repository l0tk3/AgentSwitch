import Darwin
import Foundation

/// What to run for one supervised child.
public struct LaunchSpec: Sendable, Equatable {
    public let executable: URL
    public let arguments: [String]
    public let environment: [String: String]
    public let workingDirectory: URL?
    public let logFile: URL
    public let pidFile: URL?
    /// The daemon shuts down gracefully on SIGINT, the gate (mitmdump) on SIGTERM.
    public let stopSignal: Int32
    public let stopTimeout: TimeInterval

    public init(executable: URL, arguments: [String], environment: [String: String], workingDirectory: URL?,
                logFile: URL, pidFile: URL?, stopSignal: Int32, stopTimeout: TimeInterval) {
        self.executable = executable
        self.arguments = arguments
        self.environment = environment
        self.workingDirectory = workingDirectory
        self.logFile = logFile
        self.pidFile = pidFile
        self.stopSignal = stopSignal
        self.stopTimeout = stopTimeout
    }
}

/// Outcome of the checks that run before every launch (ports, runtime, leftovers).
public enum Preflight: Sendable, Equatable {
    case launch(LaunchSpec)
    case adopt(String)
    case fail(String)
}

/// Runs one child under `SupervisorMachine`: launches it, restarts it with backoff, stops it cleanly.
public actor ProcessSupervisor {
    public typealias PreflightCheck = @Sendable () async -> Preflight
    public typealias Observer = @Sendable (SupervisorState) -> Void

    public private(set) var state = SupervisorState.initial
    private let name: String
    private let policy: BackoffPolicy
    private let preflight: PreflightCheck
    private let observer: Observer
    private var process: Process?
    private var spec: LaunchSpec?
    private var retryTask: Task<Void, Never>?
    /// Bumped on every launch attempt so a late preflight result from an earlier attempt is dropped.
    private var generation = 0
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    public init(name: String, policy: BackoffPolicy = .standard, preflight: @escaping PreflightCheck,
                observer: @escaping Observer) {
        self.name = name
        self.policy = policy
        self.preflight = preflight
        self.observer = observer
    }

    public func start() { apply(.startRequested) }
    public func restart() { apply(.restartRequested) }
    public func reportUnhealthy(_ reason: String) { apply(.unhealthy(reason)) }
    public func reportExternalLost() { apply(.externalLost) }

    /// Stops the child and returns once it has exited (escalating to SIGKILL after the spec's timeout).
    public func stop() async {
        apply(.stopRequested)
        while !isIdle {
            await withCheckedContinuation { idleWaiters.append($0) }
        }
    }

    /// `stop` always ends in `.stopped`: every other phase either reduces to it or passes through `.stopping`.
    private var isIdle: Bool { state.phase == .stopped }

    // MARK: machine plumbing

    private func apply(_ event: SupervisorEvent) {
        let (next, effects) = SupervisorMachine.reduce(state, event, policy: policy)
        state = next
        observer(next)
        for effect in effects { perform(effect) }
        if isIdle {
            let waiters = idleWaiters
            idleWaiters = []
            waiters.forEach { $0.resume() }
        }
    }

    private func perform(_ effect: SupervisorEffect) {
        switch effect {
        case .preflightAndLaunch:
            generation += 1
            let current = generation
            let check = preflight
            Task {
                let result = await check()
                self.launch(result, generation: current)
            }
        case .scheduleRetry(let delay):
            retryTask?.cancel()
            retryTask = Task {
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                self.apply(.retryDue)
            }
        case .cancelRetry:
            retryTask?.cancel()
            retryTask = nil
        case .terminate(let pid):
            terminate(pid: pid)
        }
    }

    private func launch(_ result: Preflight, generation current: Int) {
        guard current == generation, state.phase == .starting else { return }
        switch result {
        case .fail(let why): apply(.preflightFailed(why))
        case .adopt(let what): apply(.adoptedExternal(what))
        case .launch(let spec): spawn(spec)
        }
    }

    private func spawn(_ spec: LaunchSpec) {
        let proc = Process()
        proc.executableURL = spec.executable
        proc.arguments = spec.arguments
        proc.environment = spec.environment
        if let dir = spec.workingDirectory { proc.currentDirectoryURL = dir }
        proc.standardInput = FileHandle.nullDevice
        do {
            let log = try LogFiles.open(spec.logFile, header: "\(name) start: \(spec.executable.path) \(spec.arguments.joined(separator: " "))")
            proc.standardOutput = log
            proc.standardError = log
            proc.terminationHandler = { [weak self] p in
                let status = p.terminationStatus
                let signaled = p.terminationReason == .uncaughtSignal
                let pid = p.processIdentifier
                Task { await self?.exited(pid: pid, status: status, signaled: signaled) }
            }
            try proc.run()
            try? log.close()   // the child holds its own descriptor
        } catch {
            apply(.launchFailed(error.localizedDescription, at: Date()))
            return
        }
        process = proc
        self.spec = spec
        if let pidFile = spec.pidFile { Leftovers.writePid(proc.processIdentifier, to: pidFile) }
        apply(.launched(pid: proc.processIdentifier, at: Date()))
    }

    private func exited(pid: Int32, status: Int32, signaled: Bool) {
        guard process?.processIdentifier == pid else { return }
        process = nil
        if let pidFile = spec?.pidFile { Leftovers.removePid(pidFile) }
        LogFiles.appendLine(spec?.logFile, "\(name) exited: \(signaled ? "signal" : "status") \(status)")
        apply(.exited(status: status, signaled: signaled, at: Date()))
    }

    /// Graceful signal first; SIGKILL if the same process is still there after the timeout.
    private func terminate(pid: Int32) {
        let signal = spec?.stopSignal ?? SIGTERM
        let timeout = spec?.stopTimeout ?? 5
        kill(pid, signal)
        Task {
            try? await Task.sleep(for: .seconds(timeout))
            self.escalate(pid: pid)
        }
    }

    private func escalate(pid: Int32) {
        guard process?.processIdentifier == pid, process?.isRunning == true else { return }
        LogFiles.appendLine(spec?.logFile, "\(name) did not stop in time: SIGKILL")
        kill(pid, SIGKILL)
    }
}
