package com.agentswitch.kit

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.Approval
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.feed.ActivityFeed
import com.agentswitch.kit.feed.EventTail
import com.agentswitch.kit.feed.MessageDisplay
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The home screen's log (app-v0 §5): order, which tasks get a live stream, loose approvals, event tails, and how a sealed message reads. */
class FeedTests {
    private fun task(id: String, created: Long, status: String = "done", text: String = "x"): AgentTask =
        KitJson.decodeFromString(AgentTask.serializer(), mapToJsonText(mapOf("id" to id, "createdAt" to created, "updatedAt" to created, "status" to status, "task" to text)))

    /** A text event says something unless given a payload; other types get an empty one. */
    private fun event(type: String, seq: Long, payload: JSONValue? = null): TaskEvent {
        val fallback: JSONValue = if (type == "text") JSONValue.Object(mapOf("text" to JSONValue.Str("line $seq"))) else JSONValue.Object(emptyMap())
        return TaskEvent(taskId = "t", seq = seq, ts = seq * 1000, type = type, payload = payload ?: fallback)
    }

    private fun approval(id: String, task: String, status: String = "pending"): Approval =
        KitJson.decodeFromString(
            Approval.serializer(),
            mapToJsonText(mapOf("id" to id, "taskId" to task, "createdAt" to 1, "kind" to "approval", "action" to "a", "evidence" to "", "status" to status)),
        )

    @Test
    fun testTimelineIsOldestFirstAndKeepsTheNewest() {
        val newestFirst = listOf(task("c", 30), task("b", 20), task("a", 10))
        assertEquals(listOf("a", "b", "c"), ActivityFeed.timeline(newestFirst, limit = 10).map { it.id })
        assertEquals(listOf("b", "c"), ActivityFeed.timeline(newestFirst, limit = 2).map { it.id })
        // The daemon's order is not trusted: created time decides.
        assertEquals(listOf("a", "b", "c"), ActivityFeed.timeline(listOf(task("a", 10), task("c", 30), task("b", 20)), limit = 10).map { it.id })
    }

    @Test
    fun testLiveStreamsGoToTheNewestActiveTasksOnly() {
        val tasks = listOf(task("a", 10, "running"), task("b", 20, "done"), task("c", 30, "waiting_approval"), task("d", 40, "queued"), task("e", 50, "routing"))
        assertEquals(listOf("e", "d", "c"), ActivityFeed.liveTaskIds(tasks, max = 3))
        assertEquals(listOf("e", "d", "c", "a"), ActivityFeed.liveTaskIds(tasks, max = 10))
        assertEquals(emptyList(), ActivityFeed.liveTaskIds(listOf(task("b", 20, "failed")), max = 3))
    }

    @Test
    fun testLooseApprovalsAreThePendingOnesOutsideTheLog() {
        val approvals = listOf(approval("1", "a"), approval("2", "old"), approval("3", "old", status = "allowed"))
        assertEquals(listOf("2"), ActivityFeed.looseApprovals(approvals, setOf("a", "b")).map { it.id })
        assertEquals(listOf("1"), ActivityFeed.pending(approvals, "a").map { it.id })
    }

    @Test
    fun testTailKeepsTheLastMeaningfulLines() {
        var tail: List<TaskEvent> = emptyList()
        for ((i, type) in listOf("queued", "sealed", "thread", "routed", "dispatched", "text", "tool_call", "summary", "rated", "text", "done").withIndex()) {
            tail = EventTail.appending(event(type, (i + 1).toLong()), tail, keep = 3)
        }
        assertEquals(listOf("text", "tool_call", "text"), tail.map { it.type })
        assertFalse(EventTail.shows(event("queued", 1)))
        assertFalse(EventTail.shows(event("failed", 1)), "the end state is on the entry itself")
        assertTrue(EventTail.shows(event("approval_request", 1)))
        assertTrue(EventTail.shows(event("attempt_failed", 1)))
        assertFalse(EventTail.shows(event("text", 1, JSONValue.Object(mapOf("text" to JSONValue.Str("  "))))), "blank text lines are dropped")
    }

    @Test
    fun testTailIgnoresAnEventItAlreadyHas() {
        val first = EventTail.appending(event("text", 5), emptyList(), keep = 3)
        assertEquals(1, EventTail.appending(event("text", 5), first, keep = 3).size)
        assertEquals(listOf(5L), EventTail.appending(event("text", 4), first, keep = 3).map { it.seq }, "older events never reorder the tail")
    }

    @Test
    fun testSealedMessageReadsWithoutTheLegendOrLongTokens() {
        val token = "enc:v1:" + "A".repeat(80) + "xyz789"
        val stored = "登录 https://fin.example.test 用 $token 查报表\n\n[AgentSwitch sealed the credentials in this message. The following field names …]\nCandidate record layout: password\n- $token: password → fin.example.test"
        assertEquals("登录 https://fin.example.test 用 🔒密文 查报表", MessageDisplay.readable(stored))
        assertEquals("no secrets here", MessageDisplay.readable("no secrets here"))
        assertEquals("🔒密文 🔒密文", MessageDisplay.readable("$token $token"))
        assertEquals("enc:v1:short", MessageDisplay.readable("enc:v1:short"), "only real-looking tokens are shortened")
    }
}
