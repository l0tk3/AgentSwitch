import XCTest
@testable import AgentSwitchKit

/// control-v0's wire shapes and routes: default folder, coding sessions.
final class ControlModelTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
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

    func testRoutes() async throws {
        let transport = FakeTransport { req, _ in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("GET", "/settings/workdir"): return (json(["path": "/Users/me/AgentSwitch", "default": "/Users/me/AgentSwitch", "problem": NSNull()]), httpResponse(req.url))
            case ("GET", "/sessions"): return (json(["sessions": [["harness": "codex", "id": "x", "updatedAt": 1]]]), httpResponse(req.url))
            case ("GET", "/sessions/claude-code/abc"):
                return (json(["session": ["harness": "claude-code", "id": "abc", "updatedAt": 1], "messages": []]), httpResponse(req.url))
            default: return (json(["error": "not found"]), httpResponse(req.url, status: 404))
            }
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let workdir = try await api.workdir()
        XCTAssertEqual(workdir.path, "/Users/me/AgentSwitch")
        let sessions = try await api.sessions(limit: 60)
        XCTAssertEqual(sessions.map(\.sessionId), ["x"])
        let detail = try await api.session(harness: "claude-code", id: "abc", limit: 80)
        XCTAssertEqual(detail.session.sessionId, "abc")
        XCTAssertEqual(transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" },
                       ["GET /settings/workdir", "GET /sessions", "GET /sessions/claude-code/abc"])
        XCTAssertEqual(transport.requests[1].url?.query, "limit=60")
        XCTAssertEqual(transport.requests[2].url?.query, "limit=80")
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
