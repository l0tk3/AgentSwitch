import XCTest
@testable import AgentSwitchKit

/// The home screen as a conversation with the assistant (assistant-v0 §1.1): the API calls, and how messages and tasks
/// merge into one timeline — a task under the reply that created it, other tasks on their own.
final class ConversationTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    private static func message(_ seq: Int, _ role: String, _ text: String, kind: String = "reply", tasks: [String] = [], ts: Int64? = nil, clientId: String? = nil) -> [String: Any] {
        ["seq": seq, "ts": ts ?? Int64(seq * 1000), "role": role, "text": text, "kind": kind, "taskIds": tasks, "clientId": clientId.map { $0 as Any } ?? NSNull(), "replyTo": NSNull()]
    }

    private func task(_ id: String, at created: Int64) throws -> AgentTask {
        let object: [String: Any] = ["id": id, "createdAt": created, "updatedAt": created, "status": "running", "task": "x"]
        return try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testSendIsOnePostWithTheClientIdAndAPatientTimeout() async throws {
        let transport = FakeTransport { req, _ in
            (json(["user": Self.message(1, "user", "整理下载目录", kind: "message"), "assistant": Self.message(2, "assistant", "收到。", kind: "task", tasks: ["t1"]),
                   "task": ["id": "t1", "createdAt": 1, "updatedAt": 1, "status": "queued", "task": "整理下载目录"]]), httpResponse(req.url))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let reply = try await api.sendMessage(NewMessage(text: "整理下载目录", clientId: "client-0001"))
        XCTAssertEqual(reply.assistant.kind, .task)
        XCTAssertEqual(reply.task?.id, "t1")
        let req = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(req.url?.path, "/assistant")
        XCTAssertEqual(req.timeoutInterval, AgentSwitchAPI.assistantTimeout)
        let body = try XCTUnwrap(req.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["client_id"] as? String, "client-0001")
        XCTAssertNil(body["attachments"], "no empty lists on the wire")
    }

    func testMessagesAfterASequenceNumber() async throws {
        let transport = FakeTransport { req, _ in (json(["messages": [Self.message(3, "assistant", "好")]]), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let list = try await api.assistantMessages(after: 2)
        XCTAssertEqual(list.map(\.seq), [3])
        XCTAssertEqual(transport.requests.first?.url?.query, "after=2")
    }

    func testReportsAreUnpromptedAndLinkTheirTask() throws {
        let notice = try decode(AssistantMessage.self, Self.message(7, "assistant", "「整理下载目录」完成了", kind: "notice", tasks: ["t1"]))
        let progress = try decode(AssistantMessage.self, Self.message(8, "assistant", "还在进行", kind: "progress", tasks: ["t1"]))
        let watch = try decode(AssistantMessage.self, Self.message(9, "assistant", "每 10 分钟告诉你", kind: "watch", tasks: ["t1"]))
        XCTAssertEqual([notice.kind, progress.kind, watch.kind], [.notice, .progress, .watch])
        XCTAssertEqual([notice.unprompted, progress.unprompted, watch.unprompted], [true, true, false])
        let items = Conversation.timeline(messages: [notice], tasks: [try task("t1", at: 1)])
        XCTAssertEqual(items.map(\.id), ["task-t1", "m7"], "a report does not own the task: the task stays where it was made")
        XCTAssertEqual(items[1].mentions, ["t1"])
    }

    func testUnknownKindsStillDecode() throws {
        let m = try decode(AssistantMessage.self, Self.message(1, "assistant", "x", kind: "brand-new"))
        XCTAssertEqual(m.kind, .other)
    }

    func testTimelinePutsTasksUnderTheReplyThatMadeThem() throws {
        let messages = try [
            decode(AssistantMessage.self, Self.message(1, "user", "整理下载目录", kind: "message", ts: 1000)),
            decode(AssistantMessage.self, Self.message(2, "assistant", "收到。", kind: "task", tasks: ["t1"], ts: 1100)),
            decode(AssistantMessage.self, Self.message(3, "user", "刚才那个怎么样了", kind: "message", ts: 5000)),
            decode(AssistantMessage.self, Self.message(4, "assistant", "还在跑。", kind: "status", tasks: ["t1"], ts: 5100)),
        ]
        let tasks = try [task("t1", at: 1050), task("web", at: 3000)]
        let items = Conversation.timeline(messages: messages, tasks: tasks)
        XCTAssertEqual(items.map(\.id), ["m1", "m2", "task-web", "m3", "m4"])
        guard case .assistant(let reply, let made) = items[1] else { return XCTFail("\(items[1])") }
        XCTAssertEqual(reply.seq, 2)
        XCTAssertEqual(made.map(\.id), ["t1"], "the created task hangs under its reply")
        guard case .assistant(_, let mentioned) = items[4] else { return XCTFail() }
        XCTAssertEqual(mentioned, [], "a status answer only mentions tasks, it does not own them")
        XCTAssertEqual(items[4].mentions, ["t1"])
    }

    func testTimelineKeepsTheNewestItems() throws {
        let messages = try (1...50).map { try decode(AssistantMessage.self, Self.message($0, $0 % 2 == 1 ? "user" : "assistant", "m\($0)")) }
        XCTAssertEqual(Conversation.timeline(messages: messages, tasks: [], limit: 10).map(\.id).first, "m41")
    }

    func testFirstLoadAsksForTheNewestMessages() async throws {
        let transport = FakeTransport { req, _ in (json(["messages": [Self.message(9, "user", "x")]]), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        _ = try await api.assistantMessages(last: 60)
        XCTAssertEqual(transport.requests.first?.url?.query, "last=60")
    }

    func testTheLogHoldsEachMessageOnceInOrderAndOnlyTheNewest() throws {
        let m = { (seq: Int) in try self.decode(AssistantMessage.self, Self.message(seq, seq % 2 == 1 ? "user" : "assistant", "m\(seq)")) }
        let log = ConversationLog(try [m(3), m(1)], keep: 3)
        let merged = log.merging(try [m(2), m(3), m(4)])
        XCTAssertEqual(merged.messages.map(\.seq), [2, 3, 4], "sorted, de-duplicated, the newest three")
        XCTAssertEqual(log.messages.map(\.seq), [1, 3], "merging leaves the original as it was")
        XCTAssertEqual(merged.lastSeq, 4)
        XCTAssertEqual(ConversationLog().lastSeq, 0)
    }

    func testALostAnswerIsFoundByTheClientIdAndNewRepliesAreSingledOut() throws {
        let sent = try decode(AssistantMessage.self, Self.message(5, "user", "整理下载目录", kind: "message", clientId: "client-0001"))
        let answer = try decode(AssistantMessage.self, Self.message(6, "assistant", "收到。", kind: "task", tasks: ["t1"]))
        let log = ConversationLog().merging([sent])
        XCTAssertTrue(log.contains(clientId: "client-0001"))
        XCTAssertFalse(log.contains(clientId: "client-0002"))
        XCTAssertEqual(log.newAssistantMessages(in: [sent, answer]).map(\.seq), [6], "the user's own message is not read back")
        XCTAssertEqual(log.merging([answer]).newAssistantMessages(in: [answer]), [])
    }

    func testUpdateAndProjectCalls() async throws {
        let transport = FakeTransport { req, _ in
            switch (req.httpMethod, req.url?.path) {
            case ("GET", "/update"): return (json(["running": "2026-09-25T01:00:00Z", "staged": "2026-09-25T03:00:00Z", "last": ["ok": false, "reverted": true, "from": "A", "to": "B", "at": 1, "reason": "did not answer"]]), httpResponse(req.url))
            case ("POST", "/update/install"): return (json(["requested": true, "staged": "2026-09-25T03:00:00Z"]), httpResponse(req.url, status: 202))
            default: return (json(["projects": [["name": "AgentSwitch", "path": "/Users/u/Projects/AgentSwitch"], ["name": "Old", "path": "/x", "problem": "not an existing directory"]]]), httpResponse(req.url))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let update = try await api.appUpdate()
        XCTAssertTrue(update.canInstall)
        XCTAssertEqual(update.last?.reverted, true)
        try await api.installUpdate()
        XCTAssertEqual(transport.requests.last?.httpMethod, "POST")
        let projects = try await api.projects()
        XCTAssertEqual(projects.map(\.name), ["AgentSwitch", "Old"])
        XCTAssertEqual(projects[1].problem, "not an existing directory")
    }

    func testClientIdsAreFreshAndWellFormed() {
        let a = Conversation.newClientId(), b = Conversation.newClientId()
        XCTAssertNotEqual(a, b)
        XCTAssertNotNil(a.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression))
    }
}
