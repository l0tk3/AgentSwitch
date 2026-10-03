import XCTest
@testable import AgentSwitchMacCore

/// A task's live events over the local API (ported from the Kit's EventStreamTests): replay then follow, reconnect from
/// the last seq without duplicates, end on a terminal event or an ended task, fail on a refusal, give up on silence.
final class DispatchEventStreamTests: XCTestCase {
    private typealias F = DispatchFixture
    private let fast = DispatchReconnectPolicy(initial: .milliseconds(5), maximum: .milliseconds(20))

    private static func detail(_ status: String) -> Data {
        F.json(["id": "t1", "createdAt": 0, "updatedAt": 0, "status": status, "task": "x", "approvals": []])
    }

    private func client(_ transport: DispatchFakeTransport) throws -> DaemonClient {
        let home = TestSupport.tempDir("events")
        let token = home.appendingPathComponent(DaemonClient.tokenFileName)
        try "tok-123".write(to: token, atomically: true, encoding: .utf8)
        return DaemonClient(port: 4811, transport: transport, tokenFile: token)
    }

    func testReplayThenFollowUntilTerminal() async throws {
        let transport = DispatchFakeTransport.streaming({ _, _ in
            (200, [F.frame(1, "queued"), F.frame(2, "text", ["text": "hi"]), Data(": ping\n\n".utf8), F.frame(3, "done", ["result": "ok"])], nil)
        })
        var got: [Int64] = []
        for try await event in try client(transport).taskEvents(taskId: "t1", after: 0, policy: fast) { got.append(event.seq) }
        XCTAssertEqual(got, [1, 2, 3])
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:4811/tasks/t1/events?after=0")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-123", "the local API wants the token on the stream too")
        XCTAssertEqual(request.timeoutInterval, fast.idleTimeout)
    }

    func testFramesSplitAcrossChunksAndForeignOrBrokenFramesAreSkipped() async throws {
        let whole = F.frame(2, "text", ["text": "第一行"])
        let transport = DispatchFakeTransport.streaming({ _, _ in
            (200, [F.frame(1, "text", task: "other"), Data("event: text\ndata: {not json}\n\n".utf8),
                   whole.prefix(17), whole.dropFirst(17), F.frame(3, "failed", ["error": "x"])], nil)
        })
        var got: [Int64] = []
        for try await event in try client(transport).taskEvents(taskId: "t1", after: 0, policy: fast) { got.append(event.seq) }
        XCTAssertEqual(got, [2, 3])
    }

    func testReconnectsFromTheLastSeqWithoutDuplicates() async throws {
        let transport = DispatchFakeTransport.streaming({ _, n in
            switch n {
            case 0: return (200, [F.frame(5, "text"), F.frame(6, "text")], DaemonError.unreachable("connection lost"))
            case 1: throw URLError(.networkConnectionLost)
            default: return (200, [F.frame(6, "text"), F.frame(7, "failed", ["error": "x"])], nil)
            }
        }, handler: { _, _ in (200, Self.detail("running")) })
        var got: [Int64] = []
        for try await event in try client(transport).taskEvents(taskId: "t1", after: 4, policy: fast) { got.append(event.seq) }
        XCTAssertEqual(got, [5, 6, 7])
        let queries = transport.requests.filter { $0.url?.path.hasSuffix("/events") == true }.map { $0.url?.query ?? "" }
        XCTAssertEqual(queries, ["after=4", "after=6", "after=6"])
    }

    func testStopsWhenTheTaskIsAlreadyOver() async throws {
        let transport = DispatchFakeTransport.streaming({ _, _ in (200, [], nil) }, handler: { _, _ in (200, Self.detail("cancelled")) })
        var count = 0
        for try await _ in try client(transport).taskEvents(taskId: "t1", after: 9, policy: fast) { count += 1 }
        XCTAssertEqual(count, 0)
        XCTAssertEqual(transport.lines, ["GET /tasks/t1/events?after=9", "GET /tasks/t1"])
    }

    func testAClosedStreamOfARunningTaskIsFollowedAgain() async throws {
        let transport = DispatchFakeTransport.streaming({ _, n in
            n == 0 ? (200, [F.frame(1, "text")], nil) : (200, [F.frame(2, "done")], nil)
        }, handler: { _, _ in (200, Self.detail("running")) })
        var got: [Int64] = []
        for try await event in try client(transport).taskEvents(taskId: "t1", after: 0, policy: fast) { got.append(event.seq) }
        XCTAssertEqual(got, [1, 2])
        XCTAssertEqual(transport.lines, ["GET /tasks/t1/events?after=0", "GET /tasks/t1", "GET /tasks/t1/events?after=1"])
    }

    func testARefusalEndsWithAnError() async throws {
        let transport = DispatchFakeTransport.streaming({ _, _ in (404, [F.json(["error": "not found"])], nil) })
        do {
            for try await _ in try client(transport).taskEvents(taskId: "t1", after: 0, policy: fast) {}
            XCTFail("expected 404")
        } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 404, message: "not found"))
        }
        let unauthorized = DispatchFakeTransport.streaming({ _, _ in (401, [F.json(["error": "unauthorized"])], nil) })
        do {
            for try await _ in try client(unauthorized).taskEvents(taskId: "t1", after: 0, policy: fast) {}
            XCTFail("expected 401")
        } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 401, message: "unauthorized"))
        }
    }

    func testSilenceCountsAsADroppedConnection() async {
        let (silent, sink) = AsyncThrowingStream<Data, Error>.makeStream()
        defer { sink.finish() }
        do {
            for try await _ in DaemonClient.idleGuarded(silent, limit: .milliseconds(50)) {}
            XCTFail("expected the idle limit")
        } catch {
            XCTAssertEqual(error as? DaemonError, .unreachable(DaemonClient.idleMessage))
            XCTAssertTrue((error as? DaemonError)?.isNetworkFailure == true, "silence reconnects rather than failing the page")
        }
    }

    func testBackoff() {
        let p = DispatchReconnectPolicy(initial: .seconds(1), maximum: .seconds(15))
        XCTAssertEqual((1...6).map { p.delay(afterFailures: $0) }, [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(15)])
        XCTAssertEqual(p.delay(afterFailures: 0), .zero)
    }

    func testEventsTouchingTheTaskAndItsApprovals() {
        XCTAssertTrue(F.event(1, "approval_request").touchesApprovals)
        XCTAssertTrue(F.event(1, "done").endsStream)
        XCTAssertTrue(F.event(1, "dispatched").touchesTask)
        XCTAssertFalse(F.event(1, "text").touchesTask)
        XCTAssertEqual(F.event(7, "text", task: "t9").id, "t9#7")
    }
}
