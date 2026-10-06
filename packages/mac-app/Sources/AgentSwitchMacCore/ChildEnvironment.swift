import Foundation

/// Environments for the supervised children. Built from a small allow-list of the app's own environment, never
/// the whole thing: proxy variables in particular must not leak into the gate or into Codex's process env
/// (packages/secret-gate/README.md, "Codex specifics").
public enum ChildEnvironment {
    /// Carried over from the app when present. A Finder-launched app has little more than these.
    /// SSH_AUTH_SOCK is kept on purpose: executors run `git push` and other ssh-backed commands, which need the
    /// user's agent. It also means a task sent from a paired phone can use every key loaded in that agent. `git push`
    /// is its own human-approval category in the daemon (approval policy `git_push`); for a click per key use, load
    /// keys with the agent's confirmation (`ssh-add -c`).
    public static let inherited: [String] = [
        "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK",
        "__CF_USER_TEXT_ENCODING",
    ]
    public static let fallbackLang = "en_US.UTF-8"

    public static func base(from env: [String: String], userHome: URL) -> [String: String] {
        var out = env.filter { inherited.contains($0.key) }
        out["HOME"] = out["HOME"] ?? userHome.path
        out["LANG"] = out["LANG"] ?? fallbackLang
        return out
    }

    /// `node dist/cli.js serve` (app-v0 §2 开关与端口, §4 环境).
    /// `remote` is 通用 › 允许 iPhone 连接 (RemoteAccess): off starts the daemon with `AGENTSWITCH_REMOTE=0`, so it
    /// opens no remote listener and cannot issue pairing codes.
    /// `remoteName` is the Mac name in the pairing payload; the daemon derives the Bonjour name
    /// "AgentSwitch on <name>" from it, which is the name the app publishes. `opencodeBinary` because the daemon
    /// looks only at ~/.opencode/bin/opencode otherwise, not PATH.
    /// `gateMode` `.service`: the gate is the system service (docs/gate-service-v0.md §4); `SECRET_GATE_PROXY` is its
    /// port, and `SECRET_GATE_PUBLIC` / `SECRET_GATE_CA` point at its public directory and published CA.
    public static func daemon(base: [String: String], paths: AppPaths, ports: PortSettings, options: DaemonOptions,
                              path: String, remote: Bool = true, remoteName: String? = nil,
                              opencodeBinary: String? = nil, claudeBinary: String? = nil,
                              codexBinary: String? = nil, piBinary: String? = nil,
                              gateMode: GateRunMode = .userProcess) -> [String: String] {
        var env = base
        env["PATH"] = path
        env["AGENTSWITCH_HOME"] = paths.agentswitchHome.path
        env["AGENTSWITCH_PORT"] = String(ports.local)
        env["AGENTSWITCH_REMOTE"] = remote ? "1" : "0"
        if remote {
            env["AGENTSWITCH_REMOTE_PORT"] = String(ports.remote)
            if let remoteName, !remoteName.isEmpty { env["AGENTSWITCH_REMOTE_NAME"] = remoteName }
        }
        env["AGENTSWITCH_OPENCODE_PORT"] = String(ports.opencode)
        env["AGENTSWITCH_EXECUTORS"] = options.executors
        if let router = options.router { env["AGENTSWITCH_ROUTER"] = router }
        env["SECRET_GATE_HOME"] = paths.gateHome.path
        env["SECRET_GATE_BIN"] = paths.runtime.secretGate.path
        // Staged updates sit next to the bundle; the daemon offers them to the phone (assistant-v0 §5).
        if let bundle = paths.runtime.appBundle { env["AGENTSWITCH_APP_BUNDLE"] = bundle.path }
        env["SECRET_GATE_PROXY"] = "http://127.0.0.1:\(gatePort(ports, gateMode))"
        env.merge(service(gateMode)) { _, new in new }
        if let opencodeBinary { env["OPENCODE_BIN"] = opencodeBinary }
        if let claudeBinary { env["CLAUDE_BIN"] = claudeBinary }
        // The install chosen in 设置 › Agents (docs/agents-v0.md §3); unset, the daemon looks where it always did.
        if let codexBinary { env[AgentCLI.codex.environmentKey] = codexBinary }
        if let piBinary { env[AgentCLI.pi.environmentKey] = piBinary }
        // Tailscale.app's binary acts as the CLI only with a TERM or this flag; a Finder-launched app has neither,
        // and the daemon's `tailscale ip -4` for the pairing payload would otherwise try to start the GUI.
        env[Tailscale.cliModeVariable] = "1"
        // The daemon runs the bundled secret-gate CLI too: keep Python from writing .pyc into the signed bundle.
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return env
    }

    /// `secret-gate proxy` and every other call of the bundled CLI. Like the launchd service: gate home, a
    /// minimal PATH, no proxy variables. In service mode the CLI finds the service through `SECRET_GATE_PUBLIC`.
    public static func gate(base: [String: String], paths: AppPaths, gateMode: GateRunMode = .userProcess) -> [String: String] {
        var env = base
        env["PATH"] = [paths.runtime.pythonBin.path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        env["SECRET_GATE_HOME"] = paths.gateHome.path
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONNOUSERSITE"] = "1"
        env.merge(service(gateMode)) { _, new in new }
        return env
    }

    /// The proxy port children use: the service's own in service mode.
    public static func gatePort(_ ports: PortSettings, _ mode: GateRunMode) -> Int {
        if case .service(_, let port) = mode { return port }
        return ports.gate
    }

    /// `SECRET_GATE_PUBLIC` and `SECRET_GATE_CA`; nothing for the user process (today's environment, unchanged).
    static func service(_ mode: GateRunMode) -> [String: String] {
        guard let dir = mode.publicDir, let ca = mode.ca else { return [:] }
        return ["SECRET_GATE_PUBLIC": dir.path, "SECRET_GATE_CA": ca.path]
    }
}
