import XCTest
@testable import AgentSwitchMacCore

/// The record's tasks (ported from the Kit's FeedTests and AttentionTests): order, live streams, loose approvals, event
/// tails, who needs you first, quiet tasks, the active-topics strip and the top bar's counts.
final class DispatchFeedTests: XCTestCase {
    private typealias F = DispatchFixture

    func testTimelineIsOldestFirstAndKeepsTheNewest() throws {
        let newestFirst = try [F.task("c", "done", created: 30), F.task("b", "done", created: 20), F.task("a", "done", created: 10)]
        XCTAssertEqual(DispatchFeed.timeline(newestFirst, limit: 10).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(DispatchFeed.timeline(newestFirst, limit: 2).map(\.id), ["b", "c"])
    }

    func testLiveStreamsGoToTheNewestActiveTasksOnly() throws {
        let tasks = try [F.task("a", "running", created: 10), F.task("b", "done", created: 20), F.task("c", "waiting_approval", created: 30),
                         F.task("d", "queued", created: 40), F.task("e", "routing", created: 50)]
        XCTAssertEqual(DispatchFeed.liveTaskIds(tasks, max: 3), ["e", "d", "c"])
        XCTAssertEqual(DispatchFeed.liveTaskIds(tasks, max: 10), ["e", "d", "c", "a"])
        XCTAssertEqual(DispatchFeed.liveTaskIds([try F.task("b", "failed")], max: 3), [])
    }

    func testLooseApprovalsAreThePendingOnesWithoutACard() throws {
        let approvals = try [F.approval("1", task: "a"), F.approval("2", task: "old"), F.approval("3", task: "old", status: "allowed")]
        XCTAssertEqual(DispatchFeed.looseApprovals(approvals, shown: ["a", "b"]).map(\.id), ["2"])
        XCTAssertEqual(DispatchFeed.pending(approvals, for: "a").map(\.id), ["1"])
        let record = DispatchFeed.record(messages: [], tasks: [try F.task("a", created: 1)], approvals: approvals)
        XCTAssertEqual(DispatchFeed.looseApprovals(approvals, record: record).map(\.id), ["2"])
        XCTAssertEqual(DispatchFeed.looseLabel(2), "2 Waiting")
    }

    func testTailKeepsTheLastMeaningfulLines() {
        var tail: [DispatchTaskEvent] = []
        for (i, type) in ["queued", "sealed", "thread", "routed", "dispatched", "text", "tool_call", "summary", "rated", "text", "done"].enumerated() {
            tail = DispatchEventTail.appending(F.event(Int64(i + 1), type), to: tail, keep: 3)
        }
        XCTAssertEqual(tail.map(\.type), ["text", "tool_call", "text"])
        XCTAssertFalse(DispatchEventTail.shows(F.event(1, "queued")))
        XCTAssertFalse(DispatchEventTail.shows(F.event(1, "failed")), "the end state is on the card itself")
        XCTAssertTrue(DispatchEventTail.shows(F.event(1, "approval_request")))
        XCTAssertFalse(DispatchEventTail.shows(F.event(1, "text", ["text": .string("  ")])), "blank text lines are dropped")
        let first = DispatchEventTail.appending(F.event(5, "text"), to: [], keep: 3)
        XCTAssertEqual(DispatchEventTail.appending(F.event(4, "text"), to: first, keep: 3).map(\.seq), [5], "older events never reorder the tail")
    }

    func testAttentionOrder() throws {
        let tasks = try [
            F.task("old-done-read", "done", updated: 50, extra: ["acknowledgedAt": 60]),
            F.task("running", "running", updated: 10),
            F.task("unread", "done", updated: 20),
            F.task("asking", "blocked", updated: 5, extra: ["blockCause": "question"]),
            F.task("pending-running", "running", updated: 1),
            F.task("waiting", "waiting_approval", updated: 3),
            F.task("failed-unread", "failed", updated: 30),
            F.task("queued", "queued", updated: 40),
        ]
        XCTAssertEqual(DispatchAttention.sorted(tasks, pending: ["pending-running"]).map(\.id),
                       ["asking", "waiting", "pending-running", "failed-unread", "unread", "queued", "running", "old-done-read"])
        XCTAssertEqual(DispatchAttention.rank(try F.task("x", "done", updated: 5, extra: ["acknowledgedAt": 5])), .rest, "read at the last change")
        XCTAssertEqual(DispatchAttention.rank(try F.task("x", "cancelled", updated: 5)), .unread, "any ended task can be unread")
        XCTAssertEqual(DispatchAttention.rank(try F.task("x", "done", updated: 5), readMarks: false), .rest, "a Mac without read marks")
    }

    func testQuietRunningTasksSayHowLong() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let running = try F.task("r", "running", updated: 10_000_000 - 30 * 60 * 1000)
        XCTAssertEqual(DispatchStaleness.minutes(running, lastEventAt: nil, now: now), 30)
        XCTAssertEqual(DispatchStaleness.minutes(running, lastEventAt: 10_000_000 - 12 * 60 * 1000, now: now), 12, "the latest event counts")
        XCTAssertNil(DispatchStaleness.minutes(running, lastEventAt: 10_000_000 - 9 * 60 * 1000, now: now), "under ten minutes")
        XCTAssertNil(DispatchStaleness.minutes(running, lastEventAt: nil, now: now, waiting: true), "a question waits for you, not the task")
        XCTAssertNil(DispatchStaleness.minutes(try F.task("q", "queued"), lastEventAt: nil, now: now), "queued waits its turn")
        XCTAssertEqual(DispatchStaleness.text(minutes: 14), "Quiet 14m")
        XCTAssertEqual(DispatchStaleness.text(minutes: 190), "Quiet 3h")
    }

    func testTheActiveTopicsStrip() throws {
        let now = Date(dispatchMilliseconds: 100_000_000)
        let threads = try F.decode([DispatchThread].self, object: [
            ["id": "th-run", "createdAt": 0, "updatedAt": 0, "title": "发布 AgentSwitch", "status": "open"],
            ["id": "th-ask", "createdAt": 0, "updatedAt": 0, "title": "清理磁盘", "status": "open"],
            ["id": "th-done", "createdAt": 0, "updatedAt": 0, "title": "整理下载", "status": "open"],
        ])
        let tasks = try [
            F.task("run", "running", created: 1, updated: 99_990_000, thread: "th-run", extra: ["model": "claude-opus-5-5", "harness": "claude-code"]),
            F.task("run-older", "running", created: 0, updated: 99_000_000, thread: "th-run"),
            F.task("ask", "running", created: 2, updated: 99_000_000, thread: "th-ask"),
            F.task("done", "done", created: 3, updated: 99_900_000, thread: "th-done"),
            F.task("stale-unread", "done", created: 4, updated: 1, thread: "th-old"),
            F.task("loose", "running", created: 5, updated: 99_000_000),
        ]
        let approvals = [try F.approval("q", task: "ask", kind: "question", action: "build/ 里有 3.2 GB 旧产物，要删掉吗？")]
        let items = DispatchActiveTopics.items(tasks: tasks, approvals: approvals, threads: threads, now: now)
        XCTAssertEqual(items.map(\.threadId), ["th-ask", "th-done", "th-run"], "waiting, then unread, then in progress; one chip per topic")
        XCTAssertTrue(items[0].waiting)
        XCTAssertEqual(items[0].question, "build/ 里有 3.2 GB 旧产物，要删掉吗？")
        XCTAssertEqual(items[0].stateLine(now: now), "Waiting")
        XCTAssertEqual(items[0].level, .warning)
        XCTAssertTrue(items[1].unread)
        XCTAssertTrue(items[1].opensTask, "an unread chip opens the task, which reads it")
        XCTAssertEqual(items[2].task.id, "run", "the most recently changed task stands for its topic")
        XCTAssertEqual(items[2].title, "发布 AgentSwitch")
        XCTAssertEqual(items[2].stateLine(now: now), "Busy · Opus 5.5")
        XCTAssertFalse(items[2].opensTask)
        let quiet = DispatchActiveTopics.items(tasks: [tasks[1]], approvals: [], threads: threads, now: now)
        XCTAssertEqual(quiet.first?.stateLine(now: now), "Busy · Quiet 16m")
        XCTAssertEqual(DispatchActiveTopics.items(tasks: tasks, approvals: approvals, threads: threads, readMarks: false, now: now).map(\.threadId),
                       ["th-ask", "th-run"], "without read marks nothing is unread")
    }

    func testTheTopBarCounts() throws {
        let tasks = try [F.task("a", "running"), F.task("b", "queued"), F.task("c", "waiting_approval"), F.task("d", "done")]
        let counts = DispatchCounts(tasks: tasks, approvals: [try F.approval("1", task: "c"), try F.approval("2", task: "x", status: "denied")])
        XCTAssertEqual(counts.busy, 2)
        XCTAssertEqual(counts.waiting, 1)
        XCTAssertEqual(counts.mark, .warning)
        XCTAssertEqual(DispatchCounts(tasks: [try F.task("a", "running")], approvals: []).mark, .busy)
        XCTAssertNil(DispatchCounts(tasks: [], approvals: []).mark)
    }
}
