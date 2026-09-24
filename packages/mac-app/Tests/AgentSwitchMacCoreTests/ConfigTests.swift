import Darwin
import XCTest
@testable import AgentSwitchMacCore

final class PathsTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/someone")

    func testDefaultsFollowTheContract() {
        let p = AppPaths.resolve(environment: [:], userHome: home, bundleResources: URL(fileURLWithPath: "/Applications/AgentSwitch.app/Contents/Resources"))
        XCTAssertEqual(p.agentswitchHome.path, "/Users/someone/Library/Application Support/AgentSwitch")
        XCTAssertEqual(p.gateHome.path, "/Users/someone/.secret-gate")
        XCTAssertEqual(p.logsDir.path, "/Users/someone/Library/Logs/AgentSwitch")
        XCTAssertEqual(p.daemonLog.lastPathComponent, "daemon.log")
        XCTAssertEqual(p.gateLog.lastPathComponent, "gate.log")
        XCTAssertEqual(p.runtime.node.path, "/Applications/AgentSwitch.app/Contents/Resources/runtime/node/bin/node")
        XCTAssertEqual(p.runtime.daemonCLI.path, "/Applications/AgentSwitch.app/Contents/Resources/runtime/daemon/dist/cli.js")
        XCTAssertEqual(p.runtime.secretGate.path, "/Applications/AgentSwitch.app/Contents/Resources/runtime/python/bin/secret-gate")
        XCTAssertEqual(p.gateCA.path, "/Users/someone/.secret-gate/ca.pem")
        XCTAssertEqual(p.mitmproxyCA.path, "/Users/someone/.mitmproxy/mitmproxy-ca-cert.pem")
    }

    func testEnvironmentOverridesWin() {
        let env = ["AGENTSWITCH_HOME": "/tmp/as", "SECRET_GATE_HOME": "/tmp/sg", "AGENTSWITCH_APP_LOGS": "/tmp/logs",
                   "AGENTSWITCH_APP_RUNTIME": "/tmp/rt"]
        let p = AppPaths.resolve(environment: env, userHome: home, bundleResources: nil, runtimeRoot: "/ignored", allowRuntimeOverride: true)
        XCTAssertEqual(p.agentswitchHome.path, "/tmp/as")
        XCTAssertEqual(p.gateHome.path, "/tmp/sg")
        XCTAssertEqual(p.logsDir.path, "/tmp/logs")
        XCTAssertEqual(p.runtime.root.path, "/tmp/rt")
        XCTAssertEqual(p.appLockFile.path, "/tmp/as/run/app.lock")
        let q = AppPaths.resolve(environment: [:], userHome: home, bundleResources: nil, runtimeRoot: "/opt/rt", allowRuntimeOverride: true)
        XCTAssertEqual(q.runtime.root.path, "/opt/rt")
    }

    func testReleaseRunsOnlyTheBundledRuntime() {
        let bundle = URL(fileURLWithPath: "/Applications/AgentSwitch.app/Contents/Resources")
        let env = ["AGENTSWITCH_HOME": "/tmp/as", "AGENTSWITCH_APP_RUNTIME": "/tmp/evil"]
        let p = AppPaths.resolve(environment: env, userHome: home, bundleResources: bundle, runtimeRoot: "/tmp/evil2")
        XCTAssertEqual(p.runtime.root.path, "/Applications/AgentSwitch.app/Contents/Resources/runtime")
        XCTAssertEqual(p.agentswitchHome.path, "/tmp/as", "the smoke-test home override stays")
        let explicit = AppPaths.resolve(environment: env, userHome: home, bundleResources: bundle, runtimeRoot: "/tmp/evil2",
                                        allowRuntimeOverride: false)
        XCTAssertEqual(explicit.runtime.root, p.runtime.root)
    }

    func testRuntimeMissingAndVersions() throws {
        let root = TestSupport.tempDir("rt")
        let layout = RuntimeLayout(root: root)
        XCTAssertEqual(layout.missing().count, 3)
        try "node=24.21.0\npython = 3.12.14\n\nbad line\n".write(to: layout.versionsFile, atomically: true, encoding: .utf8)
        XCTAssertEqual(layout.versions(), ["node": "24.21.0", "python": "3.12.14"])
    }
}

final class SettingsTests: XCTestCase {
    func testDefaultsAndProblems() {
        XCTAssertEqual(PortSettings.defaults, PortSettings(local: 4711, remote: 4713, gate: 8080, opencode: 4712))
        XCTAssertEqual(PortSettings.defaults.problems(), [])
        XCTAssertEqual(PortSettings.defaults.with(remote: 4711).problems(), ["四个端口必须互不相同"])
        XCTAssertEqual(PortSettings.defaults.with(gate: 80).problems().count, 1)
    }

    func testLoadFallsBackKeyByKey() {
        let stored: [String: Int] = ["localPort": 4811, "gatePort": 8180]
        let s = PortSettings.load { stored[$0] }
        XCTAssertEqual(s, PortSettings(local: 4811, remote: 4713, gate: 8180, opencode: 4712))
        XCTAssertEqual(PortSettings.load { s.keyed[$0] }, s)
    }

    func testDaemonOptions() {
        XCTAssertEqual(DaemonOptions.load { _ in nil }, .standard)
        let echo = DaemonOptions.load { ["executors": "echo", "router": "echo"][$0] }
        XCTAssertEqual(echo, DaemonOptions(executors: "echo", router: "echo"))
        XCTAssertEqual(DaemonOptions.load { ["executors": "bogus", "router": "x"][$0] }, .standard)
    }

    func testRemoteAccessDefaultsOn() {
        XCTAssertTrue(RemoteAccess.load { _ in nil })
        XCTAssertFalse(RemoteAccess.load { ["remoteAccess": false][$0] })
        XCTAssertTrue(RemoteAccess.load { ["remoteAccess": true][$0] })
    }
}

final class ChildEnvironmentTests: XCTestCase {
    private let paths = AppPaths.resolve(environment: [:], userHome: URL(fileURLWithPath: "/Users/u"),
                                         bundleResources: URL(fileURLWithPath: "/A.app/Contents/Resources"))

    func testBaseKeepsOnlyTheAllowList() {
        let base = ChildEnvironment.base(from: ["HOME": "/Users/u", "USER": "u", "HTTPS_PROXY": "http://x", "http_proxy": "http://x",
                                                "ANTHROPIC_API_KEY": "sk", "SSH_AUTH_SOCK": "/tmp/s"], userHome: paths.userHome)
        XCTAssertEqual(base["USER"], "u")
        XCTAssertEqual(base["SSH_AUTH_SOCK"], "/tmp/s")
        XCTAssertEqual(base["LANG"], ChildEnvironment.fallbackLang)
        XCTAssertNil(base["HTTPS_PROXY"])
        XCTAssertNil(base["http_proxy"])
        XCTAssertNil(base["ANTHROPIC_API_KEY"])
    }

    func testDaemonEnvironment() {
        let env = ChildEnvironment.daemon(base: ["HOME": "/Users/u"], paths: paths, ports: .defaults.with(local: 4811),
                                          options: .standard, path: "/opt/homebrew/bin:/usr/bin")
        XCTAssertEqual(env["AGENTSWITCH_HOME"], "/Users/u/Library/Application Support/AgentSwitch")
        XCTAssertEqual(env["AGENTSWITCH_PORT"], "4811")
        XCTAssertEqual(env["AGENTSWITCH_REMOTE"], "1")
        XCTAssertEqual(env["AGENTSWITCH_REMOTE_PORT"], "4713")
        XCTAssertEqual(env["AGENTSWITCH_OPENCODE_PORT"], "4712")
        XCTAssertEqual(env["AGENTSWITCH_EXECUTORS"], "real")
        XCTAssertNil(env["AGENTSWITCH_ROUTER"])
        XCTAssertEqual(env["SECRET_GATE_HOME"], "/Users/u/.secret-gate")
        XCTAssertEqual(env["SECRET_GATE_BIN"], "/A.app/Contents/Resources/runtime/python/bin/secret-gate")
        XCTAssertEqual(env["SECRET_GATE_PROXY"], "http://127.0.0.1:8080")
        XCTAssertEqual(env["PATH"], "/opt/homebrew/bin:/usr/bin")
        XCTAssertNil(env["NODE_OPTIONS"], "never leaks into executor shells")
        XCTAssertEqual(env["TAILSCALE_BE_CLI"], "1")
        XCTAssertNil(env["AGENTSWITCH_REMOTE_NAME"])
        let named = ChildEnvironment.daemon(base: [:], paths: paths, ports: .defaults, options: .standard, path: "",
                                            remoteName: "小明的 Mac", opencodeBinary: "/Users/u/.opencode/bin/opencode",
                                            claudeBinary: "/Users/u/.local/bin/claude")
        XCTAssertEqual(named["AGENTSWITCH_REMOTE_NAME"], "小明的 Mac")
        XCTAssertEqual(named["CLAUDE_BIN"], "/Users/u/.local/bin/claude")
        XCTAssertNil(env["CLAUDE_BIN"], "unset: the daemon falls back to the SDK's bundled CLI")
        XCTAssertEqual(named["OPENCODE_BIN"], "/Users/u/.opencode/bin/opencode")
        let echo = ChildEnvironment.daemon(base: [:], paths: paths, ports: .defaults, options: DaemonOptions(executors: "echo", router: "echo"), path: "")
        XCTAssertEqual(echo["AGENTSWITCH_EXECUTORS"], "echo")
        XCTAssertEqual(echo["AGENTSWITCH_ROUTER"], "echo")
    }

    func testRemoteOffStartsTheDaemonWithoutItsRemoteListener() {
        let env = ChildEnvironment.daemon(base: [:], paths: paths, ports: .defaults, options: .standard, path: "",
                                          remote: false, remoteName: "小明的 Mac")
        XCTAssertEqual(env["AGENTSWITCH_REMOTE"], "0")
        XCTAssertNil(env["AGENTSWITCH_REMOTE_PORT"])
        XCTAssertNil(env["AGENTSWITCH_REMOTE_NAME"])
        XCTAssertEqual(env["AGENTSWITCH_PORT"], "4711")
        let off = RuntimeConfig(paths: paths, ports: .defaults, options: .standard, path: "/usr/bin", baseEnvironment: [:], remoteEnabled: false)
        XCTAssertEqual(RuntimePlan.daemonSpec(off).environment["AGENTSWITCH_REMOTE"], "0")
        XCTAssertEqual(RuntimePlan.daemonPorts(off).map(\.port), [4711], "a busy remote port does not matter while remote is off")
        let on = RuntimeConfig(paths: paths, ports: .defaults, options: .standard, path: "/usr/bin", baseEnvironment: [:])
        XCTAssertEqual(RuntimePlan.daemonPorts(on).map(\.port), [4711, 4713])
    }

    func testDaemonPreflightSkipsTheRemotePortWhenRemoteIsOff() async throws {
        let root = TestSupport.tempDir("preflight")
        let runtime = root.appendingPathComponent("runtime")
        for file in ["node/bin/node", "daemon/dist/cli.js"] {
            let url = runtime.appendingPathComponent(file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: url)
        }
        let paths = AppPaths(userHome: root, agentswitchHome: root.appendingPathComponent("home"), gateHome: root.appendingPathComponent("sg"),
                             logsDir: root.appendingPathComponent("logs"), runtime: RuntimeLayout(root: runtime))
        let busy = CannedServer(response: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        defer { busy.stop() }
        let ports = PortSettings(local: TestSupport.freePort(), remote: busy.port, gate: TestSupport.freePort(), opencode: TestSupport.freePort())
        let on = RuntimeConfig(paths: paths, ports: ports, options: .standard, path: "/usr/bin", baseEnvironment: [:])
        guard case .fail(let why) = await RuntimePreflight.daemon(on) else { return XCTFail("remote port is busy") }
        XCTAssertTrue(why.contains("远程接口 \(busy.port)"), why)
        let off = RuntimeConfig(paths: paths, ports: ports, options: .standard, path: "/usr/bin", baseEnvironment: [:], remoteEnabled: false)
        guard case .launch(let spec) = await RuntimePreflight.daemon(off) else { return XCTFail("remote off ignores the remote port") }
        XCTAssertEqual(spec.environment["AGENTSWITCH_REMOTE"], "0")
    }

    func testGateEnvironmentIsMinimal() {
        let env = ChildEnvironment.gate(base: ["HOME": "/Users/u"], paths: paths)
        XCTAssertEqual(env["PATH"], "/A.app/Contents/Resources/runtime/python/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertEqual(env["SECRET_GATE_HOME"], "/Users/u/.secret-gate")
        XCTAssertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
        XCTAssertNil(env["HTTP_PROXY"])
    }

    func testLaunchSpecs() {
        let config = RuntimeConfig(paths: paths, ports: .defaults, options: .standard, path: "/usr/bin", baseEnvironment: ["HOME": "/Users/u"])
        let gate = RuntimePlan.gateSpec(config)
        XCTAssertEqual(gate.executable, paths.runtime.secretGate)
        XCTAssertEqual(gate.arguments, ["proxy", "--port", "8080"])
        XCTAssertEqual(gate.stopSignal, SIGTERM)
        XCTAssertEqual(gate.logFile, paths.gateLog)
        let daemon = RuntimePlan.daemonSpec(config)
        XCTAssertEqual(daemon.executable, paths.runtime.node)
        XCTAssertEqual(daemon.arguments, ["--no-warnings=ExperimentalWarning", paths.runtime.daemonCLI.path, "serve"])
        XCTAssertEqual(daemon.stopSignal, SIGINT)
        XCTAssertEqual(daemon.environment["AGENTSWITCH_REMOTE"], "1")
        XCTAssertEqual(daemon.pidFile, paths.daemonPidFile)
    }

    func testPortProblemMessage() {
        XCTAssertNil(RuntimePlan.daemonPortProblem(busy: []))
        let msg = RuntimePlan.daemonPortProblem(busy: [(label: "本地接口", port: 4711)])
        XCTAssertTrue(msg?.contains("本地接口 4711") ?? false)
    }
}

final class LoginShellPathTests: XCTestCase {
    func testExtractIgnoresNoise() {
        let out = "Last login: today\nwelcome\n__AGENTSWITCH_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__AGENTSWITCH_PATH_END__%"
        XCTAssertEqual(LoginShellPath.extract(from: out), "/opt/homebrew/bin:/usr/bin")
        XCTAssertNil(LoginShellPath.extract(from: "no markers"))
        XCTAssertNil(LoginShellPath.extract(from: "__AGENTSWITCH_PATH_BEGIN____AGENTSWITCH_PATH_END__"))
    }

    func testMergeKeepsShellOrderAndAddsFallbacks() {
        let merged = LoginShellPath.merge(shellPath: "/Users/u/.local/bin:/usr/bin:/custom::/usr/bin", home: "/Users/u")
        XCTAssertEqual(merged.split(separator: ":").map(String.init), [
            "/Users/u/.local/bin", "/usr/bin", "/custom", "/opt/homebrew/bin", "/usr/local/bin", "/Users/u/.opencode/bin",
            "/bin", "/usr/sbin", "/sbin",
        ])
        XCTAssertTrue(LoginShellPath.merge(shellPath: nil, home: "/h").hasPrefix("/opt/homebrew/bin:/usr/local/bin:/h/.local/bin:/h/.opencode/bin"))
    }

    func testResolvesThroughARealShell() async throws {
        let dir = TestSupport.tempDir("shell")
        let shell = dir.appendingPathComponent("fakeshell")
        // A "login shell" whose profile sets PATH, then runs the command it is given.
        try "#!/bin/sh\nPATH=/from/profile:/usr/bin:/bin\nexport PATH\necho banner\nshift\nexec /bin/sh -c \"$1\"\n".write(to: shell, atomically: true, encoding: .utf8)
        chmod(shell.path, 0o755)
        let r = await LoginShellPath.resolve(shell: shell.path, home: "/Users/u", base: [:])
        XCTAssertEqual(r.source, .loginShell)
        XCTAssertTrue(r.path.hasPrefix("/from/profile:/usr/bin:/bin:"), r.path)
    }

    func testHangingShellFallsBack() async throws {
        let dir = TestSupport.tempDir("hang")
        let shell = dir.appendingPathComponent("hangshell")
        try "#!/bin/sh\nsleep 30\n".write(to: shell, atomically: true, encoding: .utf8)
        chmod(shell.path, 0o755)
        let started = Date()
        let r = await LoginShellPath.resolve(shell: shell.path, home: "/Users/u", timeout: 0.5)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual(r.source, .fallback)
        XCTAssertNotNil(r.note)
        XCTAssertTrue(r.path.contains("/opt/homebrew/bin"))
    }
}

final class LogFilesTests: XCTestCase {
    func testAppendRotateAndTail() throws {
        let dir = TestSupport.tempDir("logs")
        let url = dir.appendingPathComponent("sub/daemon.log")
        let h = try LogFiles.open(url, header: "first")
        try h.write(contentsOf: Data("line a\nline b\n".utf8))
        try h.close()
        LogFiles.appendLine(url, "exited")
        let tail = LogFiles.tail(url, maxLines: 3)
        XCTAssertTrue(tail.contains("line b"))
        XCTAssertTrue(tail.contains("exited"))
        let mode = (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int) ?? 0
        XCTAssertEqual(mode & 0o077, 0)
        XCTAssertTrue(LogFiles.shouldRotate(size: LogFiles.rotateBytes))
        XCTAssertFalse(LogFiles.shouldRotate(size: 10))
    }
}
