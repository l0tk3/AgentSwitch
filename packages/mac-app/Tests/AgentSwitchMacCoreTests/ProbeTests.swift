import XCTest
@testable import AgentSwitchMacCore

final class GateProbeTests: XCTestCase {
    func testRequestIsByteForByteTheBootstrapProbe() {
        // secret_gate/proxy_probe.py probe_request()
        let expected = "GET http://127.0.0.1:9/secret-gate-probe HTTP/1.1\r\n"
            + "Host: 127.0.0.1:9\r\n"
            + "X-Secret-Gate-Probe: enc:v1:AAAAAAAAAAAAAAAAAAAAAAAA\r\n"
            + "Connection: close\r\n\r\n"
        XCTAssertEqual(String(decoding: GateProbe.request(), as: UTF8.self), expected)
    }

    func testClassification() {
        func verdict(_ raw: String) -> GateProbe.Verdict { GateProbe.classify(Data(raw.utf8)).verdict }
        XCTAssertEqual(verdict("HTTP/1.1 403 Forbidden\r\nX-Secret-Gate: denied\r\ncontent-length: 0\r\n\r\n"), .gate)
        XCTAssertEqual(verdict("HTTP/1.1 403 Forbidden\r\nx-secret-gate: DENIED\r\n\r\n"), .gate)
        XCTAssertEqual(verdict("HTTP/1.1 502 Bad Gateway\r\nServer: mitmproxy 12.2.3\r\n\r\n"), .mitmproxy)
        XCTAssertEqual(verdict("HTTP/1.1 403 Forbidden\r\nServer: nginx\r\n\r\n"), .otherHTTP)
        XCTAssertEqual(verdict("HTTP/1.0 200 OK\r\n\r\n"), .otherHTTP)
        XCTAssertEqual(verdict("SSH-2.0-OpenSSH_9.6\r\n"), .notHTTP)
        XCTAssertEqual(verdict(""), .notHTTP)
    }

    func testLiveProbeAgainstCannedListeners() {
        let gate = CannedServer(response: "HTTP/1.1 403 Forbidden\r\nX-Secret-Gate: denied\r\nContent-Length: 0\r\n\r\n")
        defer { gate.stop() }
        let result = GateProbe.probe(port: gate.port)
        XCTAssertTrue(result.isGate, result.detail)
        XCTAssertEqual(gate.requests.first, GateProbe.request())

        let web = CannedServer(response: "HTTP/1.1 200 OK\r\nServer: SimpleHTTP\r\nContent-Length: 2\r\n\r\nok")
        defer { web.stop() }
        let other = GateProbe.probe(port: web.port)
        XCTAssertEqual(other.verdict, .otherHTTP)
        XCTAssertTrue(other.detail.contains("SimpleHTTP"))
    }

    func testUnreachableAndPortProbe() {
        let port = TestSupport.freePort()
        XCTAssertEqual(GateProbe.probe(port: port, timeout: 0.5).verdict, .unreachable)
        XCTAssertFalse(PortProbe.isListening(port: port))
        let server = CannedServer(response: "HTTP/1.1 200 OK\r\n\r\n")
        defer { server.stop() }
        XCTAssertTrue(PortProbe.isListening(port: server.port))
    }

    func testGateDecision() {
        XCTAssertNil(RuntimePlan.gateDecision(port: 8080, probe: nil))
        XCTAssertNil(RuntimePlan.gateDecision(port: 8080, probe: .init(verdict: .unreachable, detail: "")))
        guard case .adopt = RuntimePlan.gateDecision(port: 8080, probe: .init(verdict: .gate, detail: "")) else { return XCTFail() }
        guard case .fail(let why) = RuntimePlan.gateDecision(port: 8080, probe: .init(verdict: .mitmproxy, detail: "bare")) else { return XCTFail() }
        XCTAssertTrue(why.contains("8080") && why.contains("bare"))
    }
}

/// The probe against a real `secret-gate proxy` from the dev venv, in a throw-away gate home.
final class GateProbeIntegrationTests: XCTestCase {
    func testRealGatePassesTheProbe() async throws {
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: TestSupport.devGate.path), "dev secret-gate venv not present")
        let home = TestSupport.tempDir("gatehome")
        defer { try? FileManager.default.removeItem(at: home) }
        // SECRET_GATE_PUBLIC: an empty directory, so a gate service installed on this Mac does not turn the CLI into its client.
        let env = ["HOME": NSHomeDirectory(), "SECRET_GATE_HOME": home.path, "SECRET_GATE_PUBLIC": home.appendingPathComponent("public").path,
                   "PATH": "/usr/bin:/bin"]
        let cli = GateCLI(executable: TestSupport.devGate, environment: env)
        let first = try await cli.ensureKeypair()
        XCTAssertTrue(first.created)
        XCTAssertEqual(first.keys.map(\.name), ["default"])
        XCTAssertTrue(first.keys[0].current)
        let second = try await cli.ensureKeypair()
        XCTAssertFalse(second.created)

        let port = TestSupport.freePort()
        let proc = Process()
        proc.executableURL = TestSupport.devGate
        proc.arguments = ["proxy", "--port", String(port)]
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        let up = await TestSupport.waitUntil(timeout: 20) { PortProbe.isListening(port: port) }
        let result = GateProbe.probe(port: port)
        await TestSupport.stop(proc)
        try XCTSkipUnless(up, "gate proxy did not come up")
        XCTAssertEqual(result.verdict, .gate, result.detail)
    }
}
