import XCTest
@testable import AgentSwitchMacCore

/// The Dispatch page's models decode the daemon's real JSON and tolerate what a newer daemon adds (ported from the Kit's
/// ModelDecodingTests and ControlModelTests).
final class DispatchModelDecodingTests: XCTestCase {
    func testTask() throws {
        let t = try DispatchFixture.decode(DispatchTask.self, DispatchFixture.taskJSON)
        XCTAssertEqual(t.id, "t_8f3a2c1d")
        XCTAssertEqual(t.status, .running)
        XCTAssertTrue(t.status.isActive)
        XCTAssertEqual(t.targetLabel, "claude-code/sonnet")
        XCTAssertEqual(t.attachments.first?.path, "in/shot.png")
        XCTAssertEqual(t.attempts.first?.kind, "transport")
        XCTAssertEqual(t.created.timeIntervalSince1970, 1_790_000_000, accuracy: 0.001)
        XCTAssertTrue(t.ephemeral)
        XCTAssertEqual(t.who, "Claude Code · Sonnet")
        XCTAssertEqual(t.approvalModeTitle, "Default")
    }

    func testTaskDetailWithApprovals() throws {
        let d = try DispatchFixture.decode(DispatchTaskDetail.self, DispatchFixture.taskDetailJSON)
        XCTAssertEqual(d.task.status, .waitingApproval)
        XCTAssertEqual(d.task.statusLabel, "Waiting")
        XCTAssertEqual(d.task.spokenStatus, "等你处理")
        XCTAssertEqual(d.task.targetLabel, "opencode/deepseek-flash", "the pin shows when nothing ran yet")
        XCTAssertEqual(d.task.who, "OpenCode · DeepSeek Flash")
        XCTAssertEqual(d.task.approvalModeTitle, "Ask Each", "a task's own approval mode by its title")
        XCTAssertTrue(d.task.needsBrowser)
        XCTAssertEqual(d.approvals.count, 2)
        XCTAssertEqual(d.pending.count, 2)
        let question = try XCTUnwrap(d.approvals[0].questionEvidence)
        XCTAssertEqual(question.source, "router")
        XCTAssertEqual(question.questions.first?.id, "clarify")
        XCTAssertNil(d.approvals[1].questionEvidence)
        XCTAssertEqual(d.approvals[1].card, .approve(action: "bash: rm -rf build", details: #"{"command":"rm -rf build"}"#))
    }

    func testApprovalsListToleratesUnknownValues() throws {
        let list = try DispatchFixture.decode([DispatchApproval].self, DispatchFixture.approvalsJSON)
        XCTAssertEqual(list.count, 3)
        let questions = try XCTUnwrap(list[0].questionEvidence?.questions)
        XCTAssertEqual(questions.map(\.id), ["env", "pw"])
        XCTAssertEqual(questions[0].options.map(\.label), ["staging", "prod"])
        XCTAssertEqual(questions[0].options[1].description, "")
        XCTAssertTrue(questions[1].secret)
        XCTAssertEqual(questions[1].header, "")
        XCTAssertEqual(questions[1].placeholder, "直接输入，由 Mac 加密")
        XCTAssertEqual(list[2].kind, .other)
        XCTAssertEqual(list[2].status, .other)
        XCTAssertNil(list[0].questionEvidence?.oneTapOptions, "two questions need the form")
        XCTAssertEqual(list[0].card.title, "Question")
        XCTAssertEqual(list[1].card.title, "Approval")
    }

    func testAQuestionInAnUnknownFormatIsShownButNotAnswered() throws {
        let odd = try DispatchFixture.approval("a", task: "t", kind: "question", action: "选哪个？", evidence: "not json")
        XCTAssertEqual(odd.card, .unsupportedQuestion("选哪个？"))
        XCTAssertEqual(odd.waitingLine, "选哪个？")
    }

    func testTargetsAndPinOptions() throws {
        let targets = try DispatchFixture.decode(DispatchTargets.self, DispatchFixture.targetsJSON)
        XCTAssertEqual(targets.pinOptions.map(\.label), ["claude-code/opus", "claude-code/sonnet", "codex/gpt-5.5", "opencode/deepseek/deepseek-flash"],
                       "unavailable models and prefix/* wildcards cannot be pinned")
        XCTAssertEqual(targets.defaultTarget, DispatchTarget(harness: "claude-code", model: "sonnet"))
        XCTAssertEqual(targets.routerModel, DispatchTarget(harness: "opencode", model: "deepseek-flash"))
        XCTAssertEqual(targets.harnesses["codex"]?.maxConcurrent, 2)
        XCTAssertEqual(targets.harnesses["claude-code"]?.defaultModel, "sonnet")
        XCTAssertEqual(targets.quota["codex"], 0.42)
        XCTAssertEqual(DispatchTarget(harness: "claude-code", model: "claude-opus-5-5").displayName, "Opus 5.5 · Claude Code")
        XCTAssertEqual(DispatchTarget(harness: "codex", model: "gpt-6-luna").modelName, "GPT-6 Luna")
    }

    func testThreads() throws {
        let threads = try DispatchFixture.decode([DispatchThread].self, DispatchFixture.threadsJSON)
        XCTAssertEqual(threads.first?.lastTarget?.label, "claude-code/claude-sonnet-5")
        XCTAssertEqual(threads.first?.taskCount, 2)
        XCTAssertFalse(threads[0].isArchived)
        XCTAssertTrue(threads[1].isArchived)
        XCTAssertEqual(threads[1].displayTitle, "未命名话题")
        XCTAssertEqual(threads[1].summary?.goal, "删掉旧构建")
        let now = Date(dispatchMilliseconds: 1_790_000_500_000 + 5 * 60_000)
        XCTAssertEqual(threads[0].meta(now: now), "2 个任务 · Sonnet 5 · 5m ago")
    }

    func testThreadDetailSortsItsTasks() throws {
        let object: [String: Any] = ["id": "th", "createdAt": 1, "updatedAt": 2, "title": "T", "status": "open",
                                     "summary": ["title": "T", "goal": "目标", "progress": "进展"],
                                     "state": ["tasks": []], "events": [],
                                     "tasks": [["id": "b", "createdAt": 20, "updatedAt": 20, "status": "done", "task": "b"],
                                               ["id": "a", "createdAt": 10, "updatedAt": 10, "status": "done", "task": "a"]]]
        let detail = try DispatchFixture.decode(DispatchThreadDetail.self, object: object)
        XCTAssertEqual(detail.tasks.map(\.id), ["a", "b"])
        XCTAssertEqual(detail.summary?.progress, "进展")
        XCTAssertEqual(detail.thread.title, "T")
    }

    func testStatusVocabulary() {
        let all: [DispatchTaskStatus] = [.queued, .routing, .running, .waitingApproval, .done, .partial, .blocked, .failed, .cancelled]
        XCTAssertEqual(all.map(\.label), ["Queued", "Busy", "Busy", "Waiting", "Done", "Incomplete", "Incomplete", "Failed", "Cancelled"])
        XCTAssertEqual(all.map(\.level), [.off, .busy, .busy, .warning, .ok, .warning, .warning, .error, .off])
        XCTAssertEqual(DispatchTaskStatus(rawValue: "waiting_approval"), .waitingApproval)
        XCTAssertEqual(DispatchTaskStatus(rawValue: "brand_new").rawValue, "brand_new")
        XCTAssertEqual(["done", "partial", "blocked", "failed", "cancelled"].map { DispatchTaskStatus(rawValue: $0).isTerminal }, [true, true, true, true, true])
        XCTAssertFalse(DispatchTaskStatus.running.isTerminal)
        XCTAssertEqual(DispatchTaskStatus.done.spokenLabel, "已完成")
    }

    func testReadMarksAndInterruption() throws {
        let task = try DispatchFixture.task("t", "blocked", created: 1, updated: 500,
                                            extra: ["blockCause": "interrupted", "error": "服务重启", "acknowledgedAt": 400])
        XCTAssertTrue(task.isInterrupted)
        XCTAssertEqual(task.statusLabel, "Incomplete", "the status word stays")
        XCTAssertTrue(task.isUnread, "changed after it was read")
        let read = task.acknowledged(at: 600)
        XCTAssertFalse(read.isUnread)
        XCTAssertEqual(read.error, task.error, "everything else is kept")
        XCTAssertEqual(task.acknowledgedAt, 400, "the original is not changed")
        XCTAssertFalse(try DispatchFixture.task("r", "running", updated: 5).isUnread, "only ended tasks are unread")
        let asking = try DispatchFixture.task("q", "blocked", extra: ["blockCause": "question"])
        XCTAssertTrue(asking.waitsForYou)
        XCTAssertEqual(asking.statusLabel, "Waiting")
    }

    func testDeletedTasksUnlessTheyOnlyFellOffAFullList() throws {
        let before = try [DispatchFixture.task("a", "done", created: 30), DispatchFixture.task("b", "done", created: 20), DispatchFixture.task("c", "done", created: 10)]
        XCTAssertEqual(DispatchTask.deleted(from: before, in: [before[0], before[2]], limit: 50), ["b"])
        XCTAssertEqual(DispatchTask.deleted(from: [], in: before, limit: 50), [], "the first look")
        let full = try [DispatchFixture.task("n", created: 40), before[0], before[1]]
        XCTAssertEqual(DispatchTask.deleted(from: before, in: full, limit: 3), [], "c fell off the end of a full list")
    }

    func testMessagesTolerateMissingAndNewFields() throws {
        let m = try DispatchFixture.decode(DispatchMessage.self, #"{"seq":3,"ts":5,"role":"robot","text":"x","kind":"brand-new"}"#)
        XCTAssertEqual(m.role, .assistant, "an unknown role reads as the assistant's")
        XCTAssertEqual(m.kind, .other)
        XCTAssertEqual(m.taskIds, [])
        XCTAssertNil(m.clientId)
    }

    func testSearchResultsTolerateGaps() throws {
        let r = try DispatchFixture.decode(DispatchSearchResult.self, #"{"taskId":"t1","status":"later_status"}"#)
        XCTAssertEqual(r.title, "")
        XCTAssertEqual(r.status, .other("later_status"))
        XCTAssertEqual(r.updatedAt, 0)
    }

    func testSettingsShapes() throws {
        let doc = try DispatchFixture.decode(DispatchTextDocument.self, ##"{"path":"/h/context.md","text":"# 站点","warnings":["line 3"]}"##)
        XCTAssertEqual(doc.warnings, ["line 3"])
        let saved = try DispatchFixture.decode(DispatchSaveResult.self,
            #"{"path":"/x","warnings":["w"],"sealed":[{"label":"fin/pass","field":"账号密码","hosts":["fin.example.test"],"uses":["http"]}]}"#)
        XCTAssertEqual(saved.savedLine, "已保存，1 个凭据已加密（账号密码），部分行已移除")
        XCTAssertEqual(try DispatchFixture.decode(DispatchSaveResult.self, #"{"path":"/m","warnings":[]}"#).savedLine, "已保存")

        let memory = try DispatchFixture.decode(DispatchPlatformMemoryList.self, #"""
        {"records":[{"id":"pm1","origin":"https://fin.example.com","key":"login","text":"登录要短信验证码","kind":"incident","status":"verified",
          "source":{"taskId":"t9","eventSeq":12,"quote":"需要验证码"},"createdAt":1,"updatedAt":2,"expiresAt":1000}]}
        """#).records
        XCTAssertEqual(memory.first?.sourceTaskId, "t9")
        XCTAssertEqual(memory.first?.sourceEventSeq, 12)
        XCTAssertEqual(memory.first?.kindLabel, "临时事件")
        XCTAssertEqual(memory.first?.statusLabel, "已验证")
        XCTAssertEqual(memory.first?.isExpired(now: Date(timeIntervalSince1970: 2)), true)

        let mcp = try DispatchFixture.decode([DispatchMCPServer].self,
            #"[{"name":"github","kind":"stdio","command":"npx","args":["-y","@x/gh"],"env":{"TOKEN":"enc:v1:abc"},"headers":{},"enabled":true,"harnesses":["codex"],"approval":"allow","note":"GitHub"},{"name":"docs","kind":"http","url":"https://docs.example/mcp"}]"#)
        XCTAssertEqual(mcp[0].endpoint, "npx -y @x/gh")
        XCTAssertEqual(mcp[1].endpoint, "https://docs.example/mcp")
        XCTAssertEqual(mcp[1].harnesses, DispatchExtensionHarnesses.all, "the schema's defaults")
        XCTAssertFalse(mcp[0].toggled().enabled)
        XCTAssertTrue(mcp[0].enabled, "toggling makes a new value")

        let skill = try DispatchFixture.decode(DispatchSkillDetail.self, #"{"name":"pdf","description":"PDF","path":"/s/pdf","files":2,"enabled":false,"harnesses":["claude-code"],"content":"---\nname: pdf\n---"}"#)
        XCTAssertEqual(skill.skill.files, 2)
        XCTAssertFalse(skill.skill.enabled)
        XCTAssertTrue(skill.content.hasPrefix("---"))
        let found = try DispatchFixture.decode([DispatchDiscoveredSkill].self, #"[{"name":"pdf","description":"","path":"/u/.claude/skills/pdf","source":"~/.claude/skills","installed":true}]"#)
        XCTAssertTrue(found[0].installed)
    }

    func testRoutingLogRows() throws {
        let rows = try DispatchFixture.decode([DispatchRoutingLogEntry].self, #"""
        [{"id":7,"ts":1790000000000,"taskHash":"ab","taskId":"t1","cwd":"/w","source":"router","harness":"codex","model":"gpt-5.5","chosen":"router",
          "decision":"{\"reason\":\"代码改动\",\"harness\":\"codex\"}","notes":"","routerError":null,"routerMs":1234,"outcome":"done","rating":1},
         {"id":6,"ts":1,"taskHash":"cd","taskId":null,"cwd":"/w","source":"pin","harness":null,"model":null,"chosen":null,"decision":null,"notes":"x","routerError":"timeout","routerMs":0,"outcome":null,"rating":null}]
        """#)
        XCTAssertEqual(rows[0].reason, "代码改动")
        XCTAssertEqual(rows[0].routerTime, "1.2s")
        XCTAssertEqual(rows[0].target?.label, "codex/gpt-5.5")
        XCTAssertTrue(rows[0].decisionText?.contains("\n") == true, "pretty-printed")
        XCTAssertNil(rows[1].target)
        XCTAssertNil(rows[1].reason)
        XCTAssertNil(rows[1].routerTime)
        XCTAssertEqual(rows[1].routerError, "timeout")
    }

    func testRequestBodiesAreTheDaemonsShape() throws {
        let message = DispatchNewMessage(text: "整理", clientId: "client-0001", attachments: [], pin: DispatchTarget(harness: "codex", model: "gpt-5.5"))
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
        XCTAssertEqual(body["client_id"] as? String, "client-0001")
        XCTAssertNil(body["attachments"], "no empty lists on the wire")
        XCTAssertEqual((body["pin"] as? [String: String])?["model"], "gpt-5.5")
        XCTAssertEqual(message.staging(["u1"]).attachments, ["u1"])
        XCTAssertEqual(message.staging(["u1"]).clientId, "client-0001", "a resend keeps its client id")
        XCTAssertEqual(DispatchNewMessage.text(typed: "  ", hasAttachments: true), DispatchNewMessage.attachmentsOnlyText)
        XCTAssertNil(DispatchNewMessage.text(typed: " \n", hasAttachments: false))
        let a = DispatchNewMessage.newClientId(), b = DispatchNewMessage.newClientId()
        XCTAssertNotEqual(a, b)
        XCTAssertNotNil(a.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression))
        let server = DispatchMCPServer(name: "docs", kind: "http", url: "https://docs.example/mcp")
        let encoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(server)) as? [String: Any])
        XCTAssertNil(encoded["command"], "no null command for an http server")
        XCTAssertEqual(encoded["url"] as? String, "https://docs.example/mcp")
    }

    func testAnswerCheck() {
        let qs = [DispatchQuestion(id: "a", text: "A?"), DispatchQuestion(id: "b", text: "B?", options: [.init(label: "x"), .init(label: "y")], multi: true)]
        XCTAssertEqual(DispatchAnswerCheck.problem(questions: qs, answers: ["a": ["  "], "b": ["x"]]), "未回答：A?")
        XCTAssertNil(DispatchAnswerCheck.problem(questions: qs, answers: ["a": ["ok"], "b": ["x", "y"]]))
        XCTAssertEqual(DispatchAnswerCheck.problem(questions: [qs[0]], answers: ["a": ["1", "2"]]), "仅可选择一项：A?")
        XCTAssertNotNil(DispatchAnswerCheck.problem(questions: [qs[0]], answers: ["a": ["1"], "zz": ["2"]]))
        XCTAssertEqual(DispatchAnswerCheck.cleaned(["a": [" x ", ""]]), ["a": ["x"]])
    }

    func testTheQuestionFormPicksOneOrSeveralAndTypes() throws {
        let one = DispatchQuestion(id: "env", text: "哪个环境？", options: [.init(label: "staging"), .init(label: "prod")])
        let many = DispatchQuestion(id: "steps", text: "做哪些？", options: [.init(label: "a"), .init(label: "b")], multi: true)
        let free = DispatchQuestion(id: "note", text: "备注？")
        let evidence = DispatchQuestionEvidence(source: "executor", questions: [one, many, free])
        let empty = DispatchQuestionForm()
        XCTAssertEqual(empty.problem(for: evidence), "未回答：哪个环境？")
        let form = empty.toggling(one, "staging").toggling(one, "prod").toggling(many, "a").toggling(many, "b").typing(free, " 尽快 ")
        XCTAssertEqual(form.mark(one, "prod"), "<x>")
        XCTAssertEqual(form.mark(one, "staging"), "< >", "one of several: the second pick replaces the first")
        XCTAssertEqual(form.mark(many, "a"), "[x]")
        XCTAssertEqual(form.answers(for: evidence), ["env": ["prod"], "steps": ["a", "b"], "note": ["尽快"]])
        XCTAssertNil(form.problem(for: evidence))
        XCTAssertEqual(form.toggling(many, "a").answers(for: evidence)["steps"], ["b"], "a second click unpicks")
        XCTAssertEqual(empty.chosen, [:], "every change is a new form")
        XCTAssertEqual(DispatchQuestionEvidence(source: "router", questions: [one]).oneTapOptions, ["staging", "prod"])
        XCTAssertNil(DispatchQuestionEvidence(source: "router", questions: [free]).oneTapOptions)
    }
}
