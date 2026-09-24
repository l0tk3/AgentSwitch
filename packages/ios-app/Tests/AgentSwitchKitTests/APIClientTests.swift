import XCTest
@testable import AgentSwitchKit

/// Counts failure reports and hands out endpoints in turn.
final class RotatingEndpoints: EndpointProviding, @unchecked Sendable {
    private let list: [APIEndpoint]
    private let index = LockedBox<Int>(0)
    private let reports = LockedBox<[APIEndpoint]>([])

    init(_ list: [APIEndpoint]) { self.list = list }

    var failures: [APIEndpoint] { reports.value }

    func endpoint() async throws -> APIEndpoint { list[min(index.value, list.count - 1)] }
    func reportFailure(_ endpoint: APIEndpoint) async {
        reports.withLock { $0.append(endpoint) }
        index.withLock { $0 += 1 }
    }
}

final class APIClientTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)
    private let tailnet = APIEndpoint(host: "fd7a:115c:a1e0::5", port: 4713, kind: .tailnet)

    func testRequestShape() async throws {
        let transport = FakeTransport { req, _ in (try Fixture.data("task.json"), httpResponse(req.url, status: 201)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let task = try await api.createTask(NewTaskRequest(task: "整理 CSV", pin: TargetRef(harness: "codex", model: "gpt-5.5")))
        XCTAssertEqual(task.id, "t_8f3a2c1d")
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "https://192.168.1.5:4713/tasks")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(req.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["task"] as? String, "整理 CSV")
        XCTAssertEqual((body["pin"] as? [String: String])?["model"], "gpt-5.5")
    }

    func testContextReadAndSave() async throws {
        let transport = FakeTransport { req, _ in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("GET", "/context"): return (json(["path": "/x/CONTEXT.md", "text": "# 站点", "warnings": []]), httpResponse(req.url))
            case ("GET", "/context/example"): return (json(["text": "# 示例"]), httpResponse(req.url))
            case ("PUT", "/context"):
                return (json(["path": "/x/CONTEXT.md", "warnings": ["line 3: \"密码\" value is not an enc:v1: token; line removed"],
                              "sealed": [["label": "fin/pass", "field": "account password", "hosts": ["fin.example.test"], "uses": ["http"]]]]), httpResponse(req.url))
            default: return (json(["error": "not found"]), httpResponse(req.url, status: 404))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let doc = try await api.context()
        XCTAssertEqual(doc.text, "# 站点")
        XCTAssertEqual(doc.warnings, [])
        let example = try await api.contextExample()
        XCTAssertEqual(example, "# 示例")
        let saved = try await api.saveContext("# 站点\n- 财务")
        XCTAssertEqual(saved.warnings.count, 1)
        XCTAssertEqual(saved.sealed.map(\.field), ["account password"])
        let put = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(put.httpMethod, "PUT")
        XCTAssertEqual(put.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(put.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["text"] as? String, "# 站点\n- 财务")
    }

    func testTaskCreationWaitsLongerThanTheSealer() async throws {
        let transport = FakeTransport { req, _ in
            req.httpMethod == "POST" ? (try Fixture.data("task.json"), httpResponse(req.url, status: 201)) : (json([]), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        _ = try await api.createTask(NewTaskRequest(task: "x"))
        _ = try await api.tasks()
        XCTAssertEqual(transport.requests.map(\.timeoutInterval), [AgentSwitchAPI.createTaskTimeout, api.requestTimeout])
        XCTAssertGreaterThan(AgentSwitchAPI.createTaskTimeout, 30, "the daemon's sealer may take 30 s before it answers")
    }

    func testDeletesAreDeleteRequestsAndNeverResent() async throws {
        let transport = FakeTransport { req, n in
            if n == 0 { return (json(["ok": true]), httpResponse(req.url)) }
            if n == 1 { return (json(["error": "thread has a running task"]), httpResponse(req.url, status: 409)) }
            throw APIError.transport("timed out")
        }
        let endpoints = RotatingEndpoints([lan, tailnet])
        let api = AgentSwitchAPI(endpoints: endpoints, transport: transport, token: "tok")
        try await api.deleteTask("t1")
        do { try await api.deleteThread("th1"); XCTFail("expected 409") } catch {
            XCTAssertEqual(error as? APIError, .http(status: 409, message: "thread has a running task"))
        }
        do { try await api.deleteTask("t2"); XCTFail("expected transport error") } catch {
            XCTAssertEqual(error as? APIError, .transport("timed out"))
        }
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" },
                       ["DELETE /tasks/t1", "DELETE /threads/th1", "DELETE /tasks/t2"], "a DELETE is sent once, like a POST")
        XCTAssertNil(transport.requests[0].httpBody)
    }

    func testIdsArePathSegmentsNotRoutes() {
        let url = tailnet.url(["tasks", "a/../b?x#y", "events"], query: [URLQueryItem(name: "after", value: "12")])
        XCTAssertEqual(url.absoluteString, "https://[fd7a:115c:a1e0::5]:4713/tasks/a%2F..%2Fb%3Fx%23y/events?after=12")
    }

    func testErrorsCarryTheDaemonMessage() async {
        let transport = FakeTransport { req, _ in (json(["error": "thread is archived; reopen it first"]), httpResponse(req.url, status: 409)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        do {
            _ = try await api.handoff(taskId: "t1")
            XCTFail("expected error")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 409, message: "thread is archived; reopen it first"))
        }
        XCTAssertEqual(transport.paths, ["/tasks/t1/handoff"])
    }

    func testUnauthorized() async {
        let transport = FakeTransport { req, _ in (json(["error": "unauthorized"]), httpResponse(req.url, status: 401)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "revoked")
        do { _ = try await api.tasks(); XCTFail() } catch { XCTAssertEqual(error as? APIError, .unauthorized) }
    }

    func testGetRetriesOnceOnANewEndpointButPostDoesNot() async throws {
        let transport = FakeTransport { req, _ in
            if req.url?.host(percentEncoded: false) == "192.168.1.5" { throw APIError.transport("timed out") }
            return (json([]), httpResponse(req.url))
        }
        let endpoints = RotatingEndpoints([lan, tailnet])
        let api = AgentSwitchAPI(endpoints: endpoints, transport: transport, token: "tok")
        let approvals = try await api.approvals()
        XCTAssertTrue(approvals.isEmpty)
        XCTAssertEqual(endpoints.failures, [lan])

        let endpoints2 = RotatingEndpoints([lan, tailnet])
        let api2 = AgentSwitchAPI(endpoints: endpoints2, transport: transport, token: "tok")
        do { _ = try await api2.createTask(NewTaskRequest(task: "x")); XCTFail() } catch {
            XCTAssertEqual(error as? APIError, .transport("timed out"))
        }
        XCTAssertEqual(transport.requests.filter { $0.httpMethod == "POST" }.count, 1, "no automatic resend of a POST")
    }

    func testApproveAndAnswerBodies() async throws {
        let transport = FakeTransport { req, _ in (json(["ok": true]), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        try await api.approve(taskId: "t1", approvalId: "ap1", decision: .deny)
        try await api.answer(taskId: "t1", approvalId: "ap2", answers: ["clarify": ["用工作账号"]])
        let bodies = transport.requests.compactMap { $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
        XCTAssertEqual(bodies[0]["approval_id"] as? String, "ap1")
        XCTAssertEqual(bodies[0]["decision"] as? String, "deny")
        XCTAssertEqual((bodies[1]["answers"] as? [String: [String]])?["clarify"], ["用工作账号"])
        XCTAssertEqual(transport.paths, ["/tasks/t1/approve", "/tasks/t1/answer"])
    }
}

final class EventStreamTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)
    private let fast = ReconnectPolicy(initial: .milliseconds(5), maximum: .milliseconds(20))

    private static func frame(_ seq: Int, _ type: String, _ payload: [String: Any] = [:]) -> Data {
        let obj: [String: Any] = ["taskId": "t1", "seq": seq, "ts": seq * 1000, "type": type, "payload": payload]
        return Data("event: \(type)\ndata: \(String(decoding: json(obj), as: UTF8.self))\nid: \(seq)\n\n".utf8)
    }

    private static func detail(_ status: String) -> Data {
        json(["id": "t1", "createdAt": 0, "updatedAt": 0, "status": status, "task": "x", "approvals": []])
    }

    func testReplayThenFollowUntilTerminal() async throws {
        let transport = FakeTransport(stream: { req, _ in
            (httpResponse(req.url, contentType: "text/event-stream"), [Self.frame(1, "queued"), Self.frame(2, "text", ["text": "hi"]), Self.frame(3, "done", ["result": "ok"])], nil)
        })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        var got: [Int64] = []
        for try await ev in api.events(taskId: "t1", policy: fast) { got.append(ev.seq) }
        XCTAssertEqual(got, [1, 2, 3])
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(req.url?.query, "after=0")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testReconnectsFromTheLastSeqWithoutDuplicates() async throws {
        let transport = FakeTransport(stream: { req, n in
            let head = httpResponse(req.url, contentType: "text/event-stream")
            switch n {
            case 0: return (head, [Self.frame(5, "text"), Self.frame(6, "text")], APIError.transport("connection lost"))
            case 1: throw APIError.transport("still offline")
            default: return (head, [Self.frame(6, "text"), Self.frame(7, "failed", ["error": "x"])], nil)
            }
        }, handler: { req, _ in (Self.detail("running"), httpResponse(req.url)) })
        let endpoints = RotatingEndpoints([lan, lan, lan])
        let api = AgentSwitchAPI(endpoints: endpoints, transport: transport, token: "tok")
        var got: [Int64] = []
        for try await ev in api.events(taskId: "t1", after: 4, policy: fast) { got.append(ev.seq) }
        XCTAssertEqual(got, [5, 6, 7])
        let queries = transport.requests.filter { $0.url?.path.hasSuffix("/events") == true }.map { $0.url?.query ?? "" }
        XCTAssertEqual(queries, ["after=4", "after=6", "after=6"])
        XCTAssertEqual(endpoints.failures.count, 2)
    }

    func testStopsWhenTheTaskIsAlreadyOver() async throws {
        let transport = FakeTransport(stream: { req, _ in (httpResponse(req.url, contentType: "text/event-stream"), [], nil) },
                                      handler: { req, _ in (Self.detail("cancelled"), httpResponse(req.url)) })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        var count = 0
        for try await _ in api.events(taskId: "t1", after: 9, policy: fast) { count += 1 }
        XCTAssertEqual(count, 0)
        XCTAssertEqual(transport.paths, ["/tasks/t1/events", "/tasks/t1"])
    }

    func testNotFoundEndsWithAnError() async {
        let transport = FakeTransport(stream: { req, _ in (httpResponse(req.url, status: 404), [json(["error": "not found"])], nil) })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        do {
            for try await _ in api.events(taskId: "t1", policy: fast) {}
            XCTFail("expected 404")
        } catch {
            XCTAssertEqual(error as? APIError, .http(status: 404, message: "not found"))
        }
    }

    func testBackoff() {
        let p = ReconnectPolicy(initial: .seconds(1), maximum: .seconds(15))
        XCTAssertEqual((1...6).map { p.delay(afterFailures: $0) }, [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(15), .seconds(15)])
    }
}
