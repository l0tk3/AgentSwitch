import Darwin
import Foundation

/// Everything a launch depends on, captured at once so a settings change applies on the next start.
public struct RuntimeConfig: Sendable, Equatable {
    public let paths: AppPaths
    public let ports: PortSettings
    public let options: DaemonOptions
    /// Login-shell PATH for the daemon (harness binaries).
    public let path: String
    public let baseEnvironment: [String: String]
    /// The Mac's name for the pairing payload and Bonjour (`AGENTSWITCH_REMOTE_NAME`).
    public let remoteName: String?
    /// OpenCode found on the login PATH or at a known location (`OPENCODE_BIN`).
    public let opencodeBinary: String?
    /// The user's own Claude Code (`CLAUDE_BIN`): it already holds the Keychain grant for its login; the copy inside
    /// the Agent SDK is another code signature, so macOS would ask again and the daemon's model discovery stalls.
    public let claudeBinary: String?
    /// 通用 › 允许 iPhone 连接 (RemoteAccess): the daemon's remote listener.
    public let remoteEnabled: Bool
    /// Own `secret-gate proxy` child, or the system service (docs/gate-service-v0.md).
    public let gateMode: GateRunMode

    public init(paths: AppPaths, ports: PortSettings, options: DaemonOptions, path: String, baseEnvironment: [String: String],
                remoteName: String? = nil, opencodeBinary: String? = nil, claudeBinary: String? = nil,
                remoteEnabled: Bool = RemoteAccess.defaultValue, gateMode: GateRunMode = .userProcess) {
        self.paths = paths
        self.ports = ports
        self.options = options
        self.path = path
        self.baseEnvironment = baseEnvironment
        self.remoteName = remoteName
        self.opencodeBinary = opencodeBinary
        self.claudeBinary = claudeBinary
        self.remoteEnabled = remoteEnabled
        self.gateMode = gateMode
    }

    public var gateEnvironment: [String: String] { ChildEnvironment.gate(base: baseEnvironment, paths: paths, gateMode: gateMode) }
    public var gateCLI: GateCLI { GateCLI(executable: paths.runtime.secretGate, environment: gateEnvironment) }
}

/// Launch specs and the pure decisions of the preflight checks.
public enum RuntimePlan {
    public static let daemonStopTimeout: TimeInterval = 10
    public static let gateStopTimeout: TimeInterval = 5

    public static func gateSpec(_ c: RuntimeConfig) -> LaunchSpec {
        LaunchSpec(executable: c.paths.runtime.secretGate, arguments: ["proxy", "--port", String(c.ports.gate)],
                   environment: c.gateEnvironment, workingDirectory: c.paths.gateHome.deletingLastPathComponent(),
                   logFile: c.paths.gateLog, pidFile: c.paths.gatePidFile, stopSignal: SIGTERM, stopTimeout: gateStopTimeout)
    }

    public static func daemonSpec(_ c: RuntimeConfig) -> LaunchSpec {
        let env = ChildEnvironment.daemon(base: c.baseEnvironment, paths: c.paths, ports: c.ports, options: c.options, path: c.path,
                                          remote: c.remoteEnabled, remoteName: c.remoteName, opencodeBinary: c.opencodeBinary,
                                          claudeBinary: c.claudeBinary, gateMode: c.gateMode)
        // `npm start` of packages/daemon, with absolute paths.
        let args = ["--no-warnings=ExperimentalWarning", c.paths.runtime.daemonCLI.path, "serve"]
        return LaunchSpec(executable: c.paths.runtime.node, arguments: args,
                          // The data folder, not the bundle: an app kept on the Desktop would otherwise put every
                          // child's cwd inside a privacy-protected folder (Claude Code scans parents for CLAUDE.md).
                          environment: env, workingDirectory: c.paths.agentswitchHome,
                          logFile: c.paths.daemonLog, pidFile: c.paths.daemonPidFile, stopSignal: SIGINT, stopTimeout: daemonStopTimeout)
    }

    /// Gate port busy: reuse a listener that passes the bootstrap probe, refuse anything else (app-v0 §4).
    public static func gateDecision(port: Int, probe: GateProbe.Result?) -> Preflight? {
        guard let probe, probe.verdict != .unreachable else { return nil }
        if probe.isGate { return .adopt("复用 127.0.0.1:\(port) 上已运行的 secret-gate") }
        return .fail("端口 \(port) 已被占用，占用程序不是 secret-gate（\(probe.detail)）。请在「General」中更换网关端口，或退出占用该端口的程序。")
    }

    /// Ports the daemon will bind, checked before launch: the remote one only while remote access is on.
    public static func daemonPorts(_ c: RuntimeConfig) -> [(label: String, port: Int)] {
        c.remoteEnabled ? [("本地接口", c.ports.local), ("远程接口", c.ports.remote)] : [("本地接口", c.ports.local)]
    }

    /// Busy daemon ports → the message the user sees; nil when all are free.
    public static func daemonPortProblem(busy: [(label: String, port: Int)]) -> String? {
        guard !busy.isEmpty else { return nil }
        let list = busy.map { "\($0.label) \($0.port)" }.joined(separator: "、")
        return "端口已被占用：\(list)。占用程序可能是另一个 AgentSwitch 服务。请在「General」中更换端口后重启服务。"
    }

    /// No `secret-gate proxy` as this user while the system service is there, whatever asked for one (a lost adopted
    /// gate, a restart, a mode not yet switched): it would quietly undo the isolation (gate-service-v0 §4).
    public static func serviceGuard(mode: GateRunMode, installedOnDisk: Bool) -> Preflight? {
        if mode.isService { return .fail(serviceNotResponding) }
        if installedOnDisk { return .fail("凭据网关已安装为系统服务，不再由 AgentSwitch 启动。") }
        return nil
    }

    public static let serviceNotResponding =
        "凭据网关服务无响应。系统服务由 launchd 自动重启；持续无响应时，可在「Environment」中修复（需要管理员授权）。"

    public static func missingRuntime(_ missing: [String]) -> String? {
        missing.isEmpty ? nil : "内置运行时不完整，缺少：\(missing.joined(separator: "、"))。请重新构建应用（scripts/build-app.sh）后重试。"
    }
}

/// The effectful preflight checks the supervisors run before every launch.
public enum RuntimePreflight {
    public static func gate(_ c: RuntimeConfig) async -> Preflight {
        let onDisk = GateServiceProbe.installedOnDisk(c.paths.gateService)
        if let refused = RuntimePlan.serviceGuard(mode: c.gateMode, installedOnDisk: onDisk) { return refused }
        if !FileManager.default.isExecutableFile(atPath: c.paths.runtime.secretGate.path) {
            return .fail(RuntimePlan.missingRuntime([c.paths.runtime.secretGate.path])!)
        }
        _ = await Leftovers.reap(pidFile: c.paths.gatePidFile, runtimeRoot: c.paths.runtime.root,
                                 signal: SIGTERM, timeout: RuntimePlan.gateStopTimeout)
        let port = c.ports.gate
        let probe = await Task.detached { GateProbe.probe(port: port) }.value
        if let decision = RuntimePlan.gateDecision(port: port, probe: probe) { return decision }
        do {
            _ = try await c.gateCLI.ensureKeypair()   // the proxy refuses to start without one
        } catch {
            return .fail("无法准备网关密钥对：\(error.localizedDescription)")
        }
        return .launch(RuntimePlan.gateSpec(c))
    }

    public static func daemon(_ c: RuntimeConfig) async -> Preflight {
        if let problem = RuntimePlan.missingRuntime(c.paths.runtime.missing().filter { !$0.hasSuffix("secret-gate") }) {
            return .fail(problem)
        }
        _ = await Leftovers.reap(pidFile: c.paths.daemonPidFile, runtimeRoot: c.paths.runtime.root,
                                 signal: SIGINT, timeout: RuntimePlan.daemonStopTimeout)
        let ports = RuntimePlan.daemonPorts(c)
        let busy = await Task.detached { ports.filter { PortProbe.isListening(port: $0.port) } }.value
        if let problem = RuntimePlan.daemonPortProblem(busy: busy) { return .fail(problem) }
        do {
            try c.paths.prepareDirectories()
        } catch {
            return .fail("无法创建数据目录 \(c.paths.agentswitchHome.path)：\(error.localizedDescription)")
        }
        return .launch(RuntimePlan.daemonSpec(c))
    }
}
