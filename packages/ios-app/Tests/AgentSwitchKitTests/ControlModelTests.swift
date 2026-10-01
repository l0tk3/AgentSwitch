import XCTest
@testable import AgentSwitchKit

/// control-v0's wire shapes and routes: permission mode, default folder, coding sessions, read marks, search.
final class ControlModelTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testPolicyDecodesEveryModeAndToleratesNewOnes() throws {
        let info = try decode(ApprovalPolicyInfo.self, ["policy": ["mode": "skip", "human": ["delete", "git_push"]],
                                                        "categories": [["id": "delete", "title": "删除文件"], ["id": "git_push", "title": "git push"]]])
        XCTAssertEqual(info.policy.mode, .skip)
        XCTAssertEqual(info.policy.mode.label, "Bypass")
        XCTAssertEqual(info.humanTitles, ["删除文件", "git push"])
        XCTAssertEqual(try decode(ApprovalPolicyInfo.self, ["policy": ["mode": "manual"]]).policy.mode.label, "Ask Each")
        XCTAssertEqual(try decode(ApprovalPolicyInfo.self, ["policy": ["mode": "scoped", "human": []]]).policy.mode.label, "Auto")
        XCTAssertEqual(try decode(ApprovalPolicyInfo.self, ["policy": ["mode": "auto"]]).policy.mode.label, "All Auto")
        let future = try decode(ApprovalPolicyInfo.self, ["policy": ["mode": "yolo", "human": "not a list"], "categories": "nope"])
        XCTAssertEqual(future.policy.mode, .other("yolo"))
        XCTAssertEqual(future.policy.human, [])
        XCTAssertEqual(future.categories, [])
        XCTAssertFalse(future.policy.mode.explanation.isEmpty)
    }

    func testWorkdirReadsDefaultEitherWay() throws {
        let asPath = try decode(WorkdirSetting.self, ["path": "/Users/me/AgentSwitch", "default": "/Users/me/AgentSwitch", "problem": NSNull()])
        XCTAssertTrue(asPath.isDefault)
        XCTAssertNil(asPath.problem)
        let asFlag = try decode(WorkdirSetting.self, ["path": "/Users/me/Work", "default": false, "problem": "目录不存在"])
        XCTAssertFalse(asFlag.isDefault)
        XCTAssertEqual(asFlag.problem, "目录不存在")
        XCTAssertNil(try decode(WorkdirSetting.self, ["path": "/x", "problem": ""]).problem, "an empty problem is none")
    }

    func testSessionsDecodeWithMissingFields() throws {
        let list = try decode(SessionList.self, ["sessions": [
            ["harness": "claude-code", "id": "a1", "cwd": "/Users/me/Projects/AgentSwitch", "title": "修 SSE 重连", "lastText": "改好了",
             "updatedAt": 2000, "active": true, "branch": "main"],
            ["harness": "codex", "id": "b2", "cwd": NSNull(), "title": NSNull(), "lastText": "第一行\n第二行", "updatedAt": 1000, "origin": "desktop"],
        ]])
        XCTAssertEqual(list.sessions.map(\.id), ["claude-code/a1", "codex/b2"])
        XCTAssertTrue(list.sessions[0].active)
        XCTAssertEqual(list.sessions[0].harnessName, "Claude Code")
        XCTAssertEqual(list.sessions[1].cwd, "")
        XCTAssertFalse(list.sessions[1].active)
        XCTAssertEqual(list.sessions[1].displayTitle, "第一行", "no title: the first line of the last text")
        XCTAssertEqual(list.sessions[1].origin, "desktop")

        let detail = try decode(SessionDetail.self, ["session": ["harness": "opencode", "id": "s", "updatedAt": 5],
                                                     "messages": [["role": "assistant", "text": "b", "ts": 2], ["role": "user", "text": "a", "ts": 1],
                                                                  ["role": "tool", "text": "ls", "ts": 3, "tool": "bash"], ["role": "system", "text": "?", "ts": 4]]])
        XCTAssertEqual(detail.messages.map(\.text), ["a", "b", "ls", "?"], "oldest first")
        XCTAssertEqual(detail.messages.map(\.role), [.user, .assistant, .tool, .other])
        XCTAssertEqual(detail.messages[2].tool, "bash")
        XCTAssertEqual(detail.session.displayTitle, "未命名会话")
    }

    func testSessionsGroupByFolderNewestFirst() {
        let sessions = [
            SessionSummary(harness: "codex", id: "1", cwd: "/a", title: "old a", updatedAt: 10),
            SessionSummary(harness: "claude-code", id: "2", cwd: "/b", title: "b", updatedAt: 30),
            SessionSummary(harness: "opencode", id: "3", cwd: "/a", title: "new a", updatedAt: 40),
        ]
        let groups = SessionGroups.grouped(sessions)
        XCTAssertEqual(groups.map(\.folder), ["/a", "/b"])
        XCTAssertEqual(groups[0].sessions.map(\.title), ["new a", "old a"])
    }

    func testTaskReadMarkAndInterruption() throws {
        let task = try decode(AgentTask.self, ["id": "t", "createdAt": 1, "updatedAt": 500, "status": "blocked", "task": "x",
                                               "blockCause": "interrupted", "error": "服务重启时这个任务还在进行，做到哪一步无法确认。", "acknowledgedAt": 400])
        XCTAssertTrue(task.isInterrupted)
        XCTAssertEqual(task.statusLabel, "Incomplete", "the status word stays")
        XCTAssertTrue(task.isUnread, "changed after it was read")
        let read = task.acknowledged(at: 600)
        XCTAssertFalse(read.isUnread)
        XCTAssertEqual(read.acknowledgedAt, 600)
        XCTAssertEqual(read.error, task.error, "everything else is kept")
        XCTAssertEqual(task.acknowledgedAt, 400, "the original is not changed")
        let old = try decode(AgentTask.self, ["id": "t", "createdAt": 1, "updatedAt": 5, "status": "done", "task": "x"])
        XCTAssertNil(old.acknowledgedAt)
        XCTAssertTrue(old.isUnread, "an older daemon without read marks: every ended task is unread")
        let running = try decode(AgentTask.self, ["id": "t", "createdAt": 1, "updatedAt": 5, "status": "running", "task": "x"])
        XCTAssertFalse(running.isUnread, "only ended tasks are unread")
    }

    func testWithdrawnAndInterruptedEventLines() {
        let withdrawn = TaskEvent(taskId: "t", seq: 1, ts: 0, type: "approval_resolved",
                                  payload: .object(["approvalId": .string("a"), "decision": .string("withdrawn"), "status": .string("withdrawn"), "by": .string("executor")]))
        XCTAssertEqual(EventDescriber.line(withdrawn), "已撤回（执行器已取消请求）")
        let interrupted = TaskEvent(taskId: "t", seq: 2, ts: 0, type: "blocked",
                                    payload: .object(["cause": .string("interrupted"), "error": .string("服务重启时这个任务还在进行，做到哪一步无法确认。")]))
        XCTAssertEqual(EventDescriber.line(interrupted), "未完成：服务重启时这个任务还在进行，做到哪一步无法确认。")
        XCTAssertEqual(EventDescriber.tone(interrupted), .muted, "a restart is not a failure of the task")
        XCTAssertEqual(try JSONDecoder().decode(ApprovalStatus.self, from: Data(#""withdrawn""#.utf8)), .withdrawn)
    }

    func testRoutes() async throws {
        let transport = FakeTransport { req, _ in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("GET", "/approvals/policy"): return (json(["policy": ["mode": "skip", "human": []], "categories": []]), httpResponse(req.url))
            case ("GET", "/settings/workdir"): return (json(["path": "/Users/me/AgentSwitch", "default": "/Users/me/AgentSwitch", "problem": NSNull()]), httpResponse(req.url))
            case ("GET", "/sessions"): return (json(["sessions": [["harness": "codex", "id": "x", "updatedAt": 1]]]), httpResponse(req.url))
            case ("GET", "/sessions/claude-code/abc"):
                return (json(["session": ["harness": "claude-code", "id": "abc", "updatedAt": 1], "messages": []]), httpResponse(req.url))
            case ("POST", "/tasks/t1/ack"): return (json(["ok": true, "task": ["acknowledgedAt": 1234]]), httpResponse(req.url))
            case ("GET", "/search"):
                return (json(["results": [["taskId": "t1", "title": "整理", "snippet": "把⟦下载⟧目录", "status": "done", "updatedAt": 9]]]), httpResponse(req.url))
            default: return (json(["error": "not found"]), httpResponse(req.url, status: 404))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let policy = try await api.approvalPolicy()
        XCTAssertEqual(policy.policy.mode, .skip)
        let workdir = try await api.workdir()
        XCTAssertEqual(workdir.path, "/Users/me/AgentSwitch")
        let sessions = try await api.sessions(limit: 60)
        XCTAssertEqual(sessions.map(\.sessionId), ["x"])
        let detail = try await api.session(harness: "claude-code", id: "abc", limit: 80)
        XCTAssertEqual(detail.session.sessionId, "abc")
        let acked = try await api.acknowledge(taskId: "t1")
        XCTAssertEqual(acked, 1234)
        let results = try await api.search(query: "下载 目录", limit: 30)
        XCTAssertEqual(results.first?.status, .done)
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" },
                       ["GET /approvals/policy", "GET /settings/workdir", "GET /sessions", "GET /sessions/claude-code/abc", "POST /tasks/t1/ack", "GET /search"])
        XCTAssertEqual(transport.requests[2].url?.query, "limit=60")
        XCTAssertEqual(transport.requests[3].url?.query, "limit=80")
        let searchQuery = URLComponents(url: try XCTUnwrap(transport.requests[5].url), resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(searchQuery, [URLQueryItem(name: "q", value: "下载 目录"), URLQueryItem(name: "limit", value: "30")])
        XCTAssertEqual(transport.requests[4].httpMethod, "POST")
    }

    func testAckWithAPlainOkReply() async throws {
        let transport = FakeTransport { req, _ in (json(["ok": true]), httpResponse(req.url)) }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let acked = try await api.acknowledge(taskId: "t1")
        XCTAssertNil(acked)
    }

    func testPathDisplay() {
        XCTAssertEqual(PathDisplay.short("/Users/me/Projects/AgentSwitch"), "~/Projects/AgentSwitch")
        XCTAssertEqual(PathDisplay.short("/Users/me"), "~")
        XCTAssertEqual(PathDisplay.short("/Users/me/"), "~")
        XCTAssertEqual(PathDisplay.short("/Users/Shared/x"), "/Users/Shared/x")
        XCTAssertEqual(PathDisplay.short("/opt/work"), "/opt/work")
        XCTAssertEqual(PathDisplay.short(""), "")
        XCTAssertEqual(PathDisplay.name("/Users/me/Projects/AgentSwitch"), "AgentSwitch")
    }
}
