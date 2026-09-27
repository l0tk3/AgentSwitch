import XCTest
@testable import AgentSwitchKit

/// control-v0 §4–§5 on the phone: who needs you first, quiet running tasks, folded tool calls, the time a task took,
/// and search snippets.
final class AttentionTests: XCTestCase {
    private func task(_ id: String, _ status: String, updated: Int64 = 1000, acked: Int64? = nil, cause: String? = nil,
                      created: Int64 = 0, text: String = "x", result: String? = nil) throws -> AgentTask {
        var object: [String: Any] = ["id": id, "createdAt": created, "updatedAt": updated, "status": status, "task": text]
        if let acked { object["acknowledgedAt"] = acked }
        if let cause { object["blockCause"] = cause }
        if let result { object["result"] = result }
        return try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func call(_ seq: Int64, _ tool: String, _ input: [String: String] = [:], denied: Bool = false) -> TaskEvent {
        var payload: [String: JSONValue] = ["tool": .string(tool), "id": .string("c\(seq)"), "input": .object(input.mapValues(JSONValue.string))]
        if denied { payload["denied"] = .string("protected") }
        return TaskEvent(taskId: "t", seq: seq, ts: seq * 1000, type: "tool_call", payload: .object(payload))
    }

    private func event(_ seq: Int64, _ type: String, ts: Int64? = nil) -> TaskEvent {
        TaskEvent(taskId: "t", seq: seq, ts: ts ?? seq * 1000, type: type, payload: .object(type == "text" ? ["text": .string("hi")] : [:]))
    }

    // MARK: - attention

    func testAttentionOrder() throws {
        let tasks = try [
            task("old-done-read", "done", updated: 50, acked: 60),
            task("running", "running", updated: 10),
            task("unread", "done", updated: 20),
            task("asking", "blocked", updated: 5, cause: "question"),
            task("pending-running", "running", updated: 1),
            task("waiting", "waiting_approval", updated: 3),
            task("failed-unread", "failed", updated: 30),
            task("queued", "queued", updated: 40),
        ]
        let sorted = Attention.sorted(tasks, pending: ["pending-running"]).map(\.id)
        XCTAssertEqual(sorted, ["asking", "waiting", "pending-running", "failed-unread", "unread", "queued", "running", "old-done-read"])
        XCTAssertEqual(Attention.rank(try task("x", "done", updated: 5, acked: 5)), .rest, "read at the last change")
        XCTAssertEqual(Attention.rank(try task("x", "cancelled", updated: 5)), .unread, "any ended task can be unread")
        XCTAssertEqual(Attention.rank(try task("x", "done", updated: 5), readMarks: false), .rest, "a Mac without read marks")
    }

    // MARK: - staleness

    func testQuietRunningTasksSayHowLong() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let running = try task("r", "running", updated: 10_000_000 - 30 * 60 * 1000)
        XCTAssertEqual(Staleness.minutes(running, lastEventAt: nil, now: now), 30)
        XCTAssertEqual(Staleness.minutes(running, lastEventAt: 10_000_000 - 12 * 60 * 1000, now: now), 12, "the latest event counts")
        XCTAssertNil(Staleness.minutes(running, lastEventAt: 10_000_000 - 9 * 60 * 1000, now: now), "under ten minutes")
        XCTAssertNil(Staleness.minutes(running, lastEventAt: nil, now: now, waiting: true), "a question waits for you, not the task")
        XCTAssertNil(Staleness.minutes(try task("q", "queued", updated: 0), lastEventAt: nil, now: now), "queued waits its turn")
        XCTAssertNil(Staleness.minutes(try task("d", "done", updated: 0), lastEventAt: nil, now: now))
        XCTAssertEqual(Staleness.text(minutes: 14), "14 分钟无更新")
        XCTAssertEqual(Staleness.text(minutes: 190), "3 小时无更新")
    }

    // MARK: - folding

    func testConsecutiveCallsFoldAndOthersBreakTheRun() {
        let events = [
            event(1, "dispatched"),
            call(2, "Read", ["file_path": "a.swift"]), TaskEvent(taskId: "t", seq: 3, ts: 3000, type: "tool_result", payload: .object(["id": .string("c2")])),
            call(4, "Bash", ["command": "ls"]),
            call(5, "Read", ["file_path": "b.swift"]),
            event(6, "text"),
            call(7, "Grep", ["pattern": "x"]),
            event(8, "text"),
            call(9, "Bash", ["command": "rm -rf ~/.agentswitch"], denied: true),
            call(10, "Bash", ["command": "git status"]),
            call(11, "Bash", ["command": "git diff"]),
        ]
        let items = ProcessFolding.items(events)
        XCTAssertEqual(items.map(\.id), ["t#1", "tools:t#2", "t#6", "t#7", "t#8", "t#9", "tools:t#10"])
        guard case .tools(let first) = items[1] else { return XCTFail("expected a fold") }
        XCTAssertEqual(first.map(\.seq), [2, 4, 5], "results are not rows and do not break a run")
        guard case .event(let lone) = items[3] else { return XCTFail("a lone call stays a line") }
        XCTAssertEqual(lone.seq, 7)
        guard case .event(let denied) = items[5] else { return XCTFail("a refused call is its own line") }
        XCTAssertEqual(denied.seq, 9)
    }

    func testSummarySentence() {
        let calls = [
            call(1, "Read", ["file_path": "a"]), call(2, "Read", ["file_path": "b"]), call(3, "Read", ["file_path": "a"]),
            call(4, "Read", ["file_path": "c"]),
            call(5, "Bash", ["command": "ls"]), call(6, "commandExecution", ["command": "/bin/zsh -lc 'ls'"]), call(7, "bash", ["command": "pwd"]),
            call(8, "Grep", ["pattern": "x"]), call(9, "Glob", ["pattern": "*.ts"]),
            call(10, "Edit", ["file_path": "a"]), call(11, "Write", ["file_path": "d"]),
            call(12, "mcp__playwright__browser_click", ["element": "登录"]),
            call(13, "TodoWrite"),
        ]
        XCTAssertEqual(ProcessFolding.summary(calls), "读取 3 个文件，运行 3 条命令，搜索 2 次，修改 2 个文件，浏览器操作 1 次，调用工具 1 次")
        XCTAssertEqual(ProcessFolding.summary(Array(calls[0..<2]) + [calls[4]], ongoing: true), "正在读取 2 个文件，运行 1 条命令")
        XCTAssertEqual(ProcessFolding.summary([call(1, "Read"), call(2, "Read")]), "读取 2 个文件", "no path: each call counts")
    }

    // MARK: - duration

    func testDuration() throws {
        let done = try task("t", "done", updated: 900_000, created: 0)
        let events = [event(1, "queued", ts: 10_000), event(2, "dispatched", ts: 12_000), event(3, "text", ts: 50_000), event(4, "done", ts: 143_000)]
        XCTAssertEqual(TaskDuration.seconds(done, events: events), 133)
        XCTAssertEqual(TaskDuration.text(133), "用时 2 分 13 秒")
        XCTAssertEqual(TaskDuration.seconds(done, events: []), 900, "no events: created to the last change")
        XCTAssertNil(TaskDuration.seconds(try task("t", "running"), events: events), "only once it ended")
        XCTAssertEqual(TaskDuration.text(0.2), "用时 1 秒")
        XCTAssertEqual(TaskDuration.text(45), "用时 45 秒")
        XCTAssertEqual(TaskDuration.text(120), "用时 2 分")
        XCTAssertEqual(TaskDuration.text(3900), "用时 1 小时 5 分")
        XCTAssertEqual(TaskDuration.text(7200), "用时 2 小时")
    }

    // MARK: - search

    func testSnippetMarksBecomeBoldRuns() {
        let parts = SearchSnippet.parts("…把⟦下载⟧目录里重复的⟦下载⟧文件")
        XCTAssertEqual(parts, [.init("…把", hit: false), .init("下载", hit: true), .init("目录里重复的", hit: false), .init("下载", hit: true), .init("文件", hit: false)])
        XCTAssertEqual(SearchSnippet.plain("a⟦b⟧c⟧d"), "abcd", "a stray close mark is dropped")
        XCTAssertEqual(SearchSnippet.parts("a⟦bc"), [.init("a", hit: false), .init("bc", hit: true)], "an unclosed mark runs to the end")
        XCTAssertEqual(SearchSnippet.parts(""), [])
        XCTAssertEqual(SearchSnippet.plain("登录 enc:v1:" + String(repeating: "A", count: 40)), "登录 🔒密文", "ciphertexts never show")
    }

    func testLocalSearchMarksHitsLikeTheDaemon() throws {
        let tasks = try [
            task("a", "done", updated: 10, text: "整理下载目录", result: "7 个重复文件移进了“重复”"),
            task("b", "failed", updated: 20, text: "登录财务平台", result: "登录页要短信验证码"),
            task("c", "done", updated: 30, text: "别的"),
        ]
        let hits = SearchSnippet.local(tasks, query: "登录")
        XCTAssertEqual(hits.map(\.taskId), ["b"])
        XCTAssertEqual(hits.first?.snippet, "⟦登录⟧页要短信验证码", "what came of it before the task text, which is the title")
        XCTAssertEqual(SearchSnippet.local(tasks, query: "财务").first?.snippet, "登录⟦财务⟧平台", "the task text when nothing else matches")
        XCTAssertEqual(SearchSnippet.local(tasks, query: "重复").first?.snippet, "7 个⟦重复⟧文件移进了“⟦重复⟧”", "the result is searched too")
        XCTAssertEqual(SearchSnippet.local(tasks, query: "  "), [])
        let long = String(repeating: "甲", count: 100) + "目标" + String(repeating: "乙", count: 100)
        let snippet = SearchSnippet.marked(long, query: "目标")
        XCTAssertTrue(snippet.hasPrefix("…") && snippet.hasSuffix("…"))
        XCTAssertTrue(snippet.contains("⟦目标⟧"))
    }
}
