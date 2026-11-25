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
    /// Codex and pi as chosen in 设置 › Agents (`CODEX_BIN`, `PI_BIN`, docs/agents-v0.md §3); nil leaves the daemon to
    /// find them itself (its catalog's path, the PATH).
    public let codexBinary: String?
    public let piBinary: String?
    /// 通用 › 允许 iPhone 连接 (RemoteAccess): the daemon's remote listener.
    public let remoteEnabled: Bool

    public init(paths: AppPaths, ports: PortSettings, options: DaemonOptions, path: String, baseEnvironment: [String: String],
                remoteName: String? = nil, opencodeBinary: String? = nil, claudeBinary: String? = nil,
                codexBinary: String? = nil, piBinary: String? = nil,
                remoteEnabled: Bool = RemoteAccess.defaultValue) {
        self.paths = paths
        self.ports = ports
        self.options = options
        self.path = path
        self.baseEnvironment = baseEnvironment
        self.remoteName = remoteName
        self.opencodeBinary = opencodeBinary
        self.claudeBinary = claudeBinary
        self.codexBinary = codexBinary
        self.piBinary = piBinary
        self.remoteEnabled = remoteEnabled
    }

    /// The agents' programs this launch hands the daemon, by agent.
    public var agentBinaries: [AgentCLI: String] {
        var out: [AgentCLI: String] = [:]
        out[.claude] = claudeBinary
        out[.codex] = codexBinary
        out[.opencode] = opencodeBinary
        out[.pi] = piBinary
        return out
    }
}

/// Launch specs and the pure decisions of the preflight checks.
public enum RuntimePlan {
    public static let daemonStopTimeout: TimeInterval = 10

    /// The daemon's vault key (VaultKey.swift: the Keychain's), handed over on its stdin; nil: the daemon keeps a key
    /// file of its own. Set by the app at its start; tests leave it nil.
    nonisolated(unsafe) public static var vaultKey: @Sendable () -> String? = { nil }

    public static func daemonSpec(_ c: RuntimeConfig) -> LaunchSpec {
        var env = ChildEnvironment.daemon(base: c.baseEnvironment, paths: c.paths, ports: c.ports, options: c.options, path: c.path,
                                          remote: c.remoteEnabled, remoteName: c.remoteName, opencodeBinary: c.opencodeBinary,
                                          claudeBinary: c.claudeBinary, codexBinary: c.codexBinary, piBinary: c.piBinary)
        let key = vaultKey()
        if key != nil { env["AGENTSWITCH_VAULT_STDIN"] = "1" }
        // `npm start` of packages/daemon, with absolute paths.
        let args = ["--no-warnings=ExperimentalWarning", c.paths.runtime.daemonCLI.path, "serve"]
        return LaunchSpec(executable: c.paths.runtime.node, arguments: args,
                          // The data folder, not the bundle: an app kept on the Desktop would otherwise put every
                          // child's cwd inside a privacy-protected folder (Claude Code scans parents for CLAUDE.md).
                          environment: env, workingDirectory: c.paths.agentswitchHome,
                          logFile: c.paths.daemonLog, pidFile: c.paths.daemonPidFile, stopSignal: SIGINT, stopTimeout: daemonStopTimeout,
                          stdinLine: key)
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

    public static func missingRuntime(_ missing: [String]) -> String? {
        missing.isEmpty ? nil : "内置运行时不完整，缺少：\(missing.joined(separator: "、"))。请重新构建应用（scripts/build-app.sh）后重试。"
    }
}

/// The effectful preflight check the supervisor runs before every launch.
public enum RuntimePreflight {
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
