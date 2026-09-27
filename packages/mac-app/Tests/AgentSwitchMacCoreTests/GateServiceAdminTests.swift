import Darwin
import XCTest
@testable import AgentSwitchMacCore

/// The root commands as the app builds them (never run here) and how osascript's answer is read.
final class GateServiceCommandTests: XCTestCase {
    private let gate = URL(fileURLWithPath: "/Users/u/Desktop/My Apps/AgentSwitch.app/Contents/Resources/runtime/python/bin/secret-gate")
    private let runtime = URL(fileURLWithPath: "/Users/u/Desktop/My Apps/AgentSwitch.app/Contents/Resources/runtime")
    private let home = URL(fileURLWithPath: "/Users/u/.secret-gate")

    private func argv(_ op: GateServiceOperation) -> [String] {
        GateServiceCommand.argv(op, gate: gate, runtime: runtime, ownerUid: 501, port: 8080, migrateFrom: home)
    }

    func testArgv() {
        XCTAssertEqual(argv(.install), [gate.path, "system", "install", "--owner-uid", "501", "--port", "8080",
                                        "--runtime", runtime.path, "--migrate-from", "/Users/u/.secret-gate"])
        XCTAssertEqual(argv(.update), [gate.path, "system", "update", "--runtime", runtime.path])
        XCTAssertEqual(argv(.repair), argv(.update))
        XCTAssertEqual(argv(.changePort(8181)), [gate.path, "system", "update", "--runtime", runtime.path, "--port", "8181"])
        XCTAssertEqual(argv(.uninstall(deleteKeys: false)), [gate.path, "system", "uninstall"])
        XCTAssertEqual(argv(.uninstall(deleteKeys: true)), [gate.path, "system", "uninstall", "--delete-keys"])
    }

    func testShellLineQuotesEveryWordAndKeepsTheStatus() {
        let line = GateServiceCommand.shellLine(argv(.install))
        XCTAssertEqual(line,
                       "/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 "
                       + "'/Users/u/Desktop/My Apps/AgentSwitch.app/Contents/Resources/runtime/python/bin/secret-gate' system install "
                       + "--owner-uid 501 --port 8080 --runtime '/Users/u/Desktop/My Apps/AgentSwitch.app/Contents/Resources/runtime' "
                       + "--migrate-from /Users/u/.secret-gate 2>&1; echo \"__AGENTSWITCH_EXIT__=$?\"")
    }

    /// A bundle path chosen by an attacker stays one word: sh sees exactly the argv the app built.
    func testHostilePathStaysOneWord() throws {
        let dir = TestSupport.tempDir("quote")
        defer { try? FileManager.default.removeItem(at: dir) }
        let pwned = dir.appendingPathComponent("pwned")
        let evil = URL(fileURLWithPath: "\(dir.path)/x'; touch \(pwned.path); echo '$(touch \(pwned.path))`id`/AgentSwitch.app/Contents/Resources/runtime")
        let words = GateServiceCommand.argv(.update, gate: evil.appendingPathComponent("python/bin/secret-gate"), runtime: evil,
                                            ownerUid: 501, port: 8080, migrateFrom: home)
        let line = GateServiceCommand.shellLine(words)
        // Replace the command by printf so sh prints the words it parsed, one per line.
        let probe = line.replacingOccurrences(of: "/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 ",
                                              with: "printf '%s\\n' ")
        let result = try ProcessRunner.runBlocking(URL(fileURLWithPath: "/bin/sh"), ["-c", probe], timeout: 5)
        let lines = result.stdoutText.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertEqual(Array(lines.dropLast()), words)
        XCTAssertEqual(lines.last, "__AGENTSWITCH_EXIT__=0")
        XCTAssertFalse(FileManager.default.fileExists(atPath: pwned.path))
    }

    func testOsascriptGetsTheLineAsArgv() {
        let args = GateServiceCommand.osascriptArguments(shellLine: "echo 'a \"b\"'", prompt: "AgentSwitch 将安装凭据网关服务。")
        XCTAssertEqual(args, [
            "-e", "on run argv",
            "-e", "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings",
            "-e", "end run",
            "echo 'a \"b\"'", "AgentSwitch 将安装凭据网关服务。",
        ])
        XCTAssertEqual(GateServiceOperation.install.prompt, "AgentSwitch 将安装凭据网关服务。")
        XCTAssertTrue(GateServiceOperation.changePort(8181).prompt.contains("8181"))
    }

    private func osa(_ status: Int32, stdout: String = "", stderr: String = "", timedOut: Bool = false) -> CommandResult {
        CommandResult(status: status, stdout: Data(stdout.utf8), stderr: Data(stderr.utf8), timedOut: timedOut)
    }

    func testInterpret() {
        XCTAssertEqual(GateServiceCommand.interpret(osa(0, stdout: "创建账户 _agentswitchgate\n迁移密钥\n__AGENTSWITCH_EXIT__=0\n")),
                       .succeeded(output: "创建账户 _agentswitchgate\n迁移密钥"))
        XCTAssertEqual(GateServiceCommand.interpret(osa(0, stdout: "已完成：创建账户\n未完成：迁移密钥\n无法写入 /Library/…：权限不足\n__AGENTSWITCH_EXIT__=1\n")),
                       .failed(reason: "无法写入 /Library/…：权限不足", output: "已完成：创建账户\n未完成：迁移密钥\n无法写入 /Library/…：权限不足"))
        XCTAssertEqual(GateServiceCommand.interpret(osa(0, stdout: "__AGENTSWITCH_EXIT__=3\n")), .failed(reason: "退出码 3", output: ""))
        XCTAssertEqual(GateServiceCommand.interpret(osa(1, stderr: "0:180: execution error: User canceled. (-128)\n")), .cancelled)
        XCTAssertEqual(GateServiceCommand.interpret(osa(1, stderr: "0:180: execution error: 用户已取消。 (-128)\n")), .cancelled)
        XCTAssertEqual(GateServiceCommand.interpret(osa(1, stderr: "0:212: execution error: The administrator user name or password was incorrect. (-60007)\n")),
                       .failed(reason: "The administrator user name or password was incorrect.", output: ""))
        guard case .failed(let why, _) = GateServiceCommand.interpret(osa(0, stdout: "no marker")) else { return XCTFail() }
        XCTAssertEqual(why, "无法确认执行结果")
        guard case .failed = GateServiceCommand.interpret(osa(0, timedOut: true)) else { return XCTFail() }
        guard case .failed = GateServiceCommand.interpret(nil) else { return XCTFail() }
        XCTAssertEqual(GateServiceCommand.interpret(osa(0, stdout: "x\n__AGENTSWITCH_EXIT__=0\nlate\n__AGENTSWITCH_EXIT__=0")),
                       .succeeded(output: "x\n__AGENTSWITCH_EXIT__=0\nlate"), "the last marker counts")
    }

    func testAdminRunsOsascriptWithTheBuiltLine() async {
        let seen = Recorder()
        let admin = GateServiceAdmin { exe, args, timeout in
            seen.record(exe, args, timeout)
            return CommandResult(status: 0, stdout: Data("ok\n__AGENTSWITCH_EXIT__=0\n".utf8), stderr: Data(), timedOut: false)
        }
        let words = argv(.uninstall(deleteKeys: true))
        let outcome = await admin.perform(words, prompt: GateServiceOperation.uninstall(deleteKeys: true).prompt)
        XCTAssertEqual(outcome, .succeeded(output: "ok"))
        XCTAssertEqual(seen.executable, URL(fileURLWithPath: "/usr/bin/osascript"))
        XCTAssertEqual(seen.arguments.suffix(2), [GateServiceCommand.shellLine(words), "AgentSwitch 将卸载凭据网关服务。"])
        XCTAssertEqual(seen.timeout, GateServiceAdmin.timeout)
        let failing = GateServiceAdmin { _, _, _ in throw CommandError("spawn failed") }
        guard case .failed = await failing.perform(words, prompt: "p") else { return XCTFail() }
    }
}

private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var executable: URL?
    private(set) var arguments: [String] = []
    private(set) var timeout: TimeInterval = 0

    func record(_ exe: URL, _ args: [String], _ t: TimeInterval) {
        lock.lock()
        executable = exe
        arguments = args
        timeout = t
        lock.unlock()
    }
}

/// The user-side CLI calls, against a fake `secret-gate` that logs its argv and answers from canned output.
final class GateCLIServiceTests: XCTestCase {
    private func fakeCLI(_ body: String) throws -> (GateCLI, URL) {
        let dir = TestSupport.tempDir("fakegate")
        let exe = dir.appendingPathComponent("secret-gate")
        let log = dir.appendingPathComponent("argv")
        try "#!/bin/sh\necho \"$@\" >> '\(log.path)'\n\(body)\n".write(to: exe, atomically: true, encoding: .utf8)
        chmod(exe.path, 0o755)
        return (GateCLI(executable: exe, environment: ["PATH": "/usr/bin:/bin", "SECRET_GATE_PUBLIC": dir.path]), log)
    }

    private func calls(_ log: URL) -> [String] {
        ((try? String(contentsOf: log, encoding: .utf8)) ?? "").components(separatedBy: "\n").filter { !$0.isEmpty }
    }

    func testKeypairRowsWithLegacy() throws {
        let rows = #"[{"name":"default","public":"AAA","current":false,"legacy":true},{"name":"main","publicKey":"BBB","current":true,"legacy":false},{"name":"old","public":"CCC","current":false}]"#
        let keys = try JSONDecoder().decode([Keypair].self, from: Data(rows.utf8))
        XCTAssertEqual(keys, [Keypair(name: "default", public: "AAA", current: false, legacy: true),
                              Keypair(name: "main", public: "BBB", current: true),
                              Keypair(name: "old", public: "CCC", current: false)])
    }

    func testRetire() async throws {
        let (cli, log) = try fakeCLI(#"echo '[{"name":"main","public":"BBB","current":true,"legacy":false}]'"#)
        let keys = try await cli.retireKey(named: "default")
        XCTAssertEqual(keys.map(\.name), ["main"])
        XCTAssertEqual(calls(log), ["keys --json retire default"])
        do {
            _ = try await cli.retireKey(named: "../x")
            XCTFail("invalid names never reach the CLI")
        } catch {}
        let (quiet, quietLog) = try fakeCLI(#"case "$*" in *retire*) echo "已删除";; *) echo '[]';; esac"#)
        let after = try await quiet.retireKey(named: "default")
        XCTAssertEqual(after, [])
        XCTAssertEqual(calls(quietLog), ["keys --json retire default", "keys --json"], "a plain answer is followed by a fresh list")
        let (refusing, _) = try fakeCLI("echo '当前密钥无法删除' >&2; exit 1")
        do {
            _ = try await refusing.retireKey(named: "main")
            XCTFail("refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, "当前密钥无法删除")
        }
    }

    func testSystemStatus() async throws {
        let (cli, log) = try fakeCLI(#"echo '{"installed":true,"running":true,"proxyPort":8080,"runtimeVersion":"r","ownerUid":501,"publicDir":"/p"}'"#)
        guard case .status(let s) = await cli.systemStatus() else { return XCTFail() }
        XCTAssertEqual(s.proxyPort, 8080)
        XCTAssertEqual(calls(log), ["system status --json"])
        let (old, _) = try fakeCLI("echo \"secret-gate: error: argument cmd: invalid choice: 'system'\" >&2; exit 2")
        let unsupported = await old.systemStatus()
        XCTAssertEqual(unsupported, .unsupported)
        let missing = GateCLI(executable: URL(fileURLWithPath: "/nonexistent/secret-gate"), environment: [:])
        guard case .failed = await missing.systemStatus() else { return XCTFail() }
    }

    func testTailLog() async throws {
        let (cli, log) = try fakeCLI(#"printf 'line 1\nline 2\n'"#)
        let text = try await cli.tailLog(.rpc, lines: 9999)
        XCTAssertEqual(text, "line 1\nline 2\n")
        XCTAssertEqual(calls(log), ["logs tail --name rpc --lines 500"], "at most 500 lines")
        let (json, _) = try fakeCLI(#"printf '%s\n' '{"text":"a\nb"}'"#)
        let fromJSON = try await json.tailLog(.proxy)
        XCTAssertEqual(fromJSON, "a\nb")
    }
}

final class GateCATrustTests: XCTestCase {
    /// A throw-away self-signed certificate (CN=agentswitch-test), SHA-1 40:F9:65:…:8B.
    static let pem = """
    -----BEGIN CERTIFICATE-----
    MIIBjDCCATGgAwIBAgIUUCSm0NGK1bHoM57fVRhFMS6TAFEwCgYIKoZIzj0EAwIw
    GzEZMBcGA1UEAwwQYWdlbnRzd2l0Y2gtdGVzdDAeFw0yNjA5MjcwNjMwNDhaFw0z
    NjA5MjQwNjMwNDhaMBsxGTAXBgNVBAMMEGFnZW50c3dpdGNoLXRlc3QwWTATBgcq
    hkjOPQIBBggqhkjOPQMBBwNCAAQ8yC8rLOLvYd6ESVDmIvMmnLxYyixJ3818mfq4
    VY+tr1W0/WBFLlb/5UNQU7Ve5ipIw6EuU2ovuTp90+pWhq5So1MwUTAdBgNVHQ4E
    FgQU11X3qvnVbTp78wF3iPZ1yv6BJ9MwHwYDVR0jBBgwFoAU11X3qvnVbTp78wF3
    iPZ1yv6BJ9MwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAwxtF
    N/XnZoYHckli3JRbJqkGQ5P7YqwDrcQ7FBI23jcCIQCCh3M8Q/+ZSZ/y/ItQnAwc
    cxgOwmshD0PPsNZx7iYQNA==
    -----END CERTIFICATE-----

    """

    func testUntrustCommands() throws {
        let dir = TestSupport.tempDir("ca")
        defer { try? FileManager.default.removeItem(at: dir) }
        let pem = dir.appendingPathComponent("old.pem")
        try GateCATrustTests.pem.write(to: pem, atomically: true, encoding: .utf8)
        let commands = GateCA.untrustCommands(pem: pem, userHome: URL(fileURLWithPath: "/Users/u"))
        XCTAssertEqual(commands.map(\.0.path), ["/usr/bin/security", "/usr/bin/security"])
        XCTAssertEqual(commands.map(\.1), [
            ["remove-trusted-cert", pem.path],
            ["delete-certificate", "-Z", "40F9652A0492F701C7D71064E392FA16690A058B", "/Users/u/Library/Keychains/login.keychain-db"],
        ])
        XCTAssertTrue(GateCA.untrustCommands(pem: dir.appendingPathComponent("absent.pem"), userHome: dir).isEmpty)

        let copy = dir.appendingPathComponent("copy.pem")
        try GateCATrustTests.pem.replacingOccurrences(of: "\n", with: "\r\n").write(to: copy, atomically: true, encoding: .utf8)
        XCTAssertTrue(GateCA.sameCertificate(pem, copy))
        XCTAssertFalse(GateCA.sameCertificate(pem, dir.appendingPathComponent("absent.pem")))
    }

    func testRememberOnlyATrustedCertificate() throws {
        let dir = TestSupport.tempDir("ca")
        defer { try? FileManager.default.removeItem(at: dir) }
        let pem = dir.appendingPathComponent("ca.pem")
        try GateCATrustTests.pem.write(to: pem, atomically: true, encoding: .utf8)
        let target = dir.appendingPathComponent("home/gate-previous-ca.pem")
        // Nobody trusts this test certificate: nothing is written.
        XCTAssertNil(try GateCA.rememberTrusted(candidates: [pem, dir.appendingPathComponent("absent.pem")], into: target))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
}
