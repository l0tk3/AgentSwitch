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

    public init(paths: AppPaths, ports: PortSettings, options: DaemonOptions, path: String, baseEnvironment: [String: String],
                remoteName: String? = nil, opencodeBinary: String? = nil, claudeBinary: String? = nil,
                remoteEnabled: Bool = RemoteAccess.defaultValue) {
        self.paths = paths
        self.ports = ports
        self.options = options
        self.path = path
        self.baseEnvironment = baseEnvironment
        self.remoteName = remoteName
        self.opencodeBinary = opencodeBinary
        self.claudeBinary = claudeBinary
        self.remoteEnabled = remoteEnabled
    }

    public var gateEnvironment: [String: String] { ChildEnvironment.gate(base: baseEnvironment, paths: paths) }
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
                                          claudeBinary: c.claudeBinary)
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
        if probe.isGate { return .adopt("复用 127.0.0.1:\(port) 上已在运行的 secret-gate") }
        return .fail("端口 \(port) 被占用，但不是 secret-gate（\(probe.detail)）。在「通用」里换一个网关端口，或停掉占用它的程序。")
    }

    /// Ports the daemon will bind, checked before launch: the remote one only while remote access is on.
    public static func daemonPorts(_ c: RuntimeConfig) -> [(label: String, port: Int)] {
        c.remoteEnabled ? [("本地接口", c.ports.local), ("远程接口", c.ports.remote)] : [("本地接口", c.ports.local)]
    }

    /// Busy daemon ports → the message the user sees; nil when all are free.
    public static func daemonPortProblem(busy: [(label: String, port: Int)]) -> String? {
        guard !busy.isEmpty else { return nil }
        let list = busy.map { "\($0.label) \($0.port)" }.joined(separator: "、")
        return "端口已被占用：\(list)。可能是另一个 agentswitch 守护进程；在「通用」里换端口后重启服务。"
    }

    public static func missingRuntime(_ missing: [String]) -> String? {
        missing.isEmpty ? nil : "内置运行时不完整，缺少：\(missing.joined(separator: "、"))。请重新构建应用（scripts/build-app.sh）。"
    }
}

/// The effectful preflight checks the supervisors run before every launch.
public enum RuntimePreflight {
    public static func gate(_ c: RuntimeConfig) async -> Preflight {
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
            return .fail("没能准备网关密钥对：\(error.localizedDescription)")
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
            return .fail("没能创建数据目录 \(c.paths.agentswitchHome.path)：\(error.localizedDescription)")
        }
        return .launch(RuntimePlan.daemonSpec(c))
    }
}
