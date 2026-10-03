import XCTest
@testable import AgentSwitchMacCore

/// The record as a conversation with the assistant (assistant-v0 §1.1; ported from the Kit's ConversationTests): how
/// messages and tasks merge into one timeline, the log the page holds, entries as deletes take them.
final class DispatchConversationTests: XCTestCase {
    private typealias F = DispatchFixture

    func testReportsAreUnpromptedAndLinkTheirTask() throws {
        let notice = try F.message(7, "assistant", "「整理下载目录」完成了", kind: "notice", tasks: ["t1"])
        let progress = try F.message(8, "assistant", "还在进行", kind: "progress", tasks: ["t1"])
        let watch = try F.message(9, "assistant", "每 10 分钟告诉你", kind: "watch", tasks: ["t1"])
        XCTAssertEqual([notice.kind, progress.kind, watch.kind], [.notice, .progress, .watch])
        XCTAssertEqual([notice.unprompted, progress.unprompted, watch.unprompted], [true, true, false])
        let other = try F.message(6, "user", "另一件事", kind: "message", ts: 3000)
        let items = DispatchConversation.timeline(messages: [other, notice], tasks: [try F.task("t1", created: 1)])
        XCTAssertEqual(items.map(\.id), ["task-t1", "m6", "m7"], "a report does not own the task: the task stays where it was made")
        XCTAssertEqual(items[2].mentions, ["t1"])
    }

    func testTimelinePutsTasksUnderTheReplyThatMadeThem() throws {
        let messages = try [
            F.message(1, "user", "整理下载目录", kind: "message", ts: 1000),
            F.message(2, "assistant", "收到。", kind: "task", tasks: ["t1"], ts: 1100),
            F.message(3, "user", "刚才那个怎么样了", kind: "message", ts: 5000),
            F.message(4, "assistant", "还在跑。", kind: "status", tasks: ["t1"], ts: 5100),
        ]
        let tasks = try [F.task("t1", created: 1050), F.task("web", created: 3000)]
        let items = DispatchConversation.timeline(messages: messages, tasks: tasks)
        XCTAssertEqual(items.map(\.id), ["m1", "m2", "task-web", "m3", "m4"])
        guard case .assistant(let reply, let made) = items[1] else { return XCTFail("\(items[1])") }
        XCTAssertEqual(reply.seq, 2)
        XCTAssertEqual(made.map(\.id), ["t1"], "the created task hangs under its reply")
        guard case .assistant(_, let mentioned) = items[4] else { return XCTFail() }
        XCTAssertEqual(mentioned, [], "a status answer only mentions tasks, it does not own them")
        XCTAssertEqual(items[4].mentions, ["t1"])
        XCTAssertEqual(DispatchFeed.shownTaskIds(items), ["t1", "web"])
    }

    func testATasksEndRightUnderItsCardIsNotSaidAgain() throws {
        let m = { (seq: Int, role: String, kind: String, tasks: [String], ts: Int64) in
            try F.message(seq, role, kind: kind, tasks: tasks, ts: ts)
        }
        let messages = try [
            m(1, "user", "message", [], 1000), m(2, "assistant", "task", ["a"], 1100), m(3, "assistant", "task", ["b"], 1200),
            m(4, "assistant", "notice", ["a"], 2000),                     // b's card is between: said
            m(5, "assistant", "notice", ["b"], 2100),                     // right under b's card, only a's end line between: left out
            m(6, "user", "message", [], 3000), m(7, "assistant", "reply", [], 3100),
            m(8, "assistant", "notice", ["loose"], 4000),                  // the loose task's card is further up
            m(9, "assistant", "notice", ["gone"], 4100),                   // no card here: said
        ]
        let items = DispatchConversation.timeline(messages: messages, tasks: try [F.task("a", created: 1050), F.task("b", created: 1150), F.task("loose", created: 2500)])
        XCTAssertEqual(items.map(\.id), ["m1", "m2", "m3", "m4", "task-loose", "m6", "m7", "m8", "m9"])
    }

    func testTimelineKeepsTheNewestItems() throws {
        let messages = try (1...50).map { try F.message($0, $0 % 2 == 1 ? "user" : "assistant") }
        XCTAssertEqual(DispatchConversation.timeline(messages: messages, tasks: [], limit: 10).map(\.id).first, "m41")
    }

    func testAWaitingLineStaysOutWhileItsQuestionIsOpen() throws {
        let messages = try [
            F.message(1, "user", kind: "message", ts: 1000),
            F.message(2, "assistant", kind: "task", tasks: ["a"], ts: 1100),
            F.message(3, "assistant", "等你回答：用哪个账号？", kind: "waiting", tasks: ["a"], ts: 2000),
        ]
        let tasks = [try F.task("a", "waiting_approval", created: 1050)]
        let open = [try F.approval("q1", task: "a", kind: "question")]
        XCTAssertEqual(DispatchFeed.record(messages: messages, tasks: tasks, approvals: open).map(\.id), ["m1", "m2"],
                       "the question is in the card: the line would say it twice")
        let answered = [try F.approval("q1", task: "a", kind: "question", status: "allowed")]
        XCTAssertEqual(DispatchFeed.record(messages: messages, tasks: tasks, approvals: answered).map(\.id), ["m1", "m2", "m3"],
                       "once answered it is history")
    }

    func testDayHeadersMarkTheFirstItemOfEachDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)   // 2026-09-21 14:13 UTC
        let yesterday = Int64((now.timeIntervalSince1970 - 86_400) * 1000)
        let today = Int64(now.timeIntervalSince1970 * 1000) - 60_000
        let items = DispatchConversation.timeline(messages: try [
            F.message(1, "user", kind: "message", ts: yesterday), F.message(2, "assistant", ts: yesterday + 1),
            F.message(3, "user", kind: "message", ts: today), F.message(4, "assistant", ts: today + 1),
        ], tasks: [])
        XCTAssertEqual(DispatchConversation.dayHeaders(items, now: now, calendar: calendar), ["m1": "Yesterday", "m3": "Today"])
    }

    func testAssistantLines() throws {
        let tasks = try [F.task("a", "done", created: 1, updated: 9), F.task("b", "running", created: 2)]
        let approvals = [try F.approval("q", task: "b", kind: "question")]
        let end = DispatchAssistantLine(message: try F.message(5, "assistant", kind: "notice", tasks: ["a"]), created: [], tasks: tasks, approvals: approvals)
        XCTAssertEqual(end.endedTask?.id, "a", "an end further down: one line that opens the task")
        XCTAssertEqual(end.dot, .ok)
        let waiting = DispatchAssistantLine(message: try F.message(6, "assistant", kind: "progress", tasks: ["b"]), created: [], tasks: tasks, approvals: approvals)
        XCTAssertEqual(waiting.dot, .warning, "its task waits for you")
        XCTAssertNil(waiting.endedTask)
        let status = DispatchAssistantLine(message: try F.message(7, "assistant", kind: "status", tasks: ["a", "zz"]), created: [], tasks: tasks, approvals: [])
        XCTAssertEqual(status.mentioned.map(\.id), ["a"], "tasks it talks about, the known ones")
        XCTAssertNil(status.dot, "a plain answer has no square")
        XCTAssertTrue(status.isAnswer)
        let unknown = DispatchAssistantLine(message: try F.message(8, "assistant", kind: "notice", tasks: ["gone"]), created: [], tasks: tasks, approvals: [])
        XCTAssertNil(unknown.endedTask)
        XCTAssertEqual(unknown.dot, .off)
    }

    func testTheLogHoldsEachMessageOnceInOrderAndOnlyTheNewest() throws {
        let m = { (seq: Int) in try F.message(seq, seq % 2 == 1 ? "user" : "assistant") }
        let log = DispatchConversationLog(try [m(3), m(1)], keep: 3)
        let merged = log.merging(try [m(2), m(3), m(4)])
        XCTAssertEqual(merged.messages.map(\.seq), [2, 3, 4], "sorted, de-duplicated, the newest three")
        XCTAssertEqual(log.messages.map(\.seq), [1, 3], "merging leaves the original as it was")
        XCTAssertEqual(merged.lastSeq, 4)
        XCTAssertEqual(DispatchConversationLog().lastSeq, 0)
    }

    func testAnEntryIsAMessageWithItsAnswersOrOneLineOnItsOwn() throws {
        let log = DispatchConversationLog(try [
            F.message(1, "user", kind: "message"), F.message(2, "assistant", kind: "task", tasks: ["a"], replyTo: 1),
            F.message(3, "assistant", kind: "notice", tasks: ["a"]),
            F.message(4, "user", kind: "message"), F.message(5, "assistant", kind: "status", tasks: ["a"], replyTo: 4),
        ])
        XCTAssertEqual(log.entry(of: log.messages[0]), DispatchConversationEntry(seq: 1, seqs: [1, 2], exchange: true, createdTaskIds: ["a"]))
        XCTAssertEqual(log.entry(of: log.messages[1]).seqs, [1, 2], "the answer takes its question along")
        XCTAssertEqual(log.entry(of: log.messages[2]), DispatchConversationEntry(seq: 3, seqs: [3], exchange: false, createdTaskIds: []),
                       "a notice is one line and deletes no task")
        XCTAssertEqual(log.entry(of: log.messages[4]).createdTaskIds, [], "a status answer only names the task")
        XCTAssertEqual(log.removing([1, 2]).messages.map(\.seq), [3, 4, 5])
    }

    func testALostAnswerIsFoundByTheClientIdAndNewRepliesAreSingledOut() throws {
        let sent = try F.message(5, "user", "整理下载目录", kind: "message", clientId: "client-0001")
        let answer = try F.message(6, "assistant", "收到。", kind: "task", tasks: ["t1"])
        let log = DispatchConversationLog().merging([sent])
        XCTAssertTrue(log.contains(clientId: "client-0001"))
        XCTAssertFalse(log.contains(clientId: "client-0002"))
        XCTAssertEqual(log.newAssistantMessages(in: [sent, answer]).map(\.seq), [6], "the user's own message is not read back")
        XCTAssertEqual(log.merging([answer]).newAssistantMessages(in: [answer]), [])
    }

    func testRightClickMenusMatchThePhone() throws {
        let running = try F.task("r", "running", thread: "th")
        XCTAssertEqual(DispatchMenuItem.task(running).map(\.title), ["Open", "Topic", "Delete"])
        XCTAssertFalse(DispatchMenuItem.task(running).last!.isEnabled, "a running task cannot be deleted")
        let done = try F.task("d", "done")
        XCTAssertEqual(DispatchMenuItem.task(done, speaking: true).map(\.title), ["Open", "Stop", "Delete"])
        XCTAssertEqual(DispatchMenuItem.userMessage.map(\.symbol), ["doc.on.doc", "trash"])
        XCTAssertEqual(DispatchMenuItem.assistantMessage().map(\.title), ["Read Aloud", "Copy", "Delete"])
        XCTAssertTrue(DispatchMenuItem.delete(enabled: true).isDestructive)
    }
}
