import XCTest
@testable import AgentSwitchKit

/// The home screen's log (app-v0 §5): order, which tasks get a live stream, loose approvals, event tails, and how a
/// sealed message reads.
final class FeedTests: XCTestCase {
    private func task(_ id: String, at created: Int64, _ status: String = "done", text: String = "x") throws -> AgentTask {
        let object: [String: Any] = ["id": id, "createdAt": created, "updatedAt": created, "status": status, "task": text]
        return try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A text event says something unless given a payload; other types get an empty one.
    private func event(_ type: String, seq: Int64, _ payload: JSONValue? = nil) -> TaskEvent {
        let fallback: JSONValue = type == "text" ? .object(["text": .string("line \(seq)")]) : .object([:])
        return TaskEvent(taskId: "t", seq: seq, ts: seq * 1000, type: type, payload: payload ?? fallback)
    }

    private func approval(_ id: String, task: String, status: String = "pending") throws -> Approval {
        let object: [String: Any] = ["id": id, "taskId": task, "createdAt": 1, "kind": "approval", "action": "a", "evidence": "", "status": status]
        return try JSONDecoder().decode(Approval.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testTimelineIsOldestFirstAndKeepsTheNewest() throws {
        let newestFirst = try [task("c", at: 30), task("b", at: 20), task("a", at: 10)]
        XCTAssertEqual(ActivityFeed.timeline(newestFirst, limit: 10).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(ActivityFeed.timeline(newestFirst, limit: 2).map(\.id), ["b", "c"])
        // The daemon's order is not trusted: created time decides.
        XCTAssertEqual(ActivityFeed.timeline(try [task("a", at: 10), task("c", at: 30), task("b", at: 20)], limit: 10).map(\.id), ["a", "b", "c"])
    }

    func testLiveStreamsGoToTheNewestActiveTasksOnly() throws {
        let tasks = try [task("a", at: 10, "running"), task("b", at: 20, "done"), task("c", at: 30, "waiting_approval"),
                         task("d", at: 40, "queued"), task("e", at: 50, "routing")]
        XCTAssertEqual(ActivityFeed.liveTaskIds(tasks, max: 3), ["e", "d", "c"])
        XCTAssertEqual(ActivityFeed.liveTaskIds(tasks, max: 10), ["e", "d", "c", "a"])
        XCTAssertEqual(ActivityFeed.liveTaskIds(try [task("b", at: 20, "failed")], max: 3), [])
    }

    func testLooseApprovalsAreThePendingOnesOutsideTheLog() throws {
        let approvals = try [approval("1", task: "a"), approval("2", task: "old"), approval("3", task: "old", status: "allowed")]
        XCTAssertEqual(ActivityFeed.looseApprovals(approvals, shown: ["a", "b"]).map(\.id), ["2"])
        XCTAssertEqual(ActivityFeed.pending(approvals, for: "a").map(\.id), ["1"])
    }

    func testTailKeepsTheLastMeaningfulLines() {
        var tail: [TaskEvent] = []
        for (i, type) in ["queued", "sealed", "thread", "routed", "dispatched", "text", "tool_call", "summary", "rated", "text", "done"].enumerated() {
            tail = EventTail.appending(event(type, seq: Int64(i + 1)), to: tail, keep: 3)
        }
        XCTAssertEqual(tail.map(\.type), ["text", "tool_call", "text"])
        XCTAssertFalse(EventTail.shows(event("queued", seq: 1)))
        XCTAssertFalse(EventTail.shows(event("failed", seq: 1)), "the end state is on the entry itself")
        XCTAssertTrue(EventTail.shows(event("approval_request", seq: 1)))
        XCTAssertTrue(EventTail.shows(event("attempt_failed", seq: 1)))
        XCTAssertFalse(EventTail.shows(event("text", seq: 1, .object(["text": .string("  ")]))), "blank text lines are dropped")
    }

    func testTailIgnoresAnEventItAlreadyHas() {
        let first = EventTail.appending(event("text", seq: 5), to: [], keep: 3)
        XCTAssertEqual(EventTail.appending(event("text", seq: 5), to: first, keep: 3).count, 1)
        XCTAssertEqual(EventTail.appending(event("text", seq: 4), to: first, keep: 3).map(\.seq), [5], "older events never reorder the tail")
    }

    func testSealedMessageReadsWithoutTheLegendOrLongTokens() {
        let token = "enc:v1:" + String(repeating: "A", count: 80) + "xyz789"
        let stored = "登录 https://fin.example.test 用 \(token) 查报表\n\n[AgentSwitch sealed the credentials in this message. The following field names …]\nCandidate record layout: password\n- \(token): password → fin.example.test"
        XCTAssertEqual(MessageDisplay.readable(stored), "登录 https://fin.example.test 用 🔒密文 查报表")
        XCTAssertEqual(MessageDisplay.readable("no secrets here"), "no secrets here")
        XCTAssertEqual(MessageDisplay.readable("\(token) \(token)"), "🔒密文 🔒密文")
        XCTAssertEqual(MessageDisplay.readable("enc:v1:short"), "enc:v1:short", "only real-looking tokens are shortened")
    }
}
