import XCTest
@testable import AgentSwitchKit

final class ModelDecodingTests: XCTestCase {
    func testTask() throws {
        let t = try Fixture.decode(AgentTask.self, "task.json")
        XCTAssertEqual(t.id, "t_8f3a2c1d")
        XCTAssertEqual(t.status, .running)
        XCTAssertTrue(t.status.isActive)
        XCTAssertEqual(t.targetLabel, "claude-code/sonnet")
        XCTAssertEqual(t.attachments?.first?.path, "in/shot.png")
        XCTAssertEqual(t.attempts?.first?.kind, "transport")
        XCTAssertEqual(t.created.timeIntervalSince1970, 1_790_000_000, accuracy: 0.001)
    }

    func testTaskDetailWithApprovals() throws {
        let d = try Fixture.decode(TaskDetail.self, "task_detail.json")
        XCTAssertEqual(d.task.status, .waitingApproval)
        XCTAssertEqual(d.task.statusLabel, "等待答复")
        XCTAssertEqual(d.task.targetLabel, "opencode/deepseek-flash", "pin shows when nothing ran yet")
        XCTAssertEqual(d.approvals.count, 2)
        let question = try XCTUnwrap(d.approvals[0].questionEvidence)
        XCTAssertEqual(question.source, "router")
        XCTAssertEqual(question.questions.first?.id, "clarify")
        XCTAssertNil(d.approvals[1].questionEvidence)
    }

    func testApprovalsListToleratesUnknownValues() throws {
        let list = try Fixture.decode([Approval].self, "approvals.json")
        XCTAssertEqual(list.count, 3)
        let questions = try XCTUnwrap(list[0].questionEvidence?.questions)
        XCTAssertEqual(questions.map(\.id), ["env", "pw"])
        XCTAssertEqual(questions[0].options.map(\.label), ["staging", "prod"])
        XCTAssertEqual(questions[0].options[1].description, "")
        XCTAssertTrue(questions[1].secret)
        XCTAssertEqual(questions[1].header, "")
        XCTAssertEqual(list[2].kind, .other)
        XCTAssertEqual(list[2].status, .other)
    }

    func testTargetsQuotaThreads() throws {
        let targets = try Fixture.decode(Targets.self, "targets.json")
        XCTAssertEqual(targets.pinOptions.map(\.label), ["claude-code/opus", "claude-code/sonnet", "codex/gpt-5.5"])
        XCTAssertEqual(targets.router?.defaultTarget, TargetRef(harness: "claude-code", model: "sonnet"))
        XCTAssertEqual(targets.harnesses["codex"]?.maxConcurrent, 2)
        XCTAssertEqual(targets.quota?["codex"], 0.42)

        let quota = try Fixture.decode([QuotaReading].self, "quota.json")
        XCTAssertEqual(quota.map(\.harness), ["codex", "claude-code"])
        XCTAssertNil(quota[1].remaining)
        XCTAssertEqual(quota[0].detail?["primary"]?["usedPercent"]?.int, 58)

        let threads = try Fixture.decode([AgentThread].self, "threads.json")
        XCTAssertEqual(threads.first?.lastTarget?.label, "claude-code/sonnet")
        XCTAssertEqual(threads.first?.taskCount, 2)
    }

    func testStatusVocabulary() {
        XCTAssertEqual(TaskStatus(rawValue: "waiting_approval"), .waitingApproval)
        XCTAssertEqual(TaskStatus(rawValue: "brand_new").rawValue, "brand_new")
        XCTAssertEqual(["done", "partial", "blocked", "failed", "cancelled"].map { TaskStatus(rawValue: $0).isTerminal }, [true, true, true, true, true])
        XCTAssertFalse(TaskStatus.running.isTerminal)
    }

    func testMeAcceptsIdOrDeviceId() throws {
        XCTAssertEqual(try JSONDecoder().decode(Me.self, from: Data(#"{"id":"d1","name":"iPhone"}"#.utf8)).deviceId, "d1")
        XCTAssertEqual(try JSONDecoder().decode(Me.self, from: Data(#"{"deviceId":"d2"}"#.utf8)).deviceId, "d2")
        XCTAssertNil(try JSONDecoder().decode(Me.self, from: Data("{}".utf8)).deviceId)
    }

    func testRequestBodiesAreSnakeCase() throws {
        let body = String(decoding: try JSONEncoder().encode(NewTaskRequest(task: "x", pin: TargetRef(harness: "codex", model: "gpt-5.5"), threadId: "th")), as: UTF8.self)
        XCTAssertTrue(body.contains(#""thread_id":"th""#))
        XCTAssertFalse(body.contains("parent_id"), "nil fields are omitted")
        let answer = String(decoding: try JSONEncoder().encode(AnswerRequest(approvalId: "a", answers: ["q": ["x"]])), as: UTF8.self)
        XCTAssertTrue(answer.contains(#""approval_id":"a""#))
    }

    func testAnswerCheck() {
        let qs = [UserQuestion(id: "a", text: "A?"), UserQuestion(id: "b", text: "B?", options: [.init(label: "x"), .init(label: "y")], multi: true)]
        XCTAssertEqual(AnswerCheck.problem(questions: qs, answers: ["a": ["  "], "b": ["x"]]), "还没回答：A?")
        XCTAssertNil(AnswerCheck.problem(questions: qs, answers: ["a": ["ok"], "b": ["x", "y"]]))
        XCTAssertEqual(AnswerCheck.problem(questions: [qs[0]], answers: ["a": ["1", "2"]]), "只能选一个：A?")
        XCTAssertNotNil(AnswerCheck.problem(questions: [qs[0]], answers: ["a": ["1"], "zz": ["2"]]))
        XCTAssertEqual(AnswerCheck.cleaned(["a": [" x ", ""]]), ["a": ["x"]])
    }
}

final class EventDescriberTests: XCTestCase {
    private func event(_ type: String, _ payload: [String: Any]) throws -> TaskEvent {
        let obj: [String: Any] = ["taskId": "t", "seq": 1, "ts": 0, "type": type, "payload": payload]
        return try JSONDecoder().decode(TaskEvent.self, from: json(obj))
    }

    func testLines() throws {
        XCTAssertEqual(EventDescriber.line(try event("text", ["text": "hi"])), "hi")
        XCTAssertEqual(EventDescriber.line(try event("dispatched", ["harness": "codex", "model": "gpt-5.5", "effort": "high"])), "派发 codex/gpt-5.5 effort=high")
        XCTAssertEqual(EventDescriber.line(try event("tool_call", ["tool": "bash", "command": "ls"])), "工具 bash: ls")
        XCTAssertEqual(EventDescriber.line(try event("approval_request", ["kind": "question", "source": "executor", "questions": [["text": "A?"], ["text": "B?"]]])), "执行者问你：A?；B?")
        XCTAssertEqual(EventDescriber.line(try event("approval_resolved", ["decision": "deny", "kind": "approval", "by": "user"])), "审批 → 拒绝（你）")
        XCTAssertEqual(EventDescriber.line(try event("step", ["n": 2, "action": "dispatch", "target": ["harness": "codex", "model": "m"]])), "第 2 步：派发 → codex/m")
        XCTAssertEqual(EventDescriber.line(try event("waiting", ["for": "harness:codex"])), "等待 codex 的空闲槽位")
        XCTAssertEqual(EventDescriber.line(try event("failed", ["error": "boom", "security": true])), "失败：boom [安全事件]")
        XCTAssertEqual(EventDescriber.line(try event("brand_new", ["k": 1])), #"brand_new {"k":1}"#)
        XCTAssertEqual(EventDescriber.tone(try event("approval_request", [:])), .attention)
    }

    /// The lines a real task produced on the phone (2026-09-24): planner failure, feedback receipt, intake, cleanup.
    func testLinesTheWebConsoleAlreadyHad() throws {
        let failure = try event("step", ["n": 0, "action": "plan", "source": "error", "stage": "initial_plan", "model": "claude-code/claude-opus-5-5",
                                         "routerError": "规划模型服务调用失败", "routerMs": 9409, "tries": 2, "failureKind": "service_error"])
        XCTAssertEqual(EventDescriber.line(failure), "初次规划已停止 · claude-code/claude-opus-5-5 · 服务调用失败 · 耗时 9.4 秒 · 尝试 2 次\n原因：规划模型服务调用失败")
        XCTAssertEqual(EventDescriber.tone(failure), .failure)
        XCTAssertEqual(EventDescriber.line(try event("feedback", ["version": 1, "source": "user", "status": "answered", "answers": ["clarify": ["x"]]])),
                       "反馈已记录（用户确认）· 已加入后续上下文")
        XCTAssertEqual(EventDescriber.line(try event("feedback", ["version": 2])), "反馈记录（格式待核对）")
        XCTAssertEqual(EventDescriber.line(try event("step", ["action": "intake", "sealingMs": 2379, "durationMs": 2390])), "消息接收完成 · 敏感字段识别与加密 2.4 秒")
        XCTAssertEqual(EventDescriber.line(try event("step", ["n": 0, "action": "plan", "model": "claude-code/m", "reason": "要多步"])), "多步任务，交给规划模型 claude-code/m：要多步")
        XCTAssertEqual(EventDescriber.line(try event("cleaned", ["workDirRemoved": true, "artifacts": 2])), "已清理临时目录（产物 2 个已保留）")
        XCTAssertEqual(EventDescriber.line(try event("checkpoint", ["purpose": "do", "ok": true])), "已保存步骤进展 · 执行 · 本步结束")
    }

    func testProviderSafetyResend() throws {
        let retry = try event("refusal", ["action": "retry", "reason": "provider_safety", "note": "x"])
        XCTAssertEqual(EventDescriber.line(retry), "服务商安全拦截：原样重发一次（新会话、同一模型）")
        XCTAssertEqual(EventDescriber.tone(retry), .muted)
        let stop = try event("refusal", ["action": "stop", "reason": "provider_safety", "note": "blocked again"])
        XCTAssertEqual(EventDescriber.line(stop), "服务商安全拦截：已停止 · blocked again")
        XCTAssertEqual(EventDescriber.tone(stop), .failure)
        XCTAssertEqual(EventDescriber.line(try event("redispatch", ["kind": "provider_safety", "target": ["harness": "claude-code", "model": "claude-sonnet-5"]])),
                       "原样重发 → claude-code/claude-sonnet-5")
    }

    func testCiphertextsInLinesShowAsLocks() throws {
        let token = "enc:v1:" + String(repeating: "Q", count: 90)
        let answered = try event("approval_resolved", ["decision": "answer", "text": "问 → 账号 \(token)\n  密码 \(token)"])
        XCTAssertEqual(EventDescriber.line(answered), "你答了：问 → 账号 🔒密文\n  密码 🔒密文")
        XCTAssertFalse(EventDescriber.line(try event("brand_new", ["v": token])).contains(token))
    }
}
