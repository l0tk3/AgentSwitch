package com.agentswitch.kit

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.feed.LiveSummary
import com.agentswitch.kit.feed.TaskTitle
import com.agentswitch.kit.live.LiveLink
import com.agentswitch.kit.live.LiveState
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Live Activity's state (assistant-v0 §4): one summary of the tasks in progress, the one waiting for you first,
 * short texts, and the last conclusion when nothing runs; plus the link back to a task.
 * (`ModelNameTests`, in the same Swift file, is already in ModelDecodingTests.)
 */
class LiveSummaryTests {
    private fun task(id: String, status: String, created: Long, updated: Long? = null, thread: String? = null,
                     model: String? = null, text: String = "整理下载目录", extra: Map<String, Any?> = emptyMap()): AgentTask {
        val obj = mutableMapOf<String, Any?>("id" to id, "createdAt" to created, "updatedAt" to (updated ?: created), "status" to status, "task" to text)
        if (thread != null) obj["threadId"] = thread
        if (model != null) { obj["model"] = model; obj["harness"] = "opencode" }
        obj.putAll(extra)
        return KitJson.decodeFromString(AgentTask.serializer(), mapToJsonText(obj))
    }

    private fun approvals(): List<Approval> = Fixture.decode(ListSerializer(Approval.serializer()), "approvals.json")

    /** 2026-09-29: "pack it" and "send it to me" after a listing all read "列出下载目录文件清单", the thread's name. */
    @Test
    fun testALaterTaskInAThreadIsCalledByItsOwnRequest() {
        val first = task("a", "done", created = 1_000, thread = "th1", text = "列出下载目录中有哪些文件。")
        val pack = task("b", "done", created = 2_000, thread = "th1", text = "下载目录打包发给我", extra = mapOf("parentId" to "a"))
        val send = task("c", "running", created = 3_000, thread = "th1", text = "把归档文件发送给我。")   // its parent not given
        val alone = task("d", "done", created = 4_000, text = "查一下天气")
        val tasks = listOf(first, pack, send, alone)
        assertEquals("列出下载目录文件清单", TaskTitle.of(first, "列出下载目录文件清单", tasks))
        assertEquals("下载目录打包发给我", TaskTitle.of(pack, "列出下载目录文件清单", tasks))
        assertEquals("把归档文件发送给我。", TaskTitle.of(send, "列出下载目录文件清单", tasks))
        assertEquals("查一下天气", TaskTitle.of(alone, null, tasks))
        val state = assertNotNull(LiveSummary.state(tasks, emptyList(), mapOf("th1" to "列出下载目录文件清单")))
        assertEquals("把归档文件发送给我。", state.lead?.title)
    }

    @Test
    fun testNothingInProgressIsNoState() {
        assertNull(LiveSummary.state(listOf(task("a", "done", created = 1)), emptyList(), emptyMap()))
    }

    @Test
    fun testTheOneWaitingForYouLeadsThenTheNewestAtMostThree() {
        val tasks = listOf(
            task("old", "running", created = 1_000, thread = "th1", model = "deepseek/deepseek-flash"),
            task("t_x", "running", created = 2_000),                      // has the pending question in the fixture
            task("new", "routing", created = 3_000),
            task("newer", "queued", created = 4_000),
            task("gone", "done", created = 5_000),
        )
        val state = assertNotNull(LiveSummary.state(tasks, approvals(), mapOf("th1" to "日报汇总")))
        assertEquals(listOf("t_x", "newer", "new"), state.rows.map { it.id })
        assertEquals(1, state.waiting)
        assertEquals(3, state.running)
        assertEquals(LiveState.Phase.NeedsYou, state.phase)
        assertEquals("部署到哪个环境？", state.lead?.step, "the question, not the approval's label (the status says it waits)")
        assertEquals("Queued", state.rows[1].step)
        val all = assertNotNull(LiveSummary.state(tasks, emptyList(), mapOf("th1" to "日报汇总")))
        assertEquals(LiveState.Phase.Running, all.phase)
        assertEquals(listOf("newer", "new", "t_x"), all.rows.map { it.id })
        val old = assertNotNull(LiveSummary.state(listOf(tasks[0]), emptyList(), mapOf("th1" to "日报汇总"))?.lead)
        assertEquals("日报汇总", old.title)
        assertEquals("DeepSeek Flash", old.model)
    }

    @Test
    fun testTheStepIsTheLatestLineOfTheLiveTailAndTextsStayShort() {
        val long = "很长的任务描述".repeat(20) + " enc:v1:" + "Q".repeat(60)
        val running = task("r", "running", created = 1, text = long)
        val events = listOf(
            TaskEvent(taskId = "r", seq = 1, ts = 1, type = "dispatched", payload = JSONValue.Object(mapOf("harness" to JSONValue.Str("claude-code"), "model" to JSONValue.Str("claude-opus-5-5")))),
            TaskEvent(taskId = "r", seq = 2, ts = 2, type = "text", payload = JSONValue.Object(mapOf("text" to JSONValue.Str("正在打开 x.com 的登录页\n然后填表")))),
        )
        val row = assertNotNull(LiveSummary.state(listOf(running), emptyList(), emptyMap(), tails = mapOf("r" to events))?.lead)
        assertTrue(row.title.codePointCount(0, row.title.length) <= LiveSummary.titleChars)
        assertFalse(row.title.contains("enc:v1:"))
        assertFalse(row.step.contains("\n"))
        assertTrue(row.step.contains("x.com"), row.step)
        val size = KitJson.encodeToString(LiveState.serializer(), LiveState(rows = List(3) { row }, running = 3, waiting = 0)).toByteArray().size
        assertTrue(size < 4096, "ActivityKit keeps a state under 4 KB")
    }

    @Test
    fun testTheLastConclusionIsTheTaskThatEndedLast() {
        val tasks = listOf(
            task("a", "done", created = 1, updated = 10, extra = mapOf("spoken" to "下载目录整理好了。")),
            task("b", "failed", created = 2, updated = 20, extra = mapOf("error" to "gate 代理连不上")),
        )
        val ended = assertNotNull(LiveSummary.ended(tasks, emptyMap()))
        assertEquals("b", ended.taskId)
        assertFalse(ended.ok)
        assertEquals("gate 代理连不上", ended.line)
        assertEquals(LiveState.Phase.Ended, LiveState.finished(ended).phase)
    }

    @Test
    fun testStepsAreSaidInPlainWordsNotRawToolInputOrStateNames() {
        val t = task("r", "running", created = 1)
        fun e(type: String, payload: JSONValue) = TaskEvent(taskId = "r", seq = 1, ts = 1, type = type, payload = payload)
        fun obj(vararg pairs: Pair<String, JSONValue>) = JSONValue.Object(mapOf(*pairs))
        assertEquals("读取 /x/y", LiveSummary.step(t, null, listOf(e("tool_call", obj("tool" to JSONValue.Str("read"), "input" to obj("path" to JSONValue.Str("/x/y")))))))
        assertEquals("运行 npm test", LiveSummary.step(t, null, listOf(e("tool_call", obj("tool" to JSONValue.Str("bash"), "input" to obj("command" to JSONValue.Str("npm test")))))))
        assertEquals("已交给 Opus 5.5", LiveSummary.step(t, null, listOf(e("dispatched", obj("harness" to JSONValue.Str("claude-code"), "model" to JSONValue.Str("claude-opus-5-5"))))))
        assertEquals("第一行", LiveSummary.step(t, null, listOf(e("text", obj("text" to JSONValue.Str("第一行\n第二行"))), e("supervisor", obj("kind" to JSONValue.Str("checkin"))))),
            "a supervisor note says nothing to show: the line before it stays")
        assertEquals("选择模型", LiveSummary.step(task("q", "routing", created = 1), null, emptyList()))
    }

    @Test
    fun testTaskLinksGoBothWaysAndOtherLinksAreNotTasks() {
        val url = LiveLink.task("7698f9b5")
        assertEquals("agentswitch://task/7698f9b5", url)
        assertEquals("7698f9b5", LiveLink.taskId(url))
        assertNull(LiveLink.taskId("agentswitch://pair?p=abc"))
        assertNull(LiveLink.taskId("https://task/abc"))
        assertNull(LiveLink.taskId("agentswitch://task/"))
    }
}
