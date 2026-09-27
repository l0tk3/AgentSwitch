import Darwin
import SQLite3
import XCTest
@testable import AgentSwitchMacCore

final class PairingLinkTests: XCTestCase {
    private let payload = PairingPayload(name: "小明的 Mac", port: 4713, fp: String(repeating: "0f", count: 32), code: "ABCD-EF12",
                                         lan: ["192.168.1.5"], tailnet: [], bonjour: "AgentSwitch on 小明的 Mac",
                                         gate: .init(publicKey: "abc_-", keypair: "default"))

    func testRoundTripAndErrors() throws {
        let link = try PairingLink.make(payload)
        XCTAssertTrue(link.hasPrefix("agentswitch://pair?p="))
        XCTAssertFalse(link.contains("=") && link.hasSuffix("="), "no padding")
        XCTAssertEqual(try PairingLink.parse(link), payload)
        XCTAssertThrowsError(try PairingLink.parse("https://pair?p=x"))
        XCTAssertThrowsError(try PairingLink.parse("agentswitch://pair?p=%%%"))
    }

    func testBase64URL() {
        let data = Data([0xfb, 0xff, 0xfe, 0x00])
        XCTAssertEqual(Base64URL.encode(data), "-__-AA")
        XCTAssertEqual(Base64URL.decode("-__-AA"), data)
    }

    func testDisplayCodeAndCountdown() {
        XCTAssertEqual(PairingLink.displayCode("abcd1234"), "ABCD-1234")
        XCTAssertEqual(PairingLink.displayCode("ABCD-1234"), "ABCD-1234")
        XCTAssertEqual(PairingLink.displayCode("short"), "short")
        let now = Date()
        XCTAssertEqual(Countdown.format(Countdown.remaining(until: now.addingTimeInterval(299.2), now: now)), "5:00")
        XCTAssertEqual(Countdown.format(59), "0:59")
        XCTAssertEqual(Countdown.format(-3), "0:00")
    }

    func testQRCodeDecodesBackToTheLink() throws {
        let link = try PairingLink.make(payload)
        let image = try XCTUnwrap(QRCodeRenderer.image(for: link))
        XCTAssertGreaterThan(image.width, 200)
        XCTAssertEqual(image.width, image.height)
        XCTAssertEqual(QRCodeRenderer.decode(image), link)
    }
}

final class HarnessTests: XCTestCase {
    func testVersionParsing() {
        XCTAssertEqual(HarnessEvaluator.parseVersion("2.1.278 (Claude Code)\n"), "2.1.278")
        XCTAssertEqual(HarnessEvaluator.parseVersion("codex-cli 0.155.0"), "0.155.0")
        XCTAssertEqual(HarnessEvaluator.parseVersion("2.0.8"), "2.0.8")
        XCTAssertEqual(HarnessEvaluator.parseVersion("opencode 1.0.0-beta.3"), "1.0.0-beta.3")
        XCTAssertNil(HarnessEvaluator.parseVersion("command not found"))
    }

    func testEvaluation() {
        let missing = HarnessEvaluator.evaluate(.init(harness: .codex, binary: nil, versionOutput: nil, loginEvidence: nil))
        XCTAssertEqual(missing.state, .missing)
        XCTAssertTrue(missing.guidance.joined().contains("brew install codex"))
        let noLogin = HarnessEvaluator.evaluate(.init(harness: .claude, binary: "/x/claude", versionOutput: "2.1.0", loginEvidence: nil))
        XCTAssertEqual(noLogin.state, .notLoggedIn)
        XCTAssertEqual(noLogin.version, "2.1.0")
        let ready = HarnessEvaluator.evaluate(.init(harness: .opencode, binary: "/x/opencode", versionOutput: "2.0.8", loginEvidence: "auth.json"))
        XCTAssertEqual(ready.state, .ready)
        XCTAssertEqual(ready.guidance, [])
    }

    func testLookupOrder() throws {
        let a = TestSupport.tempDir("a"), b = TestSupport.tempDir("b")
        for dir in [a, b] {
            let tool = dir.appendingPathComponent("tool")
            try "#!/bin/sh\n".write(to: tool, atomically: true, encoding: .utf8)
            chmod(tool.path, 0o755)
        }
        try "not executable".write(to: a.appendingPathComponent("plain"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ExecutableLookup.find("tool", path: "\(b.path):\(a.path)"), b.appendingPathComponent("tool").path)
        XCTAssertNil(ExecutableLookup.find("plain", path: a.path))
        XCTAssertEqual(ExecutableLookup.find("tool", path: "/nonexistent", extra: [a.appendingPathComponent("tool").path]),
                       a.appendingPathComponent("tool").path)
    }

    func testDetectorFindsVersionAndLoginEvidence() async throws {
        let home = TestSupport.tempDir("home")
        let bin = home.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let codex = bin.appendingPathComponent("codex")
        try "#!/bin/sh\necho codex-cli 0.155.0\n".write(to: codex, atomically: true, encoding: .utf8)
        chmod(codex.path, 0o755)
        let detector = HarnessDetector(path: bin.path, home: home.path, environment: [:])
        let before = await detector.detect(.codex)
        XCTAssertEqual(before.state, .notLoggedIn)
        XCTAssertEqual(before.version, "0.155.0")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".codex"), withIntermediateDirectories: true)
        try "{}".write(to: home.appendingPathComponent(".codex/auth.json"), atomically: true, encoding: .utf8)
        let after = await detector.detect(.codex)
        XCTAssertEqual(after.state, .ready)
        let opencode = await detector.detect(.opencode)
        XCTAssertEqual(opencode.state, .missing)
    }

    func testClaudeConfigAndOpenCodeCredentialRows() throws {
        let dir = TestSupport.tempDir("cred")
        let config = dir.appendingPathComponent(".claude.json")
        try #"{"numStartups":3}"#.write(to: config, atomically: true, encoding: .utf8)
        XCTAssertFalse(HarnessDetector.claudeConfigHasAccount(config))
        try #"{"oauthAccount":{"emailAddress":"x"}}"#.write(to: config, atomically: true, encoding: .utf8)
        XCTAssertTrue(HarnessDetector.claudeConfigHasAccount(config))

        let dbURL = dir.appendingPathComponent("opencode.db")
        XCTAssertNil(HarnessDetector.credentialRows(dbURL))
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(dbURL.path, &db), SQLITE_OK)
        sqlite3_exec(db, "CREATE TABLE credential (id text primary key, label text, value text); INSERT INTO credential VALUES ('1','deepseek','k');", nil, nil, nil)
        sqlite3_close(db)
        XCTAssertEqual(HarnessDetector.credentialRows(dbURL), 1)
    }
}

final class NetworkTests: XCTestCase {
    func testTailscaleStatusParsing() {
        let json = """
        {"BackendState":"Running","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::d001:ef2d"],
         "Self":{"DNSName":"mac.tail1234.ts.net.","TailscaleIPs":["100.101.102.103"]}}
        """
        let parsed = Tailscale.parse(statusJSON: Data(json.utf8))
        XCTAssertEqual(parsed.backendState, "Running")
        XCTAssertEqual(parsed.dnsName, "mac.tail1234.ts.net")
        XCTAssertEqual(parsed.ipv4, ["100.101.102.103"])
        let stopped = Tailscale.parse(statusJSON: Data(#"{"BackendState":"NeedsLogin","Self":{"DNSName":""}}"#.utf8))
        XCTAssertEqual(stopped.backendState, "NeedsLogin")
        XCTAssertNil(stopped.dnsName)
        XCTAssertNil(Tailscale.parse(statusJSON: Data("garbage".utf8)).backendState)
        XCTAssertTrue(TailscaleStatus.notInstalled.summary.contains("同一局域网"))
    }

    func testAddressClassification() {
        XCTAssertTrue(NetworkAddresses.isPrivateIPv4("10.1.2.3"))
        XCTAssertTrue(NetworkAddresses.isPrivateIPv4("172.16.0.1"))
        XCTAssertTrue(NetworkAddresses.isPrivateIPv4("172.31.255.255"))
        XCTAssertFalse(NetworkAddresses.isPrivateIPv4("172.32.0.1"))
        XCTAssertTrue(NetworkAddresses.isPrivateIPv4("192.168.31.1"))
        XCTAssertFalse(NetworkAddresses.isPrivateIPv4("100.101.102.103"))
        XCTAssertFalse(NetworkAddresses.isPrivateIPv4("8.8.8.8"))
        XCTAssertFalse(NetworkAddresses.isPrivateIPv4("192.168.1"))
        XCTAssertFalse(NetworkAddresses.isPrivateIPv4("192.168.1.256"))
        XCTAssertTrue(NetworkAddresses.isTailnetIPv4("100.64.0.1"))
        XCTAssertTrue(NetworkAddresses.isTailnetIPv4("100.127.1.1"))
        XCTAssertFalse(NetworkAddresses.isTailnetIPv4("100.128.0.1"))
        XCTAssertTrue(NetworkAddresses.lanIPv4().allSatisfy(NetworkAddresses.isPrivateIPv4))
    }

    func testBonjourRecord() {
        let fp = "AB:CD" + String(repeating: "0", count: 60)
        XCTAssertEqual(BonjourRecord.fingerprintPrefix(fp), "abcd000000000000")
        XCTAssertNil(BonjourRecord.fingerprintPrefix("xyz"))
        XCTAssertEqual(BonjourRecord.txt(fingerprint: fp)?["v"], Data("1".utf8))
        XCTAssertEqual(BonjourRecord.txt(fingerprint: fp)?["fp"], Data("abcd000000000000".utf8))
        XCTAssertEqual(BonjourRecord.serviceName(computerName: "M"), "AgentSwitch on M")
        let info = RemoteInfo(port: 4813, fingerprint: fp, lan: [], tailnet: [], bonjour: nil, onlineDevices: 0)
        let ad = BonjourRecord.advertisement(info: info, fallbackPort: 4713, computerName: "M")
        XCTAssertEqual(ad?.port, 4813)
        XCTAssertEqual(ad?.name, "AgentSwitch on M")
        XCTAssertNil(BonjourRecord.advertisement(info: nil, fallbackPort: 4713, computerName: "M"))
        XCTAssertNil(BonjourRecord.advertisement(info: RemoteInfo(port: 1, fingerprint: nil, lan: [], tailnet: [], bonjour: nil, onlineDevices: nil),
                                                 fallbackPort: 1, computerName: "M"))
    }
}

final class GateCATests: XCTestCase {
    private func makeCert(_ dir: URL, _ name: String) throws -> URL {
        let key = dir.appendingPathComponent("\(name).key"), cert = dir.appendingPathComponent("\(name).pem")
        let r = try ProcessRunner.runBlocking(URL(fileURLWithPath: "/usr/bin/openssl"),
                                              ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                                               "-keyout", key.path, "-out", cert.path, "-days", "1", "-subj", "/CN=\(name)"], timeout: 20)
        try XCTSkipUnless(r.ok, "openssl failed: \(r.stderrText)")
        return cert
    }

    func testCopyStatesAndDER() throws {
        let dir = TestSupport.tempDir("ca")
        let target = dir.appendingPathComponent("gate/ca.pem")
        XCTAssertEqual(try GateCA.ensureCopy(from: dir.appendingPathComponent("none.pem"), to: target), .sourceMissing)
        let a = try makeCert(dir, "a"), b = try makeCert(dir, "b")
        XCTAssertNotNil(GateCA.derFromPEM(try String(contentsOf: a, encoding: .utf8)))
        XCTAssertNil(GateCA.derFromPEM("not a pem"))
        XCTAssertEqual(try GateCA.ensureCopy(from: a, to: target), .copied)
        XCTAssertEqual(try GateCA.ensureCopy(from: a, to: target), .upToDate)
        XCTAssertEqual(try GateCA.ensureCopy(from: b, to: target), .replaced)
        XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), try String(contentsOf: b, encoding: .utf8))
        XCTAssertFalse(GateCA.isTrusted(target), "a fresh self-signed cert is not a trusted root")
    }

    func testTrustCommandIsTheKeychainStepOnly() {
        let (exe, args) = GateCA.trustCommand(ca: URL(fileURLWithPath: "/Users/u/.secret-gate/ca.pem"), userHome: URL(fileURLWithPath: "/Users/u"))
        XCTAssertEqual(exe.path, "/usr/bin/security")
        XCTAssertEqual(args, ["add-trusted-cert", "-r", "trustRoot", "-k", "/Users/u/Library/Keychains/login.keychain-db", "/Users/u/.secret-gate/ca.pem"])
    }

    func testKeypairNames() {
        XCTAssertTrue(GateCLI.isValidName("default"))
        XCTAssertTrue(GateCLI.isValidName("work.2026_a-b"))
        XCTAssertFalse(GateCLI.isValidName(".hidden"))
        XCTAssertFalse(GateCLI.isValidName("keys"))
        XCTAssertFalse(GateCLI.isValidName(String(repeating: "a", count: 33)))
        XCTAssertFalse(GateCLI.isValidName("有中文"))
    }
}
