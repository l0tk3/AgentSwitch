import XCTest
@testable import AgentSwitchKit

/// control-v0 §5: finding the Mac again without the user doing anything — the foreground check, retries without a
/// cap, half-open event streams — and saying how it goes (the tiers, 排障).
final class ConnectionRecoveryTests: XCTestCase {
    private let book = PairingPayload.sample()
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)
    private let fastRetry = ReconnectPolicy(initial: .milliseconds(50), maximum: .milliseconds(80))

    // MARK: - tiers

    func testTiersFromConnectingToLost() {
        let start = Date(timeIntervalSince1970: 0)
        var progress = ConnectionProgress()
        XCTAssertEqual(progress.phase(.selecting, now: start), .connecting)
        progress = progress.after(.connected(lan), at: start)
        XCTAssertEqual(progress.phase(.connected(lan)), .connected(lan))
        XCTAssertEqual(progress.phase(.idle, now: start), .reconnecting, "connected before: the way back")
        XCTAssertEqual(progress.phase(.selecting, now: start), .reconnecting)
        progress = progress.after(.unreachable, at: start.addingTimeInterval(10))
        XCTAssertEqual(progress.phase(.unreachable, now: start.addingTimeInterval(11)), .failing(attempt: 1))
        progress = progress.after(.selecting, at: start.addingTimeInterval(12)).after(.unreachable, at: start.addingTimeInterval(20))
        XCTAssertEqual(progress.phase(.selecting, now: start.addingTimeInterval(21)), .failing(attempt: 2), "a retry keeps the count")
        XCTAssertEqual(progress.phase(.unreachable, now: start.addingTimeInterval(10 + ConnectionProgress.lostAfter)), .lost)
        XCTAssertEqual(progress.phase(.unauthorized), .unpaired)
        XCTAssertEqual(progress.phase(.pinMismatch(seen: nil)), .certificateChanged)
        progress = progress.after(.connected(lan))
        XCTAssertEqual(progress.failures, 0)
        XCTAssertNil(progress.failingSince)
        XCTAssertEqual(progress.phase(.idle), .reconnecting)
        XCTAssertEqual([ConnectionPhase.connecting, .reconnecting, .failing(attempt: 3), .lost, .unpaired].map(\.text),
                       ["连接中", "重连中", "无法连接（第 3 次）", "未找到 Mac", "配对已失效"])
        XCTAssertEqual(ConnectionPhase.connected(lan).text, "已连接（局域网）")
        XCTAssertTrue(ConnectionPhase.lost.canRetry)
        XCTAssertFalse(ConnectionPhase.unpaired.canRetry)
    }

    // MARK: - 排障

    func testChecksSayWhichLineFailedAndWhy() {
        let reports = [
            ProbeReport(endpoint: lan, outcome: .unreachable("请求超时。"), seconds: 4),
            ProbeReport(endpoint: APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet), outcome: .unreachable("无法连接服务器。"), seconds: 4),
            ProbeReport(endpoint: APIEndpoint(host: "mac.tail1234.ts.net", port: 4713, kind: .tailnet), outcome: nil, seconds: 0),
        ]
        let checks = Troubleshooting.checks(state: .unreachable, reports: reports, book: book)
        XCTAssertEqual(checks.map(\.title), ["Mac", "局域网", "Tailscale"])
        XCTAssertEqual(checks.map(\.ok), [false, false, false])
        XCTAssertEqual(checks[1].detail, "无法连接：请求超时。")
        XCTAssertEqual(checks[2].detail, "无法连接：无法连接服务器。")

        let connected = Troubleshooting.checks(state: .connected(lan), reports: [ProbeReport(endpoint: lan, outcome: .ok, seconds: 0.2),
                                                                                  ProbeReport(endpoint: reports[1].endpoint, outcome: nil, seconds: 0)], book: book)
        XCTAssertEqual(connected.map(\.ok), [true, true, nil], "Tailscale was not needed")
        XCTAssertEqual(connected.map(\.detail), ["已通过局域网连接", "可用", "未使用（已通过其他线路连接）"])

        let noTailnet = ServerProfile(name: "Mac", port: 4713, fingerprint: book.fp, lan: ["192.168.1.5"], tailnet: [], bonjour: "b", gate: nil,
                                      deviceId: "d", pairedAt: Date())
        let missing = Troubleshooting.checks(state: .unreachable, reports: [reports[0]], book: noTailnet)
        XCTAssertEqual(missing[2].ok, false)
        XCTAssertTrue(missing[2].detail.contains("无 Tailscale 地址"))
        XCTAssertEqual(Troubleshooting.checks(state: .selecting, reports: nil, book: book).map(\.ok), [nil, nil, nil], "nothing tried yet")
        XCTAssertEqual(Troubleshooting.causes.count, 4)
    }

    // MARK: - manager

    func testForegroundCheckKeepsAWorkingAddress() async throws {
        let prober = FakeProber(["192.168.1.5": .ok, "100.101.102.103": .ok])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober, retry: fastRetry)
        _ = try await manager.endpoint()
        let state = await manager.verify()
        XCTAssertEqual(state, .connected(lan))
        XCTAssertEqual(prober.probed.filter { $0 == "192.168.1.5" }.count, 2, "one selection, one check")
        await manager.stop()
    }

    func testForegroundCheckReselectsWhenTheAddressIsGone() async throws {
        let prober = FakeProber(["192.168.1.5": .ok, "100.101.102.103": .ok])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober, retry: fastRetry)
        _ = try await manager.endpoint()
        prober.set("192.168.1.5", .unreachable("another Wi-Fi"))
        let state = await manager.verify()
        XCTAssertEqual(state, .connected(APIEndpoint(host: "100.101.102.103", port: 4713, kind: .tailnet)))
        await manager.stop()
    }

    func testForegroundCheckLeavesARevokedPairingAlone() async {
        let prober = FakeProber(["192.168.1.5": .unauthorized])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober, retry: fastRetry)
        _ = try? await manager.endpoint()
        let before = prober.probed.count
        let state = await manager.verify()
        XCTAssertEqual(state, .unauthorized)
        XCTAssertEqual(prober.probed.count, before, "no probe: the Mac already said no")
    }

    func testUnreachableKeepsRetryingOnItsOwnAndCallersFailFast() async throws {
        let prober = FakeProber([:])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober, retry: fastRetry)
        var states = await manager.states().makeAsyncIterator()
        _ = await states.next()   // idle
        do { _ = try await manager.endpoint(); XCTFail("nothing answers") } catch { XCTAssertEqual(error as? APIError, .unreachable) }
        let probedAfterFirst = prober.probed.count
        do { _ = try await manager.endpoint(); XCTFail("still nothing") } catch { XCTAssertEqual(error as? APIError, .unreachable) }
        XCTAssertEqual(prober.probed.count, probedAfterFirst, "a caller does not start a selection while a retry is due")

        // Several retries in a row (no cap), then the Mac comes back and is found without anyone asking.
        var failures = 0
        while failures < 4, let s = await states.next() { if s == .unreachable { failures += 1 } }
        prober.set("192.168.1.5", .ok)
        while let s = await states.next() { if s.endpoint != nil { break } }
        let endpoint = try await manager.endpoint()
        XCTAssertEqual(endpoint, lan)
        await manager.stop()
    }

    func testStopEndsTheRetries() async throws {
        let prober = FakeProber([:])
        let manager = ConnectionManager(book: book, token: "t", discovery: nil, prober: prober, retry: fastRetry)
        _ = try? await manager.endpoint()
        await manager.stop()
        let count = prober.probed.count
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(prober.probed.count, count)
    }

    // MARK: - half-open event streams

    func testASilentStreamIsDroppedAndResumed() async throws {
        let transport = SilentStreamTransport()
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let policy = ReconnectPolicy(initial: .milliseconds(5), maximum: .milliseconds(10), idleTimeout: 0.15)
        var got: [Int64] = []
        let started = Date()
        for try await ev in api.events(taskId: "t1", policy: policy) { got.append(ev.seq) }
        XCTAssertEqual(got, [1, 2])
        XCTAssertEqual(transport.queries, ["after=0", "after=1"], "resumed after the last event before the silence")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    func testIdleGuardPassesBytesThrough() async throws {
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        sink.yield(Data("a".utf8))
        sink.yield(Data("b".utf8))
        sink.finish()
        var out = Data()
        for try await chunk in AgentSwitchAPI.idleGuarded(body, limit: .seconds(5)) { out.append(chunk) }
        XCTAssertEqual(String(decoding: out, as: UTF8.self), "ab")
    }
}

/// First connection: one event, then nothing at all (a half-open socket). Second: the end.
private final class SilentStreamTransport: HTTPTransport, @unchecked Sendable {
    private let log = LockedBox<[String]>([])
    /// Kept so the silent stream is never finished by being released.
    private let held = LockedBox<[AsyncThrowingStream<Data, Error>.Continuation]>([])

    var queries: [String] { log.value }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (json(["id": "t1", "createdAt": 0, "updatedAt": 0, "status": "running", "task": "x"]), httpResponse(request.url))
    }

    func stream(_ request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, Error>) {
        let n = log.withLock { $0.append(request.url?.query ?? ""); return $0.count - 1 }
        let (body, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        if n == 0 {
            sink.yield(Self.frame(1, "text"))
            held.withLock { $0.append(sink) }
        } else {
            sink.yield(Self.frame(2, "done"))
            sink.finish()
        }
        return (httpResponse(request.url, contentType: "text/event-stream"), body)
    }

    static func frame(_ seq: Int, _ type: String) -> Data {
        let obj: [String: Any] = ["taskId": "t1", "seq": seq, "ts": seq, "type": type, "payload": ["text": "x"]]
        return Data("data: \(String(decoding: json(obj), as: UTF8.self))\n\n".utf8)
    }
}
