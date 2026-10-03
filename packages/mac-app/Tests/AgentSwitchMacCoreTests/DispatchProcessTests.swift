import XCTest
@testable import AgentSwitchMacCore

/// The task page's process (control-v0 §5; ported from the Kit's AttentionTests folding part and EventDescriberTests):
/// folded tool calls, opened calls, the time a task took, one line per event.
final class DispatchProcessTests: XCTestCase {
    private typealias F = DispatchFixture

    private func event(_ type: String, _ payload: [String: Any]) throws -> DispatchTaskEvent {
        try F.decode(DispatchTaskEvent.self, object: ["taskId": "t", "seq": 1, "ts": 0, "type": type, "payload": payload])
    }

    func testConsecutiveCallsFoldAndOthersBreakTheRun() {
        let events = [
            F.event(1, "dispatched"),
            F.call(2, "Read", ["file_path": "a.swift"]), DispatchTaskEvent(taskId: "t", seq: 3, ts: 3000, type: "tool_result", payload: .object(["id": .string("c2")])),
            F.call(4, "Bash", ["command": "ls"]),
            F.call(5, "Read", ["file_path": "b.swift"]),
            F.event(6, "text"),
            F.call(7, "Grep", ["pattern": "x"]),
            F.event(8, "text"),
            F.call(9, "Bash", ["command": "rm -rf ~/.agentswitch"], denied: true),
            F.call(10, "Bash", ["command": "git status"]),
            F.call(11, "Bash", ["command": "git diff"]),
        ]
        let items = DispatchProcess.items(events)
        XCTAssertEqual(items.map(\.id), ["t#1", "tools:t#2", "t#6", "t#7", "t#8", "t#9", "tools:t#10"])
        guard case .tools(let first) = items[1] else { return XCTFail("expected a fold") }
        XCTAssertEqual(first.map(\.seq), [2, 4, 5], "results are not rows and do not break a run")
        guard case .event(let denied) = items[5] else { return XCTFail("a refused call is its own line") }
        XCTAssertEqual(denied.seq, 9)
        XCTAssertTrue(DispatchProcess.isOngoing(items[6], in: items, taskActive: true))
        XCTAssertFalse(DispatchProcess.isOngoing(items[6], in: items, taskActive: false))
        XCTAssertFalse(DispatchProcess.isOngoing(items[1], in: items, taskActive: true))
    }

    func testSummarySentence() {
        let calls = [
            F.call(1, "Read", ["file_path": "a"]), F.call(2, "Read", ["file_path": "b"]), F.call(3, "Read", ["file_path": "a"]),
            F.call(4, "Read", ["file_path": "c"]),
            F.call(5, "Bash", ["command": "ls"]), F.call(6, "commandExecution", ["command": "/bin/zsh -lc 'ls'"]), F.call(7, "bash", ["command": "pwd"]),
            F.call(8, "Grep", ["pattern": "x"]), F.call(9, "Glob", ["pattern": "*.ts"]),
            F.call(10, "Edit", ["file_path": "a"]), F.call(11, "Write", ["file_path": "d"]),
            F.call(12, "mcp__playwright__browser_click", ["element": "登录"]),
            F.call(13, "TodoWrite"),
        ]
        XCTAssertEqual(DispatchProcess.summary(calls), "读取 3 个文件，运行 3 条命令，搜索 2 次，修改 2 个文件，浏览器操作 1 次，调用工具 1 次")
        XCTAssertEqual(DispatchProcess.summary(Array(calls[0..<2]) + [calls[4]], ongoing: true), "正在读取 2 个文件，运行 1 条命令")
    }

    func testAnOpenedCallItsResultAndItsTime() {
        let call = F.call(2, "Bash", ["command": "npm test", "description": "run tests"])
        let ok = DispatchTaskEvent(taskId: "t", seq: 3, ts: 60_000, type: "tool_result",
                                   payload: .object(["id": .string("c2"), "ok": .bool(true), "output": .string("135 passed")]))
        let results = DispatchProcess.results([call, ok])
        let opened = DispatchToolCall(event: call, results: results)
        XCTAssertTrue(DispatchToolCall.opens(call))
        XCTAssertEqual(opened.line, "运行 npm test")
        XCTAssertEqual(opened.fields.map(\.name), ["Command", "About"], "what it runs first, keys as words")
        XCTAssertEqual(opened.outcome(taskActive: false).title, "Result")
        XCTAssertEqual(opened.outcome(taskActive: false).text, "135 passed")
        XCTAssertEqual(opened.level(taskActive: true), .ok)
        XCTAssertEqual(opened.duration, "58s")
        let failed = DispatchTaskEvent(taskId: "t", seq: 3, ts: 2_100, type: "tool_result",
                                       payload: .object(["id": .string("c2"), "ok": .bool(false), "output": .string("")]))
        let broken = DispatchToolCall(event: call, result: failed)
        XCTAssertTrue(broken.failed)
        XCTAssertEqual(broken.outcome(taskActive: false).title, "Result · Failed")
        XCTAssertEqual(broken.outcome(taskActive: false).text, "No Output")
        XCTAssertEqual(broken.level(taskActive: true), .error)
        XCTAssertEqual(broken.duration, "0.1s")
        XCTAssertEqual(DispatchProcess.failures([call], results: DispatchProcess.results([failed])), 1)
        let pending = DispatchToolCall(event: call, result: nil)
        XCTAssertEqual(pending.outcome(taskActive: true).text, "Busy")
        XCTAssertEqual(pending.level(taskActive: true), .busy)
        XCTAssertEqual(pending.level(taskActive: false), .off)
        XCTAssertFalse(DispatchToolCall.opens(F.call(9, "Bash", ["command": "x"], denied: true)))
    }

    func testDuration() throws {
        let done = try F.task("t", "done", created: 0, updated: 900_000)
        let events = [F.event(1, "queued", ts: 10_000), F.event(2, "dispatched", ts: 12_000), F.event(3, "text", ts: 50_000), F.event(4, "done", ts: 143_000)]
        XCTAssertEqual(DispatchTaskDuration.seconds(done, events: events), 133)
        XCTAssertEqual(DispatchTaskDuration.text(133), "用时 2 分 13 秒")
        XCTAssertEqual(DispatchTaskDuration.seconds(done, events: []), 900, "no events: created to the last change")
        XCTAssertNil(DispatchTaskDuration.seconds(try F.task("t", "running"), events: events), "only once it ended")
        XCTAssertEqual(DispatchTaskDuration.text(0.2), "用时 1 秒")
        XCTAssertEqual(DispatchTaskDuration.text(3900), "用时 1 小时 5 分")
        XCTAssertEqual(DispatchTaskDuration.line(done, events: events), "用时 2 分 13 秒")
        XCTAssertNil(DispatchTaskDuration.line(try F.task("i", "blocked", extra: ["blockCause": "interrupted"]), events: []),
                     "a restart's leftover did not finish then")
    }

    func testLines() throws {
        XCTAssertEqual(DispatchEventDescriber.line(try event("text", ["text": "hi"])), "hi")
        XCTAssertEqual(DispatchEventDescriber.line(try event("dispatched", ["harness": "codex", "model": "gpt-5.5", "effort": "high"])), "已交给 GPT-5.5 · Codex · high")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "bash", "command": "ls"])), "运行 ls")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "commandExecution", "command": "/bin/zsh -lc 'ps -Ao pid,pcpu -r | head -n 20'"])),
                       "运行 ps -Ao pid,pcpu -r | head -n 20")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "claude", "count": 1])), "调用工具")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "mcp__playwright__browser_click", "id": "t1", "input": ["element": "登录按钮", "ref": "e12"]])), "浏览器 · 点击 登录按钮")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "mcp__secret-gate__secret_fill", "input": ["ref": "e3"]])), "填入密文")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "Grep", "input": ["pattern": "TODO", "path": "src"]])), "搜索 src")
        XCTAssertEqual(DispatchEventDescriber.line(try event("tool_call", ["tool": "commandExecution", "denied": "denied by AgentSwitch: this path holds …"])), "已阻止：命令（受保护的目录）")
        XCTAssertEqual(DispatchEventDescriber.line(try event("supervisor", ["kind": "approval", "decision": "deny", "reason": "research step is read-only", "action": "Bash: top -l 1"])),
                       "已拒绝：top -l 1（只读步骤，不可执行此操作）")
        XCTAssertEqual(DispatchEventDescriber.line(try event("supervisor", ["kind": "approval", "decision": "ask_user", "reason": "reserved: delete, git_push", "source": "policy"])),
                       "交由你确认（保留类别：删除、git push）")
        XCTAssertEqual(DispatchEventDescriber.line(try event("supervisor", ["kind": "checkin", "action": "continue", "silentMs": 600_000])), "进度检查（600 秒无输出）：继续等待")
        XCTAssertEqual(DispatchEventDescriber.line(try event("approval_request", ["kind": "question", "source": "executor", "questions": [["text": "A?"], ["text": "B?"]]])), "提问：A?；B?")
        XCTAssertEqual(DispatchEventDescriber.line(try event("approval_resolved", ["decision": "deny", "kind": "approval", "by": "user"])), "已拒绝")
        XCTAssertEqual(DispatchEventDescriber.line(try event("approval_resolved", ["decision": "withdrawn", "status": "withdrawn", "by": "executor"])), "已撤回（执行器已取消请求）")
        XCTAssertEqual(DispatchEventDescriber.line(try event("step", ["n": 2, "action": "dispatch", "target": ["harness": "codex", "model": "m"]])), "第 2 步：交由 M · Codex 执行")
        XCTAssertEqual(DispatchEventDescriber.line(try event("waiting", ["for": "harness:codex"])), "等待 Codex 空闲")
        XCTAssertEqual(DispatchEventDescriber.line(try event("failed", ["error": "boom", "security": true])), "失败：boom（安全事件）")
        XCTAssertEqual(DispatchEventDescriber.line(try event("blocked", ["cause": "interrupted"])), "未完成：" + DispatchTask.interruptedText)
        XCTAssertEqual(DispatchEventDescriber.line(try event("brand_new", ["k": 1])), #"brand_new {"k":1}"#)
        XCTAssertEqual(DispatchEventDescriber.tone(try event("approval_request", [:])), .attention)
        XCTAssertEqual(DispatchEventDescriber.tone(try event("blocked", ["cause": "interrupted"])), .muted, "a restart is not a failure")
        XCTAssertTrue(DispatchProcess.isMarkdown(try event("done", [:])))
        XCTAssertFalse(DispatchProcess.isMarkdown(try event("tool_call", [:])))
    }

    func testPlannerLinesAndLocks() throws {
        let failure = try event("step", ["n": 0, "action": "plan", "source": "error", "stage": "initial_plan", "model": "claude-code/claude-opus-5-5",
                                         "routerError": "规划模型服务调用失败", "routerMs": 9409, "tries": 2, "failureKind": "service_error"])
        XCTAssertEqual(DispatchEventDescriber.line(failure), "初次规划已停止 · Opus 5.5 · 服务调用失败 · 耗时 9.4 秒 · 尝试 2 次\n原因：规划模型服务调用失败")
        XCTAssertEqual(DispatchEventDescriber.tone(failure), .failure)
        XCTAssertEqual(DispatchEventDescriber.line(try event("step", ["action": "intake", "sealingMs": 2379, "durationMs": 2390])), "已接收 · 加密敏感字段 2.4 秒")
        XCTAssertEqual(DispatchEventDescriber.line(try event("cleaned", ["workDirRemoved": true, "artifacts": 2])), "已清理临时目录，保留 2 个文件")
        let token = "enc:v1:" + String(repeating: "Q", count: 90)
        XCTAssertEqual(DispatchEventDescriber.line(try event("approval_resolved", ["decision": "answer", "text": "问 → 账号 \(token)"])), "已回答：问 → 账号 🔒密文")
        XCTAssertFalse(DispatchEventDescriber.line(try event("brand_new", ["v": token])).contains(token))
    }
}
