import Security
import XCTest
@testable import AgentSwitchKit

final class CertificatePinTests: XCTestCase {
    /// `shasum -a 256 Fixtures/leaf.der`
    private let fixtureFingerprint = "e11d05c0e9b6cb1e3f3f2361a4ef4fe523c0a42c3e3ba4185d9ae63e19be5607"

    func testFingerprintAndMatch() throws {
        let der = try Fixture.data("leaf.der")
        XCTAssertEqual(CertificatePin.fingerprint(ofDER: der), fixtureFingerprint)
        XCTAssertTrue(CertificatePin.matches(der: der, pinned: fixtureFingerprint.uppercased()))
        let colons = stride(from: 0, to: 64, by: 2).map { i -> String in
            let s = fixtureFingerprint.index(fixtureFingerprint.startIndex, offsetBy: i)
            return String(fixtureFingerprint[s...fixtureFingerprint.index(after: s)])
        }.joined(separator: ":")
        XCTAssertTrue(CertificatePin.matches(der: der, pinned: colons))
        XCTAssertFalse(CertificatePin.matches(der: der, pinned: String(repeating: "0", count: 64)))
        XCTAssertFalse(CertificatePin.matches(der: der, pinned: "e11d05"))
        XCTAssertNil(CertificatePin.normalize("xyz"))
    }

    func testEvaluateSecTrust() throws {
        let der = try Fixture.data("leaf.der")
        let cert = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        let t = try XCTUnwrap(trust)
        XCTAssertEqual(CertificatePin.evaluate(trust: t, pinned: fixtureFingerprint), .accept)
        XCTAssertEqual(CertificatePin.evaluate(trust: t, pinned: String(repeating: "a", count: 64)), .reject(seen: fixtureFingerprint))
    }
}

#if os(macOS)
/// Real TLS: a throw-away HTTPS server on 127.0.0.1 (Python's ssl module, a fresh self-signed EC P-256 certificate like
/// the daemon's) and the real URLSession transport. Skipped when openssl or python3 is missing.
final class PinnedTransportTLSTests: XCTestCase {
    private var server: Process?
    private var dir: URL?

    override func tearDown() {
        server?.terminate()
        server?.waitUntilExit()
        if let dir { try? FileManager.default.removeItem(at: dir) }
        super.tearDown()
    }

    private static let serverScript = #"""
    import http.server, ssl, sys
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/healthz":
                code, body = 200, b'{"ok":true}'
            elif self.path == "/me":
                ok = self.headers.get("Authorization") == "Bearer good"
                code, body = (200, b'{"deviceId":"d1"}') if ok else (401, b'{"error":"unauthorized"}')
            else:
                code, body = 404, b'{"error":"not found"}'
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(sys.argv[1], sys.argv[2])
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    open(sys.argv[3], "w").write(str(srv.server_address[1]))
    srv.serve_forever()
    """#

    /// Starts the server; returns its endpoint and the certificate fingerprint.
    private func startServer() throws -> (APIEndpoint, String) {
        let openssl = "/usr/bin/openssl", python = "/usr/bin/python3"
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: openssl) && FileManager.default.isExecutableFile(atPath: python), "needs openssl and python3")
        let dir = try Proc.temporaryDirectory("as-tls")
        self.dir = dir
        let key = dir.appendingPathComponent("key.pem").path, cert = dir.appendingPathComponent("cert.pem").path
        let der = dir.appendingPathComponent("cert.der").path, portFile = dir.appendingPathComponent("port").path
        try Proc.run(openssl, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key])
        try Proc.run(openssl, ["req", "-new", "-x509", "-key", key, "-subj", "/CN=AgentSwitch", "-days", "1", "-sha256", "-out", cert])
        try Proc.run(openssl, ["x509", "-in", cert, "-outform", "DER", "-out", der])
        let fp = CertificatePin.fingerprint(ofDER: try Data(contentsOf: URL(fileURLWithPath: der)))

        let script = dir.appendingPathComponent("server.py")
        try Self.serverScript.write(to: script, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = [script.path, cert, key, portFile]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        server = p
        for _ in 0..<100 {
            if let text = try? String(contentsOfFile: portFile, encoding: .utf8), let port = Int(text) {
                return (APIEndpoint(host: "127.0.0.1", port: port, kind: .lan), fp)
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        throw XCTSkip("test server did not start")
    }

    func testPinnedFingerprintIsAccepted() async throws {
        let (endpoint, fp) = try startServer()
        let transport = PinnedSessionTransport(fingerprint: fp)
        let prober = HTTPEndpointProber(transport: transport)
        let ok = await prober.probe(endpoint, token: "good")
        XCTAssertEqual(ok, .ok)
        let revoked = await prober.probe(endpoint, token: "bad")
        XCTAssertEqual(revoked, .unauthorized)
        let health = try await AgentSwitchAPI(endpoints: FixedEndpoint(endpoint), transport: transport, token: nil).health()
        XCTAssertTrue(health.ok)
    }

    func testAnyOtherCertificateIsRejected() async throws {
        let (endpoint, fp) = try startServer()
        let wrong = String(fp.reversed())
        let transport = PinnedSessionTransport(fingerprint: wrong)
        let outcome = await HTTPEndpointProber(transport: transport).probe(endpoint, token: "good")
        XCTAssertEqual(outcome, .pinMismatch(seen: fp))
        do {
            _ = try await AgentSwitchAPI(endpoints: FixedEndpoint(endpoint), transport: transport, token: "good").me()
            XCTFail("a mismatched certificate must never be used")
        } catch {
            XCTAssertEqual(error as? APIError, .pinMismatch(seen: fp))
        }
    }
}
#endif
