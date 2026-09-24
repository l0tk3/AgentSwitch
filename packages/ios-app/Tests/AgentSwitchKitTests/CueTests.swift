import XCTest
@testable import AgentSwitchKit

/// assistant-v0 §3: which moments get a sound — a task that ends (done / failed), a new question or approval — found by
/// comparing what the phone saw last with what it sees now. The first look only sets the baseline.
final class CueTests: XCTestCase {
    private func task(_ id: String, _ status: String, speech: String? = nil, thread: String? = nil) throws -> AgentTask {
        var object: [String: Any] = ["id": id, "createdAt": 1, "updatedAt": 1, "status": status, "task": "x"]
        if let speech { object["speech"] = speech }
        if let thread { object["threadId"] = thread }
        return try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func approval(_ id: String) throws -> Approval {
        let object: [String: Any] = ["id": id, "taskId": "t", "createdAt": 1, "kind": "question", "action": "要验证码", "evidence": "", "status": "pending"]
        return try JSONDecoder().decode(Approval.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testEndingsAfterTheBaseline() throws {
        var tracker = CueTracker()
        XCTAssertEqual(tracker.taskCues(try [task("a", "running"), task("b", "done")]), [], "the first look is the baseline")
        XCTAssertEqual(tracker.taskCues(try [task("a", "done"), task("b", "done"), task("c", "running")]), [TaskCue(taskId: "a", cue: .done)])
        XCTAssertEqual(tracker.taskCues(try [task("c", "failed")]), [TaskCue(taskId: "c", cue: .failed)])
        XCTAssertEqual(tracker.taskCues(try [task("d", "blocked")]), [], "a task first seen already ended is not news")
        XCTAssertEqual(tracker.taskCues(try [task("e", "running")]), [])
        XCTAssertEqual(tracker.taskCues(try [task("e", "cancelled")]), [], "you cancelled it yourself")
        XCTAssertEqual(tracker.taskCues(try [task("f", "running")]), [])
        XCTAssertEqual(tracker.taskCues(try [task("f", "partial")]), [TaskCue(taskId: "f", cue: .failed)])
    }

    func testNewApprovalsOnlyOnce() throws {
        var tracker = CueTracker()
        XCTAssertEqual(tracker.newApprovals(try [approval("1")]).map(\.id), [])
        XCTAssertEqual(tracker.newApprovals(try [approval("1"), approval("2")]).map(\.id), ["2"])
        XCTAssertEqual(tracker.newApprovals(try [approval("2")]).map(\.id), [])
    }

    func testScriptsThatArriveAfterTheEnd() throws {
        var tracker = CueTracker()
        _ = tracker.taskCues(try [task("a", "running")])
        _ = tracker.taskCues(try [task("a", "done")])
        XCTAssertEqual(tracker.newScripts(try [task("a", "done")]).map(\.id), [], "no script yet")
        XCTAssertEqual(tracker.newScripts(try [task("a", "done", speech: "做完了")]).map(\.id), ["a"])
        XCTAssertEqual(tracker.newScripts(try [task("a", "done", speech: "做完了")]).map(\.id), [], "read once")
        XCTAssertEqual(tracker.newScripts(try [task("old", "done", speech: "旧的")]).map(\.id), [], "only tasks that ended while watched")
    }

    func testThreadHueIsStable() {
        XCTAssertEqual(ThreadStyle.hue(for: "b5f95cec"), ThreadStyle.hue(for: "b5f95cec"))
        XCTAssertNotEqual(ThreadStyle.hue(for: "b5f95cec"), ThreadStyle.hue(for: "da3181fb"))
        XCTAssertTrue((0..<1).contains(ThreadStyle.hue(for: "x")))
    }

    func testThreadDetailCarriesTheSummary() throws {
        let object: [String: Any] = ["id": "t1", "createdAt": 1, "updatedAt": 2, "title": "登录 x.com", "status": "open", "taskCount": 2,
                                     "summary": ["title": "登录 x.com", "goal": "看通知", "progress": "已登录", "spoken": "已登录"], "tasks": []]
        let detail = try JSONDecoder().decode(ThreadDetail.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(detail.summary?.goal, "看通知")
        XCTAssertEqual(detail.summary?.progress, "已登录")
    }
}
