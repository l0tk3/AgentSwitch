package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.*

class ModelDecodingTests {
    @Test
    fun task() {
        val t = Fixture.decode(AgentTask.serializer(), "task.json")
        assertEquals("t_8f3a2c1d", t.id)
        assertEquals(TaskStatus.Running, t.status)
        assertTrue(t.status.isActive)
        assertEquals("claude-code/sonnet", t.targetLabel)
        assertEquals("in/shot.png", t.attachments?.first()?.path)
        assertEquals("transport", t.attempts?.first()?.kind)
        assertEquals(1_790_000_000.0, t.created.timeIntervalSince1970(), 0.001)
    }

    @Test
    fun taskDetailWithApprovals() {
        val d = Fixture.decode(TaskDetail.serializer(), "task_detail.json")
        assertEquals(TaskStatus.WaitingApproval, d.task.status)
        assertEquals("Waiting", d.task.statusLabel)
        assertEquals("等你处理", d.task.spokenStatus)
        assertEquals("opencode/deepseek-flash", d.task.targetLabel, "pin shows when nothing ran yet")
        assertEquals(2, d.approvals.size)
        val question = assertNotNull(d.approvals[0].questionEvidence)
        assertEquals("router", question.source)
        assertEquals("clarify", question.questions.first().id)
        assertNull(d.approvals[1].questionEvidence)
    }

    @Test
    fun approvalsListToleratesUnknownValues() {
        val list = Fixture.decode(ListSerializer(Approval.serializer()), "approvals.json")
        assertEquals(3, list.size)
        val questions = assertNotNull(list[0].questionEvidence?.questions)
        assertEquals(listOf("env", "pw"), questions.map { it.id })
        assertEquals(listOf("staging", "prod"), questions[0].options.map { it.label })
        assertEquals("", questions[0].options[1].description)
        assertTrue(questions[1].secret)
        assertEquals("", questions[1].header)
        assertEquals(ApprovalKind.Other, list[2].kind)
        assertEquals(ApprovalStatus.Other, list[2].status)
    }

    @Test
    fun targetsQuotaThreads() {
        val targets = Fixture.decode(Targets.serializer(), "targets.json")
        assertEquals(listOf("claude-code/opus", "claude-code/sonnet", "codex/gpt-5.5"), targets.pinOptions.map { it.label })
        assertEquals(TargetRef(harness = "claude-code", model = "sonnet"), targets.router?.defaultTarget)
        assertEquals(2, targets.harnesses["codex"]?.maxConcurrent)
        assertEquals(0.42, targets.quota?.get("codex"))

        val quota = Fixture.decode(ListSerializer(QuotaReading.serializer()), "quota.json")
        assertEquals(listOf("codex", "claude-code"), quota.map { it.harness })
        assertNull(quota[1].remaining)
        assertEquals(58, quota[0].detail?.get("primary")?.get("usedPercent")?.int)

        val threads = Fixture.decode(ListSerializer(AgentThread.serializer()), "threads.json")
        assertEquals("claude-code/sonnet", threads.first().lastTarget?.label)
        assertEquals(2, threads.first().taskCount)
    }

    @Test
    fun statusVocabulary() {
        assertEquals(TaskStatus.WaitingApproval, TaskStatus("waiting_approval"))
        assertEquals("brand_new", TaskStatus("brand_new").rawValue)
        assertEquals(listOf(true, true, true, true, true), listOf("done", "partial", "blocked", "failed", "cancelled").map { TaskStatus(it).isTerminal })
        assertFalse(TaskStatus.Running.isTerminal)
    }

    /** The words on screen in Apple's title case (docs/ui-v0.md §7.2.7, 2026-10-01); read aloud in Chinese. */
    @Test
    fun statusWordsInTitleCase() {
        val all = listOf(TaskStatus.Queued, TaskStatus.Routing, TaskStatus.Running, TaskStatus.WaitingApproval, TaskStatus.Done,
            TaskStatus.Partial, TaskStatus.Blocked, TaskStatus.Failed, TaskStatus.Cancelled)
        assertEquals(listOf("Queued", "Busy", "Busy", "Waiting", "Done", "Incomplete", "Incomplete", "Failed", "Cancelled"), all.map { it.label })
        assertEquals("已完成", TaskStatus.Done.spokenLabel)
        assertEquals(listOf("Busy", "Waiting", "Idle", "Exited"), listOf(TerminalStatus.Working, TerminalStatus.Waiting, TerminalStatus.Idle, TerminalStatus.Exited).map { it.label })
        assertEquals(listOf("Ask Each", "Auto", "All Auto", "Bypass"), listOf(PermissionMode.Manual, PermissionMode.Scoped, PermissionMode.Auto, PermissionMode.Skip).map { it.label })
    }

    @Test
    fun meAcceptsIdOrDeviceId() {
        assertEquals("d1", KitJson.decodeFromString(Me.serializer(), """{"id":"d1","name":"iPhone"}""").deviceId)
        assertEquals("d2", KitJson.decodeFromString(Me.serializer(), """{"deviceId":"d2"}""").deviceId)
        assertNull(KitJson.decodeFromString(Me.serializer(), "{}").deviceId)
    }

    @Test
    fun requestBodiesAreSnakeCase() {
        val body = KitJson.encodeToString(NewTaskRequest.serializer(), NewTaskRequest(task = "x", pin = TargetRef(harness = "codex", model = "gpt-5.5"), threadId = "th"))
        assertTrue(body.contains(""""thread_id":"th""""))
        assertFalse(body.contains("parent_id"), "nil fields are omitted")
        val answer = KitJson.encodeToString(AnswerRequest.serializer(), AnswerRequest(approvalId = "a", answers = mapOf("q" to listOf("x"))))
        assertTrue(answer.contains(""""approval_id":"a""""))
    }

    @Test
    fun answerCheck() {
        val qs = listOf(UserQuestion(id = "a", text = "A?"),
            UserQuestion(id = "b", text = "B?", options = listOf(UserQuestion.Option("x"), UserQuestion.Option("y")), multi = true))
        assertEquals("未回答：A?", AnswerCheck.problem(qs, mapOf("a" to listOf("  "), "b" to listOf("x"))))
        assertNull(AnswerCheck.problem(qs, mapOf("a" to listOf("ok"), "b" to listOf("x", "y"))))
        assertEquals("仅可选择一项：A?", AnswerCheck.problem(listOf(qs[0]), mapOf("a" to listOf("1", "2"))))
        assertNotNull(AnswerCheck.problem(listOf(qs[0]), mapOf("a" to listOf("1"), "zz" to listOf("2"))))
        assertEquals(mapOf("a" to listOf("x")), AnswerCheck.cleaned(mapOf("a" to listOf(" x ", ""))))
    }

    // Not in the Swift tests: the pieces of this slice the Swift cases only reach through the API.

    @Test
    fun modelNamesAndTheTableOfBrands() {
        assertEquals("Opus 5.5", com.agentswitch.kit.feed.ModelName.display("claude-opus-5-5"))
        assertEquals("Opus 5.5 1M", com.agentswitch.kit.feed.ModelName.display("claude-opus-5-5[1m]"))
        assertEquals("Sonnet 5", com.agentswitch.kit.feed.ModelName.display("claude-sonnet-5-20260101"))
        assertEquals("DeepSeek Flash", com.agentswitch.kit.feed.ModelName.display("deepseek/deepseek-flash"))
        assertEquals("GPT-6 Luna", com.agentswitch.kit.feed.ModelName.display("gpt-6-luna"))
        assertEquals("GPT-5.5", com.agentswitch.kit.feed.ModelName.display("gpt-5.5"))
        assertEquals("Claude Code", com.agentswitch.kit.feed.ModelName.harness("claude-code"))
        assertEquals("Opus 5.5 · Claude Code", with(com.agentswitch.kit.feed.ModelName) { TargetRef("claude-code", "claude-opus-5-5").let { "${display(it.model)} · ${harness(it.harness)}" } })
    }

    @Test
    fun unknownStatusRoundTrips() {
        val t = KitJson.decodeFromString(AgentTask.serializer(), """{"id":"i","createdAt":1,"updatedAt":2,"status":"hovering","task":"x"}""")
        assertEquals(TaskStatus.Other("hovering"), t.status)
        assertTrue(KitJson.encodeToString(AgentTask.serializer(), t).contains(""""status":"hovering""""))
    }
}
