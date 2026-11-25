import Foundation

/// The environment of the supervised daemon. Built from a small allow-list of the app's own environment, never
/// the whole thing: proxy variables in particular must not leak into Codex's process env.
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
    /// `SECRET_GATE_BIN` and `SECRET_GATE_HOME`: the bundled secret-gate program runs the daemon's model traffic
    /// gateway, and the daemon reads the old gate's home once to move what it held.
    public static func daemon(base: [String: String], paths: AppPaths, ports: PortSettings, options: DaemonOptions,
                              path: String, remote: Bool = true, remoteName: String? = nil,
                              opencodeBinary: String? = nil, claudeBinary: String? = nil,
                              codexBinary: String? = nil, piBinary: String? = nil) -> [String: String] {
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
}
