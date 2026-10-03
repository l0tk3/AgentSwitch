import XCTest
@testable import AgentSwitchMacCore

/// DaemonClient as a DispatchService (docs/dispatch-v0.md §2, §3): every route's method, path, query, body, headers and
/// timeout, checked against a fake transport (no network).
final class DispatchClientTests: XCTestCase {
    private typealias F = DispatchFixture

    private var home: URL!

    override func setUpWithError() throws {
        home = TestSupport.tempDir("dispatch")
        try "tok-123\n".write(to: home.appendingPathComponent(DaemonClient.tokenFileName), atomically: true, encoding: .utf8)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: home)
    }

    private func client(_ transport: DispatchFakeTransport) -> DaemonClient {
        DaemonClient(port: 4811, transport: transport, tokenFile: home.appendingPathComponent(DaemonClient.tokenFileName))
    }

    private static var task: [String: Any] { ["id": "t1", "createdAt": 1, "updatedAt": 2, "status": "queued", "task": "整理下载目录"] }
    private static var thread: [String: Any] { ["id": "th 1", "createdAt": 1, "updatedAt": 2, "title": "T", "status": "archived"] }
    private static func message(_ seq: Int, _ role: String) -> [String: Any] {
        ["seq": seq, "ts": seq, "role": role, "text": "m", "kind": role == "user" ? "message" : "task", "taskIds": role == "user" ? [] : ["t1"]]
    }

    /// Answers each route with its daemon shape.
    private static func answer(_ request: URLRequest) -> (Int, Data) {
        let route = "\(request.httpMethod ?? "") \(request.url?.path ?? "")"
        switch route {
        case "GET /assistant": return (200, F.json(["messages": [message(9, "user")]]))
        case "POST /assistant": return (200, F.json(["user": message(1, "user"), "assistant": message(2, "assistant"), "task": task]))
        case "GET /tasks": return (200, F.json([task]))
        case "GET /tasks/t1": return (200, F.json(task.merging(["approvals": []]) { a, _ in a }))
        case "GET /approvals": return (200, F.json([]))
        case "POST /tasks/t1/cancel", "POST /tasks/t1/handoff": return (200, F.json(task))
        case "POST /tasks/t1/ack": return (200, F.json(["acknowledgedAt": 1234]))
        case "GET /tasks/t1/files": return (200, F.json(["root": "cwd", "files": [["path": "in/a.png", "size": 2, "mtime": 1], ["path": "out/报告 1.pdf", "size": 9, "mtime": 2]]]))
        case "GET /threads": return (200, F.json([thread]))
        case "GET /threads/th 1": return (200, F.json(thread.merging(["tasks": [task]]) { a, _ in a }))
        case "PATCH /threads/th 1", "POST /threads/th 1/archive", "POST /threads/th 1/reopen": return (200, F.json(thread))
        case "POST /uploads": return (200, F.json(["files": [["id": "u1", "name": "a.png", "size": 2, "type": "image/png"]]]))
        case "GET /targets": return (200, Data(F.targetsJSON.utf8))
        case "GET /context", "GET /memory": return (200, F.json(["path": "/h/x.md", "text": "# 站点", "warnings": []]))
        case "GET /context/example": return (200, F.json(["text": "# 示例"]))
        case "PUT /context", "PUT /memory": return (200, F.json(["path": "/h/x.md", "warnings": [], "sealed": []]))
        case "GET /platform-memory": return (200, F.json(["records": []]))
        case "GET /mcp": return (200, F.json([["name": "gh", "kind": "stdio", "command": "npx"]]))
        case "PUT /mcp/gh": return (200, F.json(["name": "gh", "kind": "stdio", "command": "npx", "enabled": false]))
        case "GET /skills", "GET /skills/discover": return (200, F.json([]))
        case "GET /skills/pdf": return (200, F.json(["name": "pdf", "content": "x"]))
        case "PUT /skills/pdf", "POST /skills/import": return (200, F.json(["name": "pdf"]))
        case "GET /routing/log": return (200, F.json([["id": 1, "ts": 1, "cwd": "/w", "source": "pin", "notes": "", "routerMs": 0]]))
        case "GET /search": return (200, F.json(["results": [["taskId": "t1", "title": "整理", "snippet": "把⟦下载⟧目录", "status": "done", "updatedAt": 9]]]))
        default: return (200, F.json(["ok": true]))
        }
    }

    func testConversationRoutes() async throws {
        let transport = DispatchFakeTransport { req, _ in Self.answer(req) }
        let api = client(transport)
        let first = try await api.messages(last: 60)
        XCTAssertEqual(first.map(\.seq), [9])
        _ = try await api.messages(after: 9)
        let reply = try await api.send(DispatchNewMessage(text: "整理下载目录", clientId: "client-0001", attachments: ["u1"],
                                                          pin: DispatchTarget(harness: "codex", model: "gpt-5.5")))
        XCTAssertEqual(reply.task?.id, "t1")
        XCTAssertEqual(reply.assistant.kind, .task)
        try await api.deleteEntry(seq: 12)
        XCTAssertEqual(transport.lines, ["GET /assistant?last=60", "GET /assistant?after=9", "POST /assistant", "DELETE /assistant/12"])
        let post = transport.requests[2]
        XCTAssertEqual(post.timeoutInterval, DispatchTimeouts.assistant, "the assistant answers after sealing and maybe creating a task")
        XCTAssertEqual(post.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(F.body(post))
        XCTAssertEqual(body["client_id"] as? String, "client-0001")
        XCTAssertEqual(body["attachments"] as? [String], ["u1"])
        XCTAssertEqual((body["pin"] as? [String: String])?["harness"], "codex")
        XCTAssertNil(transport.requests[3].httpBody, "a delete carries no body")
        XCTAssertEqual(transport.requests[3].timeoutInterval, DispatchTimeouts.delete)
        for request in transport.requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-123", "the local token on every call")
            XCTAssertEqual(request.url?.host, "127.0.0.1")
        }
        XCTAssertEqual(transport.requests[0].timeoutInterval, DispatchTimeouts.request, "an explicit timeout, not the session's 5 s")
    }

    func testTaskRoutes() async throws {
        let transport = DispatchFakeTransport { req, _ in Self.answer(req) }
        let api = client(transport)
        let listed = try await api.tasks()
        XCTAssertEqual(listed.map(\.id), ["t1"])
        let detail = try await api.task(id: "t1")
        XCTAssertEqual(detail.task.status, .queued)
        _ = try await api.approvals()
        try await api.decide(taskId: "t1", approvalId: "ap1", decision: .deny)
        try await api.answer(taskId: "t1", approvalId: "ap2", answers: ["clarify": ["用工作账号"]])
        _ = try await api.cancel(taskId: "t1")
        _ = try await api.handoff(taskId: "t1", to: nil)
        _ = try await api.handoff(taskId: "t1", to: DispatchTarget(harness: "codex", model: "gpt-5.5"))
        let ran = try F.task("t1", "failed", extra: ["harness": "claude-code", "model": "sonnet"])
        _ = try await api.retry(ran)
        try await api.rate(taskId: "t1", rating: 1)
        try await api.rate(taskId: "t1", rating: nil)
        let acked = try await api.acknowledge(taskId: "t1")
        XCTAssertEqual(acked, 1234)
        try await api.deleteTask(id: "t1")
        let files = try await api.taskFiles(taskId: "t1")
        XCTAssertEqual(files.map(\.isDeliverable), [false, true])
        XCTAssertEqual(transport.lines, [
            "GET /tasks?limit=50", "GET /tasks/t1", "GET /approvals", "POST /tasks/t1/approve", "POST /tasks/t1/answer",
            "POST /tasks/t1/cancel", "POST /tasks/t1/handoff", "POST /tasks/t1/handoff", "POST /tasks/t1/handoff",
            "POST /tasks/t1/rate", "POST /tasks/t1/rate", "POST /tasks/t1/ack", "DELETE /tasks/t1", "GET /tasks/t1/files",
        ])
        let bodies = transport.requests.map { F.body($0) }
        XCTAssertEqual(bodies[3]?["approval_id"] as? String, "ap1")
        XCTAssertEqual(bodies[3]?["decision"] as? String, "deny")
        XCTAssertEqual((bodies[4]?["answers"] as? [String: [String]])?["clarify"], ["用工作账号"])
        XCTAssertEqual(transport.requests[4].timeoutInterval, DispatchTimeouts.sealing, "answers pass the sealer")
        XCTAssertEqual(bodies[5]?.count, 0, "cancel sends {}")
        XCTAssertNil(bodies[6]?["to"], "hand to Auto: the router picks, leaving out the current executor")
        XCTAssertEqual((bodies[7]?["to"] as? [String: String])?["model"], "gpt-5.5")
        XCTAssertEqual((bodies[8]?["to"] as? [String: String])?["harness"], "claude-code", "a retry pins the executor it ran on")
        XCTAssertEqual(bodies[9]?["rating"] as? Int, 1)
        XCTAssertTrue(bodies[10]?["rating"] is NSNull, "clearing sends rating: null, which the daemon requires")
    }

    func testDownloadsEncodeEachSegmentAndWriteTheFile() async throws {
        let transport = DispatchFakeTransport { req, _ in
            req.url?.path.hasPrefix("/tasks/t1/files/out") == true ? (200, Data([7, 8, 9])) : (404, Data("404 Not Found".utf8))
        }
        let api = client(transport)
        let target = home.appendingPathComponent("cache/t1/out/报告 1.pdf")
        try await api.downloadTaskFile(taskId: "t1", path: "out/报告 1.pdf", to: target)
        XCTAssertEqual(try Data(contentsOf: target), Data([7, 8, 9]))
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:4811/tasks/t1/files/out/%E6%8A%A5%E5%91%8A%201.pdf")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "*/*")
        XCTAssertEqual(request.timeoutInterval, DispatchTimeouts.transfer)
        do {
            try await api.downloadTaskFile(taskId: "t1", path: "in/gone.png", to: home.appendingPathComponent("x"))
            XCTFail("expected 404")
        } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 404, message: "文件不存在或已删除"))
        }
    }

    func testTopicRoutes() async throws {
        let transport = DispatchFakeTransport { req, _ in Self.answer(req) }
        let api = client(transport)
        _ = try await api.threads(.open)
        _ = try await api.threads(.archived)
        _ = try await api.threads(.all, limit: 10)
        let detail = try await api.thread(id: "th 1")
        XCTAssertEqual(detail.tasks.map(\.id), ["t1"])
        _ = try await api.renameThread(id: "th 1", title: " 新标题 ")
        _ = try await api.renameThread(id: "th 1", title: "")
        let archived = try await api.archiveThread(id: "th 1")
        XCTAssertTrue(archived.isArchived)
        _ = try await api.reopenThread(id: "th 1")
        try await api.deleteThread(id: "th 1")
        XCTAssertEqual(transport.lines, [
            "GET /threads?status=open&limit=50", "GET /threads?status=archived&limit=100", "GET /threads?limit=10", "GET /threads/th 1",
            "PATCH /threads/th 1", "PATCH /threads/th 1", "POST /threads/th 1/archive", "POST /threads/th 1/reopen", "DELETE /threads/th 1",
        ])
        XCTAssertEqual(transport.requests[3].url?.absoluteString, "http://127.0.0.1:4811/threads/th%201", "ids are path segments")
        XCTAssertEqual(F.body(transport.requests[4])?["title"] as? String, "新标题")
        XCTAssertTrue(F.body(transport.requests[5])?["title"] is NSNull, "an empty title goes back to the summarizer's")
    }

    func testUploadIsOneMultipartPost() async throws {
        let transport = DispatchFakeTransport { req, _ in Self.answer(req) }
        let staged = try await client(transport).upload([DispatchUploadFile(name: "a.png", type: "image/png", data: Data([1, 2]))])
        XCTAssertEqual(staged.map(\.id), ["u1"])
        let upload = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(upload.httpMethod, "POST")
        XCTAssertEqual(upload.timeoutInterval, DispatchTimeouts.transfer)
        let type = try XCTUnwrap(upload.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(type.hasPrefix("multipart/form-data; boundary=agentswitch-"), "the one multipart body the local guard accepts")
        XCTAssertTrue(String(decoding: upload.httpBody ?? Data(), as: UTF8.self).contains("filename=\"a.png\""))
    }

    func testSettingsGroupRoutes() async throws {
        let transport = DispatchFakeTransport { req, _ in Self.answer(req) }
        let api = client(transport)
        let targets = try await api.targets()
        XCTAssertFalse(targets.pinOptions.isEmpty)
        _ = try await api.context()
        let example = try await api.contextExample()
        XCTAssertEqual(example, "# 示例")
        _ = try await api.saveContext("# 站点")
        _ = try await api.memory()
        _ = try await api.saveMemory("- fact")
        _ = try await api.platformMemory()
        try await api.deletePlatformMemory(id: "pm 1")
        let servers = try await api.mcpServers()
        let saved = try await api.saveMCPServer(servers[0].toggled())
        XCTAssertFalse(saved.enabled)
        try await api.deleteMCPServer(name: "gh")
        _ = try await api.skills()
        let skill = try await api.skill(name: "pdf")
        XCTAssertEqual(skill.content, "x")
        _ = try await api.saveSkill(name: "pdf", DispatchSkillUpdate(enabled: false))
        try await api.deleteSkill(name: "pdf")
        _ = try await api.discoverSkills()
        _ = try await api.importSkill(path: "/u/.claude/skills/pdf")
        let log = try await api.routingLog()
        XCTAssertEqual(log.first?.source, "pin")
        let hits = try await api.search(query: "下载 目录")
        XCTAssertEqual(hits.first?.status, .done)
        let none = try await api.search(query: "   ")
        XCTAssertEqual(none, [], "a blank query asks nothing")
        try await api.clearHistory()
        XCTAssertEqual(transport.lines, [
            "GET /targets", "GET /context", "GET /context/example", "PUT /context", "GET /memory", "PUT /memory", "GET /platform-memory",
            "DELETE /platform-memory/pm 1", "GET /mcp", "PUT /mcp/gh", "DELETE /mcp/gh", "GET /skills", "GET /skills/pdf", "PUT /skills/pdf",
            "DELETE /skills/pdf", "GET /skills/discover", "POST /skills/import", "GET /routing/log?limit=50",
            "GET /search?q=%E4%B8%8B%E8%BD%BD%20%E7%9B%AE%E5%BD%95&limit=30", "DELETE /history",
        ])
        XCTAssertEqual(transport.requests[3].timeoutInterval, DispatchTimeouts.sealing, "context.md is sealed like a task")
        XCTAssertEqual(F.body(transport.requests[3])?["text"] as? String, "# 站点")
        XCTAssertEqual(F.body(transport.requests[9])?["enabled"] as? Bool, false, "a toggle sends the whole server back")
        XCTAssertEqual(F.body(transport.requests[13]).map { Array($0.keys) }, ["enabled"], "only what changes")
        XCTAssertEqual(F.body(transport.requests[16])?["path"] as? String, "/u/.claude/skills/pdf")
    }

    func testErrorsAreTypedAndNothingIsResent() async {
        let transport = DispatchFakeTransport { req, _ in
            switch req.url?.path ?? "" {
            case "/threads/th/archive": return (409, F.json(["error": "task t1 is still running; cancel it first"]))
            case "/mcp": return (404, Data("404 Not Found".utf8))
            default: throw URLError(.timedOut)
            }
        }
        let api = client(transport)
        do { _ = try await api.archiveThread(id: "th"); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .http(status: 409, message: "task t1 is still running; cancel it first"))
            XCTAssertEqual((error as? DaemonError)?.reason, "task t1 is still running; cancel it first")
        }
        do { _ = try await api.mcpServers(); XCTFail() } catch {
            XCTAssertEqual(error as? DaemonError, .notSupported("GET /mcp"), "a route this daemon lacks")
        }
        do { _ = try await api.send(DispatchNewMessage(text: "x", clientId: "client-0002")); XCTFail() } catch {
            guard case .unreachable = error as? DaemonError else { return XCTFail("\(error)") }
        }
        XCTAssertEqual(transport.requests.filter { $0.httpMethod == "POST" }.count, 2, "no automatic resend of a POST")
        let cancelled = DispatchFakeTransport { _, _ in throw URLError(.cancelled) }
        do { _ = try await client(cancelled).tasks(); XCTFail() } catch {
            XCTAssertTrue(error is CancellationError, "a cancelled call is not the service being down")
        }
    }

    /// Views depend on the protocol only.
    func testTheViewsSeeOnlyTheProtocol() async throws {
        let transport = DispatchFakeTransport { req, _ in Self.answer(req) }
        let service: any DispatchService = client(transport)
        let threads = try await service.threads()
        XCTAssertEqual(threads.first?.id, "th 1")
        XCTAssertEqual(transport.lines, ["GET /threads?status=open&limit=50"])
    }
}
