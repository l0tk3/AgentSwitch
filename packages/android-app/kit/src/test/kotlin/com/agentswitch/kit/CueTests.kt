package com.agentswitch.kit

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.ThreadDetail
import com.agentswitch.kit.feed.Cue
import com.agentswitch.kit.feed.CueTracker
import com.agentswitch.kit.feed.TaskCue
import com.agentswitch.kit.feed.ThreadStyle
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * assistant-v0 §3: which moments get a sound — a task that ends (done / failed), a new question or approval — found by
 * comparing what the phone saw last with what it sees now. The first look only sets the baseline.
 */
class CueTests {
    private fun task(id: String, status: String, speech: String? = null, thread: String? = null): AgentTask {
        val obj = mutableMapOf<String, Any?>("id" to id, "createdAt" to 1, "updatedAt" to 1, "status" to status, "task" to "x")
        if (speech != null) obj["speech"] = speech
        if (thread != null) obj["threadId"] = thread
        return KitJson.decodeFromString(AgentTask.serializer(), mapToJsonText(obj))
    }

    private fun approval(id: String): Approval = KitJson.decodeFromString(Approval.serializer(), mapToJsonText(
        mapOf("id" to id, "taskId" to "t", "createdAt" to 1, "kind" to "question", "action" to "要验证码", "evidence" to "", "status" to "pending")))

    @Test
    fun testEndingsAfterTheBaseline() {
        val tracker = CueTracker()
        assertEquals(emptyList(), tracker.taskCues(listOf(task("a", "running"), task("b", "done"))), "the first look is the baseline")
        assertEquals(listOf(TaskCue("a", Cue.Done)), tracker.taskCues(listOf(task("a", "done"), task("b", "done"), task("c", "running"))))
        assertEquals(listOf(TaskCue("c", Cue.Failed)), tracker.taskCues(listOf(task("c", "failed"))))
        assertEquals(emptyList(), tracker.taskCues(listOf(task("d", "blocked"))), "a task first seen already ended is not news")
        assertEquals(emptyList(), tracker.taskCues(listOf(task("e", "running"))))
        assertEquals(emptyList(), tracker.taskCues(listOf(task("e", "cancelled"))), "you cancelled it yourself")
        assertEquals(emptyList(), tracker.taskCues(listOf(task("f", "running"))))
        assertEquals(listOf(TaskCue("f", Cue.Failed)), tracker.taskCues(listOf(task("f", "partial"))))
    }

    @Test
    fun testNewApprovalsOnlyOnce() {
        val tracker = CueTracker()
        assertEquals(emptyList(), tracker.newApprovals(listOf(approval("1"))).map { it.id })
        assertEquals(listOf("2"), tracker.newApprovals(listOf(approval("1"), approval("2"))).map { it.id })
        assertEquals(emptyList(), tracker.newApprovals(listOf(approval("2"))).map { it.id })
    }

    @Test
    fun testScriptsThatArriveAfterTheEnd() {
        val tracker = CueTracker()
        tracker.taskCues(listOf(task("a", "running")))
        tracker.taskCues(listOf(task("a", "done")))
        assertEquals(emptyList(), tracker.newScripts(listOf(task("a", "done"))).map { it.id }, "no script yet")
        assertEquals(listOf("a"), tracker.newScripts(listOf(task("a", "done", speech = "做完了"))).map { it.id })
        assertEquals(emptyList(), tracker.newScripts(listOf(task("a", "done", speech = "做完了"))).map { it.id }, "read once")
        assertEquals(emptyList(), tracker.newScripts(listOf(task("old", "done", speech = "旧的"))).map { it.id }, "only tasks that ended while watched")
    }

    @Test
    fun testThreadHueIsStable() {
        assertEquals(ThreadStyle.hue("b5f95cec"), ThreadStyle.hue("b5f95cec"))
        assertNotEquals(ThreadStyle.hue("b5f95cec"), ThreadStyle.hue("da3181fb"))
        assertTrue(ThreadStyle.hue("x") >= 0.0 && ThreadStyle.hue("x") < 1.0)
    }

    @Test
    fun testThreadDetailCarriesTheSummary() {
        val obj = mapOf("id" to "t1", "createdAt" to 1, "updatedAt" to 2, "title" to "登录 x.com", "status" to "open", "taskCount" to 2,
            "summary" to mapOf("title" to "登录 x.com", "goal" to "看通知", "progress" to "已登录", "spoken" to "已登录"), "tasks" to emptyList<Any>())
        val detail = KitJson.decodeFromString(ThreadDetail.serializer(), mapToJsonText(obj))
        assertEquals("看通知", detail.summary?.goal)
        assertEquals("已登录", detail.summary?.progress)
    }
}
