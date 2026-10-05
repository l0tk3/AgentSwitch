import XCTest
@testable import AgentSwitchMacCore

final class DaemonModelsTests: XCTestCase {
    private let payload = PairingPayload(name: "Mac", port: 4713, fp: String(repeating: "ab", count: 32), code: "ABCD-EF12",
                                         lan: ["192.168.1.5"], tailnet: ["100.101.102.103", "mac.tail1234.ts.net"],
                                         bonjour: "AgentSwitch on Mac", gate: .init(publicKey: "pk", keypair: "default"))

    func testPairingWithMillisecondsAndPayload() throws {
        let link = try PairingLink.make(payload)
        let json = """
        {"code":"ABCD-EF12","expiresAt":1790000000000,"link":"\(link)","payload":\(String(decoding: try JSONEncoder().encode(payload), as: UTF8.self))}
        """
        let p = try JSONDecoder().decode(Pairing.self, from: Data(json.utf8))
        XCTAssertEqual(p.expiresAt, Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertEqual(p.payload, payload)
    }

    func testPairingWithIsoDateFallsBackToTheLink() throws {
        let link = try PairingLink.make(payload)
        let json = #"{"code":"X","expires_at":"2026-09-24T10:00:00.500Z","link":"\#(link)"}"#
        let p = try JSONDecoder().decode(Pairing.self, from: Data(json.utf8))
        XCTAssertEqual(p.expiresAt.timeIntervalSince1970, 1_790_244_000.5, accuracy: 0.001)
        XCTAssertEqual(p.payload?.fp, payload.fp)
    }

    func testDevicesInBothShapes() throws {
        let camel = #"[{"id":"d1","name":"iPhone","platform":"ios","createdAt":1790000000000,"lastSeenAt":null,"revokedAt":null}]"#
        let snake = #"{"devices":[{"id":"d2","name":"Pad","platform":"ipados","created_at":"2026-09-24T10:00:00Z","revoked_at":1790000000}]}"#
        let a = try Device.decodeList(Data(camel.utf8))
        XCTAssertEqual(a.map(\.id), ["d1"])
        XCTAssertFalse(a[0].isRevoked)
        XCTAssertNil(a[0].lastSeenAt)
        let b = try Device.decodeList(Data(snake.utf8))
        XCTAssertTrue(b[0].isRevoked)
        XCTAssertEqual(b[0].revokedAt, Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertNotNil(b[0].createdAt)
    }

    func testRemoteInfo() throws {
        let json = #"{"port":4713,"fingerprint":"ff","lan":["10.0.0.2"],"tailnet":[],"bonjour":"AgentSwitch on M","onlineDevices":2}"#
        let info = try JSONDecoder().decode(RemoteInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.port, 4713)
        XCTAssertEqual(info.onlineDevices, 2)
        XCTAssertTrue(info.enabled)
        let listOnline = try JSONDecoder().decode(RemoteInfo.self, from: Data(#"{"fp":"aa","online":["a","b","c"]}"#.utf8))
        XCTAssertEqual(listOnline.onlineDevices, 3)
        XCTAssertEqual(listOnline.fingerprint, "aa")
    }

    func testModelSettingsShapes() throws {
        let json = """
        {"router":{"model":"deepseek/deepseek-flash","options":["deepseek/deepseek-flash","claude-haiku"]},
         "default":{"harness":"codex","model":"gpt-5.5"},
         "harnesses":{"codex":{"models":["gpt-6-astra","gpt-5.5"],"default_model":"gpt-6-astra"},
                      "claude-code":{"models":{"claude-sonnet-5":{"cost":"mid"},"claude-opus-5":{}},"defaultModel":"claude-sonnet-5"},
                      "opencode":{"models":[{"id":"deepseek/deepseek-flash"}]}},
         "restartRequired":true}
        """
        let m = try JSONDecoder().decode(ModelSettings.self, from: Data(json.utf8))
        XCTAssertEqual(m.router.options, ["deepseek/deepseek-flash", "claude-haiku"])
        XCTAssertEqual(m.defaultTarget.harness, "codex")
        XCTAssertEqual(m.harnessNames, ["claude-code", "codex", "opencode"])
        XCTAssertEqual(m.models(for: "claude-code"), ["claude-opus-5", "claude-sonnet-5"])
        XCTAssertEqual(m.harnesses["claude-code"]?.defaultModel, "claude-sonnet-5")
        XCTAssertEqual(m.models(for: "opencode"), ["deepseek/deepseek-flash"])
        XCTAssertEqual(m.models(for: nil), [])
        XCTAssertTrue(m.restartPending)
    }

    func testUpdateCarriesOnlyChanges() throws {
        let current = ModelSettings(router: .init(model: "r1", options: ["r1", "r2"]), defaultTarget: .init(harness: "codex", model: "a"), harnesses: [:])
        XCTAssertTrue(ModelSettingsUpdate.diff(current: current, routerModel: "r1", defaultHarness: "codex", defaultModel: "a").isEmpty)
        let routerOnly = ModelSettingsUpdate.diff(current: current, routerModel: "r2", defaultHarness: "codex", defaultModel: "a")
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(routerOnly), as: UTF8.self), #"{"router":{"model":"r2"}}"#)
        let target = ModelSettingsUpdate.diff(current: current, routerModel: nil, defaultHarness: "claude-code", defaultModel: "s")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        XCTAssertEqual(String(decoding: try encoder.encode(target), as: UTF8.self), #"{"default":{"harness":"claude-code","model":"s"}}"#)
    }

    func testErrorMessageExtraction() {
        XCTAssertEqual(DaemonClient.errorMessage(Data(#"{"error":"bad model"}"#.utf8)), "bad model")
        XCTAssertEqual(DaemonClient.errorMessage(Data(#"{"error":[{"path":"x"}]}"#.utf8)), #"[{"path":"x"}]"#)
        XCTAssertEqual(DaemonClient.errorMessage(Data()), "（无内容）")
    }
}

/// Records requests and answers from a table.
final class StubTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [URLRequest] = []
    private let answer: @Sendable (URLRequest) -> (Int, String)

    init(_ answer: @escaping @Sendable (URLRequest) -> (Int, String)) { self.answer = answer }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return log }

    private func record(_ request: URLRequest) { lock.lock(); log.append(request); lock.unlock() }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        record(request)
        let (status, body) = answer(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

/// As StubTransport, with response headers.
final class HeaderTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [URLRequest] = []
    private let answer: @Sendable (URLRequest) -> (Int, String, [String: String])

    init(_ answer: @escaping @Sendable (URLRequest) -> (Int, String, [String: String])) { self.answer = answer }

    var requests: [URLRequest] { lock.withLock { log } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { log.append(request) }
        let (status, body, headers) = answer(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!)
    }
}

final class DaemonClientTests: XCTestCase {
    func testTheLocalTokenGoesWithEveryCallAndTheConsoleOpensThroughAOneTimeLink() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-token-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let tokenFile = home.appendingPathComponent(DaemonClient.tokenFileName)
        let stub = StubTransport { req in
            req.url?.path == "/local/console-link" ? (200, #"{"path":"/ui/login?code=abc"}"#) : (200, "[]")
        }
        let client = DaemonClient(port: 4811, transport: stub, tokenFile: tokenFile)
        _ = try await client.devices()
        XCTAssertNil(stub.requests[0].value(forHTTPHeaderField: "Authorization"), "no token yet: the daemon writes it on its first start")
        try "tok-123\n".write(to: tokenFile, atomically: true, encoding: .utf8)
        _ = try await client.devices()
        XCTAssertEqual(stub.requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer tok-123")
        let link = try await client.consoleLink()
        XCTAssertEqual(link.absoluteString, "http://127.0.0.1:4811/ui/login?code=abc")
        XCTAssertEqual(stub.requests[2].httpMethod, "POST")
        _ = try await client.consoleLink(next: "/ui/terminal.html")
        XCTAssertEqual(stub.requests[3].url?.query, "next=%2Fui%2Fterminal%2Ehtml")
    }

    func testRoutesMethodsAndBodies() async throws {
        let stub = StubTransport { req in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("GET", "/devices"): return (200, "[]")
            case ("DELETE", "/devices/a b"): return (200, #"{"ok":true}"#)
            case ("PUT", "/settings/models"): return (200, #"{"restartRequired":true}"#)
            case ("GET", "/healthz"): return (200, #"{"ok":true,"version":"0.1.0"}"#)
            default: return (500, #"{"error":"unexpected"}"#)
            }
        }
        let client = DaemonClient(port: 4811, transport: stub)
        let listed = try await client.devices()
        XCTAssertEqual(listed, [])
        try await client.revokeDevice(id: "a b")
        let saved = try await client.saveModelSettings(ModelSettingsUpdate(routerModel: "x", defaultHarness: nil, defaultModel: nil))
        XCTAssertTrue(saved.restartRequired)
        let health = try await client.health()
        XCTAssertEqual(health.version, "0.1.0")
        let urls = stub.requests.map { $0.url!.absoluteString }
        XCTAssertEqual(urls[0], "http://127.0.0.1:4811/devices")
        XCTAssertEqual(urls[1], "http://127.0.0.1:4811/devices/a%20b")
        XCTAssertEqual(stub.requests[2].value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(stub.requests[2].httpBody.map { String(decoding: $0, as: UTF8.self) }, #"{"router":{"model":"x"}}"#)
    }

    func testErrorsAreTyped() async {
        let stub = StubTransport { req in
            switch req.url?.path ?? "" {
            case "/pairing": return (404, "404 Not Found")
            case "/devices/gone": return (404, #"{"error":"not found"}"#)
            default: return (400, #"{"error":"unknown harness"}"#)
            }
        }
        let client = DaemonClient(port: 1, transport: stub)
        do { _ = try await client.createPairing(); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .notSupported("POST /pairing"))
        }
        do { try await client.revokeDevice(id: "gone"); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 404, message: "not found"))
        }
        do { _ = try await client.modelSettings(); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 400, message: "unknown harness"))
        }
    }

    /// The app asks for a client each time it needs one (AppModel.client): they share one session, so requests one
    /// after another go over one connection instead of a new session and a new connection each.
    func testClientsMadeOneAfterAnotherShareOneConnection() async throws {
        let server = KeepAliveServer(body: #"{"ok":true}"#)
        defer { server.stop() }
        for _ in 0..<4 {
            let data = try await DaemonClient(port: server.port).call("GET", "/anything")
            XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"ok":true}"#)
        }
        XCTAssertEqual(server.requests, 4)
        XCTAssertEqual(server.connections, 1)
    }

    /// The Terminals page reads the earlier sessions every twenty seconds or so: with the version of the list it has,
    /// an unchanged list comes back as nothing (304) and is not decoded or compared again.
    func testTheEarlierSessionsAreNotReadAgainWhileUnchanged() async throws {
        let list = #"{"sessions":[{"harness":"codex","id":"x1","cwd":"/w","title":"t","lastText":"","updatedAt":2,"active":false}]}"#
        let transport = HeaderTransport { request in
            request.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"" ? (304, "", [:]) : (200, list, ["Etag": "\"v1\""])
        }
        let client = DaemonClient(port: 1, transport: transport)
        let first = try await client.sessions()
        XCTAssertEqual(first?.value.map(\.sessionId), ["x1"])
        XCTAssertEqual(first?.version, "\"v1\"")
        XCTAssertNil(transport.requests[0].value(forHTTPHeaderField: "If-None-Match"))
        let again = try await client.sessions(unless: first?.version)
        XCTAssertNil(again)
        XCTAssertEqual(transport.requests[1].value(forHTTPHeaderField: "If-None-Match"), "\"v1\"")
        // Its own answers are not to be taken from a cache in between.
        XCTAssertEqual(transport.requests[1].cachePolicy, .reloadIgnoringLocalCacheData)
        // A service that names no version (an older one): the whole list each time, as before.
        let old = DaemonClient(port: 1, transport: HeaderTransport { _ in (200, list, [:]) })
        let plain = try await old.sessions(unless: "\"v1\"")
        XCTAssertEqual(plain?.value.count, 1)
        XCTAssertNil(plain?.version)
    }

    func testUnreachableDaemon() async {
        let client = DaemonClient(port: TestSupport.freePort(), transport: URLSessionTransport(timeout: 1))
        do { _ = try await client.health(); XCTFail() } catch {
            guard case .unreachable = error as? DaemonError else { return XCTFail("\(error)") }
        }
    }
}

/// The client against scripts/fake-daemon.mjs over real HTTP (skipped without node).
final class FakeDaemonIntegrationTests: XCTestCase {
    func testPairingDevicesModelsRoundTrip() async throws {
        let node = try XCTUnwrap(TestSupport.findNode(), "node not found")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [TestSupport.packageRoot.appendingPathComponent("scripts/fake-daemon.mjs").path, "--port", "0", "--remote-port", "4913"]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        defer { proc.terminate() }
        let lines = Collector()
        out.fileHandleForReading.readabilityHandler = { Collector.pump($0, into: lines) }
        let started = await TestSupport.waitUntil(timeout: 10) { lines.data.contains(UInt8(ascii: "\n")) }
        out.fileHandleForReading.readabilityHandler = nil
        try XCTSkipUnless(started, "fake daemon did not start")
        let port = try XCTUnwrap((try JSONSerialization.jsonObject(with: lines.data) as? [String: Int])?["port"])
        let client = DaemonClient(port: port)

        let health = try await client.health()
        XCTAssertTrue(health.ok)
        let pairing = try await client.createPairing()
        XCTAssertEqual(pairing.code.count, 9)
        XCTAssertGreaterThan(pairing.expiresAt.timeIntervalSinceNow, 250)
        XCTAssertEqual(pairing.payload?.port, 4913)
        XCTAssertEqual(try PairingLink.parse(pairing.link), pairing.payload)

        var fakePair = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/__fake/pair")!)
        fakePair.httpMethod = "POST"
        fakePair.httpBody = Data(#"{"name":"测试 iPhone","platform":"ios"}"#.utf8)
        _ = try await URLSession.shared.data(for: fakePair)
        let devices = try await client.devices()
        XCTAssertEqual(devices.map(\.name), ["测试 iPhone"])
        try await client.revokeDevice(id: devices[0].id)
        let afterRevoke = try await client.devices()
        XCTAssertTrue(afterRevoke[0].isRevoked)

        let info = try await client.remoteInfo()
        XCTAssertEqual(info.port, 4913)
        XCTAssertNotNil(BonjourRecord.fingerprintPrefix(info.fingerprint ?? ""))

        let models = try await client.modelSettings()
        XCTAssertTrue(models.harnessNames.contains("codex"))
        let saved = try await client.saveModelSettings(ModelSettingsUpdate(routerModel: nil, defaultHarness: "codex", defaultModel: "gpt-5.5"))
        XCTAssertTrue(saved.restartRequired)
        let reread = try await client.modelSettings()
        XCTAssertEqual(reread.defaultTarget.model, "gpt-5.5")
        do {
            _ = try await client.saveModelSettings(ModelSettingsUpdate(routerModel: nil, defaultHarness: "codex", defaultModel: "nope"))
            XCTFail()
        } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 400, message: "unknown harness/model"))
        }
    }
}

/// A loopback server that keeps each connection open and answers every request on it, counting both.
final class KeepAliveServer: @unchecked Sendable {
    let port: Int
    private let fd: Int32
    private let response: Data
    private let lock = NSLock()
    private var accepted = 0
    private var answered = 0

    init(body: String) {
        response = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: keep-alive\r\n\r\n\(body)".utf8)
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        var one: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        listen(sock, 8)
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) } }
        fd = sock
        port = Int(UInt16(bigEndian: addr.sin_port))
        Thread { [self] in accepting() }.start()
    }

    var connections: Int { lock.withLock { accepted } }
    var requests: Int { lock.withLock { answered } }

    private func accepting() {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { return }
            lock.withLock { accepted += 1 }
            Thread { [self] in serve(client) }.start()
        }
    }

    private func serve(_ client: Int32) {
        while !LoopbackSocket.readHead(client, limit: 8192, timeout: 5).isEmpty {
            lock.withLock { answered += 1 }
            if !LoopbackSocket.sendAll(client, response) { break }
        }
        close(client)
    }

    func stop() {
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }
}
