import AgentSwitchLive
import XCTest
@testable import AgentSwitchKit

/// The Live Activity's state (assistant-v0 §4): one summary of the tasks in progress, the one waiting for you first,
/// short texts, and the last conclusion when nothing runs; plus the link back to a task.
final class LiveSummaryTests: XCTestCase {
    private func task(_ id: String, _ status: String, created: Int64, updated: Int64? = nil, thread: String? = nil,
                      model: String? = nil, text: String = "整理下载目录", extra: [String: Any] = [:]) throws -> AgentTask {
        var object: [String: Any] = ["id": id, "createdAt": created, "updatedAt": updated ?? created, "status": status, "task": text]
        if let thread { object["threadId"] = thread }
        if let model { object["model"] = model; object["harness"] = "opencode" }
        object.merge(extra) { _, new in new }
        return try JSONDecoder().decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func approvals() throws -> [Approval] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "approvals", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([Approval].self, from: Data(contentsOf: url))
    }

    func testNothingInProgressIsNoState() throws {
        XCTAssertNil(LiveSummary.state(tasks: [try task("a", "done", created: 1)], approvals: [], threadTitles: [:]))
    }

    func testTheOneWaitingForYouLeadsThenTheNewestAtMostThree() throws {
        let tasks = try [
            task("old", "running", created: 1_000, thread: "th1", model: "deepseek/deepseek-flash"),
            task("t_x", "running", created: 2_000),                      // has the pending question in the fixture
            task("new", "routing", created: 3_000),
            task("newer", "queued", created: 4_000),
            task("gone", "done", created: 5_000),
        ]
        let state = try XCTUnwrap(LiveSummary.state(tasks: tasks, approvals: try approvals(), threadTitles: ["th1": "日报汇总"]))
        XCTAssertEqual(state.rows.map(\.id), ["t_x", "newer", "new"])
        XCTAssertEqual(state.waiting, 1)
        XCTAssertEqual(state.running, 3)
        XCTAssertEqual(state.phase, .needsYou)
        XCTAssertEqual(state.lead?.step, "部署到哪个环境？", "the question, not the approval's label (the status says it waits)")
        XCTAssertEqual(state.rows[1].step, "排队")
        let all = try XCTUnwrap(LiveSummary.state(tasks: tasks, approvals: [], threadTitles: ["th1": "日报汇总"]))
        XCTAssertEqual(all.phase, .running)
        XCTAssertEqual(all.rows.map(\.id), ["newer", "new", "t_x"])
        let old = try XCTUnwrap(LiveSummary.state(tasks: [tasks[0]], approvals: [], threadTitles: ["th1": "日报汇总"])?.lead)
        XCTAssertEqual(old.title, "日报汇总")
        XCTAssertEqual(old.model, "DeepSeek Flash")
    }

    func testTheStepIsTheLatestLineOfTheLiveTailAndTextsStayShort() throws {
        let long = String(repeating: "很长的任务描述", count: 20) + " enc:v1:" + String(repeating: "Q", count: 60)
        let running = try task("r", "running", created: 1, text: long)
        let events = [
            TaskEvent(taskId: "r", seq: 1, ts: 1, type: "dispatched", payload: .object(["harness": .string("claude-code"), "model": .string("claude-opus-5-5")])),
            TaskEvent(taskId: "r", seq: 2, ts: 2, type: "text", payload: .object(["text": .string("正在打开 x.com 的登录页\n然后填表")])),
        ]
        let row = try XCTUnwrap(LiveSummary.state(tasks: [running], approvals: [], threadTitles: [:], tails: ["r": events])?.lead)
        XCTAssertLessThanOrEqual(row.title.count, LiveSummary.titleChars)
        XCTAssertFalse(row.title.contains("enc:v1:"))
        XCTAssertFalse(row.step.contains("\n"))
        XCTAssertTrue(row.step.contains("x.com"), row.step)
        let size = try JSONEncoder().encode(LiveState(rows: Array(repeating: row, count: 3), running: 3, waiting: 0)).count
        XCTAssertLessThan(size, 4096, "ActivityKit keeps a state under 4 KB")
    }

    func testTheLastConclusionIsTheTaskThatEndedLast() throws {
        let tasks = try [
            task("a", "done", created: 1, updated: 10, extra: ["spoken": "下载目录整理好了。"]),
            task("b", "failed", created: 2, updated: 20, extra: ["error": "gate 代理连不上"]),
        ]
        let ended = try XCTUnwrap(LiveSummary.ended(tasks: tasks, threadTitles: [:]))
        XCTAssertEqual(ended.taskId, "b")
        XCTAssertFalse(ended.ok)
        XCTAssertEqual(ended.line, "gate 代理连不上")
        XCTAssertEqual(LiveState.finished(ended).phase, .ended)
    }

    func testStepsAreSaidInPlainWordsNotRawToolInputOrStateNames() throws {
        let t = try task("r", "running", created: 1)
        let e = { (type: String, payload: JSONValue) in TaskEvent(taskId: "r", seq: 1, ts: 1, type: type, payload: payload) }
        XCTAssertEqual(LiveSummary.step(t, nil, [e("tool_call", .object(["tool": .string("read"), "input": .object(["path": .string("/x/y")])]))]), "读取 /x/y")
        XCTAssertEqual(LiveSummary.step(t, nil, [e("tool_call", .object(["tool": .string("bash"), "input": .object(["command": .string("npm test")])]))]), "运行 npm test")
        XCTAssertEqual(LiveSummary.step(t, nil, [e("dispatched", .object(["harness": .string("claude-code"), "model": .string("claude-opus-5-5")]))]), "已交给 Opus 5.5")
        XCTAssertEqual(LiveSummary.step(t, nil, [e("text", .object(["text": .string("第一行\n第二行")])), e("supervisor", .object(["kind": .string("checkin")]))]), "第一行",
                       "a supervisor note says nothing to show: the line before it stays")
        XCTAssertEqual(LiveSummary.step(try task("q", "routing", created: 1), nil, []), "选择模型")
    }

    func testTaskLinksGoBothWaysAndOtherLinksAreNotTasks() throws {
        let url = LiveLink.task("7698f9b5")
        XCTAssertEqual(url.absoluteString, "agentswitch://task/7698f9b5")
        XCTAssertEqual(LiveLink.taskId(from: url), "7698f9b5")
        XCTAssertNil(LiveLink.taskId(from: try XCTUnwrap(URL(string: "agentswitch://pair?p=abc"))))
        XCTAssertNil(LiveLink.taskId(from: try XCTUnwrap(URL(string: "https://task/abc"))))
        XCTAssertNil(LiveLink.taskId(from: try XCTUnwrap(URL(string: "agentswitch://task/"))))
    }
}

final class ModelNameTests: XCTestCase {
    func testModelIdsAreSaidAsPeopleSayThem() {
        XCTAssertEqual(ModelName.display("claude-opus-5-5"), "Opus 5.5")
        XCTAssertEqual(ModelName.display("claude-opus-5-5[1m]"), "Opus 5.5 1M")
        XCTAssertEqual(ModelName.display("claude-sonnet-4-6"), "Sonnet 4.6")
        XCTAssertEqual(ModelName.display("claude-haiku-4-5-20251001"), "Haiku 4.5")
        XCTAssertEqual(ModelName.display("deepseek/deepseek-flash"), "DeepSeek Flash")
        XCTAssertEqual(ModelName.display("gpt-6-luna"), "GPT-6 Luna")
        XCTAssertEqual(ModelName.display("gpt-5.5"), "GPT-5.5")
        XCTAssertEqual(ModelName.harness("claude-code"), "Claude Code")
        XCTAssertEqual(ModelName.harness("opencode"), "OpenCode")
    }
}
