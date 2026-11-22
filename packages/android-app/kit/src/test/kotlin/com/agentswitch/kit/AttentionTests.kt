package com.agentswitch.kit

import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.feed.Attention
import com.agentswitch.kit.feed.ProcessFolding
import com.agentswitch.kit.feed.SearchSnippet
import com.agentswitch.kit.feed.Staleness
import com.agentswitch.kit.feed.TaskDuration
import com.agentswitch.kit.feed.deleted
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * control-v0 §4–§5 on the phone: who needs you first, quiet running tasks, folded tool calls, the time a task took,
 * and search snippets.
 */
class AttentionTests {
    private fun task(id: String, status: String, updated: Long = 1000, acked: Long? = null, cause: String? = null,
                     created: Long = 0, text: String = "x", result: String? = null): AgentTask {
        val obj = mutableMapOf<String, Any?>("id" to id, "createdAt" to created, "updatedAt" to updated, "status" to status, "task" to text)
        if (acked != null) obj["acknowledgedAt"] = acked
        if (cause != null) obj["blockCause"] = cause
        if (result != null) obj["result"] = result
        return KitJson.decodeFromString(AgentTask.serializer(), mapToJsonText(obj))
    }

    @Test
    fun testTasksGoneFromTheListAreDeletedUnlessTheyOnlyFellOffAFullList() {
        val before = listOf(task("a", "done", created = 30), task("b", "done", created = 20), task("c", "done", created = 10))
        assertEquals(listOf("b"), AgentTask.deleted(before, listOf(task("a", "done", created = 30), task("c", "done", created = 10)), limit = 50))
        assertEquals(emptyList(), AgentTask.deleted(before, before, limit = 50))
        assertEquals(emptyList(), AgentTask.deleted(emptyList(), before, limit = 50), "the first look")
        val full = listOf(task("n", "running", created = 40), task("a", "done", created = 30), task("b", "done", created = 20))
        assertEquals(emptyList(), AgentTask.deleted(before, full, limit = 3), "c is older than all of a full list: it fell off the end")
        assertEquals(listOf("b", "c"), AgentTask.deleted(before, listOf(full[0], full[1]) + listOf(task("d", "done", created = 5)), limit = 3),
            "newer than a task still listed: gone for good")
    }

    private fun call(seq: Long, tool: String, input: Map<String, String> = emptyMap(), denied: Boolean = false): TaskEvent {
        val payload = mutableMapOf<String, JSONValue>(
            "tool" to JSONValue.Str(tool), "id" to JSONValue.Str("c$seq"), "input" to JSONValue.Object(input.mapValues { JSONValue.Str(it.value) }),
        )
        if (denied) payload["denied"] = JSONValue.Str("protected")
        return TaskEvent(taskId = "t", seq = seq, ts = seq * 1000, type = "tool_call", payload = JSONValue.Object(payload))
    }

    private fun event(seq: Long, type: String, ts: Long? = null) =
        TaskEvent(taskId = "t", seq = seq, ts = ts ?: (seq * 1000), type = type,
            payload = JSONValue.Object(if (type == "text") mapOf("text" to JSONValue.Str("hi")) else emptyMap()))

    // MARK: - attention

    @Test
    fun testAttentionOrder() {
        val tasks = listOf(
            task("old-done-read", "done", updated = 50, acked = 60),
            task("running", "running", updated = 10),
            task("unread", "done", updated = 20),
            task("asking", "blocked", updated = 5, cause = "question"),
            task("pending-running", "running", updated = 1),
            task("waiting", "waiting_approval", updated = 3),
            task("failed-unread", "failed", updated = 30),
            task("queued", "queued", updated = 40),
        )
        val sorted = Attention.sorted(tasks, pending = setOf("pending-running")).map { it.id }
        assertEquals(listOf("asking", "waiting", "pending-running", "failed-unread", "unread", "queued", "running", "old-done-read"), sorted)
        assertEquals(Attention.Rank.Rest, Attention.rank(task("x", "done", updated = 5, acked = 5)), "read at the last change")
        assertEquals(Attention.Rank.Unread, Attention.rank(task("x", "cancelled", updated = 5)), "any ended task can be unread")
        assertEquals(Attention.Rank.Rest, Attention.rank(task("x", "done", updated = 5), readMarks = false), "a Mac without read marks")
    }

    // MARK: - staleness

    @Test
    fun testQuietRunningTasksSayHowLong() {
        val now = 10_000_000L   // Date(timeIntervalSince1970: 10_000)
        val running = task("r", "running", updated = 10_000_000 - 30 * 60 * 1000)
        assertEquals(30, Staleness.minutes(running, lastEventAt = null, now = now))
        assertEquals(12, Staleness.minutes(running, lastEventAt = 10_000_000 - 12 * 60 * 1000, now = now), "the latest event counts")
        assertNull(Staleness.minutes(running, lastEventAt = 10_000_000 - 9 * 60 * 1000, now = now), "under ten minutes")
        assertNull(Staleness.minutes(running, lastEventAt = null, now = now, waiting = true), "a question waits for you, not the task")
        assertNull(Staleness.minutes(task("q", "queued", updated = 0), lastEventAt = null, now = now), "queued waits its turn")
        assertNull(Staleness.minutes(task("d", "done", updated = 0), lastEventAt = null, now = now))
        assertEquals("Quiet 14m", Staleness.text(14))
        assertEquals("Quiet 3h", Staleness.text(190))
    }

    // MARK: - folding

    @Test
    fun testConsecutiveCallsFoldAndOthersBreakTheRun() {
        val events = listOf(
            event(1, "dispatched"),
            call(2, "Read", mapOf("file_path" to "a.swift")),
            TaskEvent(taskId = "t", seq = 3, ts = 3000, type = "tool_result", payload = JSONValue.Object(mapOf("id" to JSONValue.Str("c2")))),
            call(4, "Bash", mapOf("command" to "ls")),
            call(5, "Read", mapOf("file_path" to "b.swift")),
            event(6, "text"),
            call(7, "Grep", mapOf("pattern" to "x")),
            event(8, "text"),
            call(9, "Bash", mapOf("command" to "rm -rf ~/.agentswitch"), denied = true),
            call(10, "Bash", mapOf("command" to "git status")),
            call(11, "Bash", mapOf("command" to "git diff")),
        )
        val items = ProcessFolding.items(events)
        assertEquals(listOf("t#1", "tools:t#2", "t#6", "t#7", "t#8", "t#9", "tools:t#10"), items.map { it.id })
        val first = items[1]
        assertIs<ProcessFolding.Item.Tools>(first, "expected a fold")
        assertEquals(listOf(2L, 4L, 5L), first.calls.map { it.seq }, "results are not rows and do not break a run")
        val lone = items[3]
        assertIs<ProcessFolding.Item.Event>(lone, "a lone call stays a line")
        assertEquals(7L, lone.event.seq)
        val denied = items[5]
        assertIs<ProcessFolding.Item.Event>(denied, "a refused call is its own line")
        assertEquals(9L, denied.event.seq)
    }

    @Test
    fun testSummarySentence() {
        val calls = listOf(
            call(1, "Read", mapOf("file_path" to "a")), call(2, "Read", mapOf("file_path" to "b")), call(3, "Read", mapOf("file_path" to "a")),
            call(4, "Read", mapOf("file_path" to "c")),
            call(5, "Bash", mapOf("command" to "ls")), call(6, "commandExecution", mapOf("command" to "/bin/zsh -lc 'ls'")), call(7, "bash", mapOf("command" to "pwd")),
            call(8, "Grep", mapOf("pattern" to "x")), call(9, "Glob", mapOf("pattern" to "*.ts")),
            call(10, "Edit", mapOf("file_path" to "a")), call(11, "Write", mapOf("file_path" to "d")),
            call(12, "mcp__playwright__browser_click", mapOf("element" to "登录")),
            call(13, "TodoWrite"),
        )
        assertEquals("读取 3 个文件，运行 3 条命令，搜索 2 次，修改 2 个文件，浏览器操作 1 次，调用工具 1 次", ProcessFolding.summary(calls))
        assertEquals("正在读取 2 个文件，运行 1 条命令", ProcessFolding.summary(calls.subList(0, 2) + listOf(calls[4]), ongoing = true))
        assertEquals("读取 2 个文件", ProcessFolding.summary(listOf(call(1, "Read"), call(2, "Read"))), "no path: each call counts")
    }

    // MARK: - duration

    @Test
    fun testDuration() {
        val done = task("t", "done", updated = 900_000, created = 0)
        val events = listOf(event(1, "queued", ts = 10_000), event(2, "dispatched", ts = 12_000), event(3, "text", ts = 50_000), event(4, "done", ts = 143_000))
        assertEquals(133.seconds, TaskDuration.seconds(done, events))
        assertEquals("用时 2 分 13 秒", TaskDuration.text(133.seconds))
        assertEquals(900.seconds, TaskDuration.seconds(done, emptyList()), "no events: created to the last change")
        assertNull(TaskDuration.seconds(task("t", "running"), events), "only once it ended")
        assertEquals("用时 1 秒", TaskDuration.text(0.2.seconds))
        assertEquals("用时 45 秒", TaskDuration.text(45.seconds))
        assertEquals("用时 2 分", TaskDuration.text(120.seconds))
        assertEquals("用时 1 小时 5 分", TaskDuration.text(3900.seconds))
        assertEquals("用时 2 小时", TaskDuration.text(7200.seconds))
    }

    // MARK: - search

    @Test
    fun testSnippetMarksBecomeBoldRuns() {
        val parts = SearchSnippet.parts("…把⟦下载⟧目录里重复的⟦下载⟧文件")
        assertEquals(listOf(SearchSnippet.Part("…把", false), SearchSnippet.Part("下载", true), SearchSnippet.Part("目录里重复的", false),
            SearchSnippet.Part("下载", true), SearchSnippet.Part("文件", false)), parts)
        assertEquals("abcd", SearchSnippet.plain("a⟦b⟧c⟧d"), "a stray close mark is dropped")
        assertEquals(listOf(SearchSnippet.Part("a", false), SearchSnippet.Part("bc", true)), SearchSnippet.parts("a⟦bc"), "an unclosed mark runs to the end")
        assertEquals(emptyList(), SearchSnippet.parts(""))
        assertEquals("登录 🔒密文", SearchSnippet.plain("登录 enc:v1:" + "A".repeat(40)), "ciphertexts never show")
    }

    @Test
    fun testLocalSearchMarksHitsLikeTheDaemon() {
        val tasks = listOf(
            task("a", "done", updated = 10, text = "整理下载目录", result = "7 个重复文件移进了“重复”"),
            task("b", "failed", updated = 20, text = "登录财务平台", result = "登录页要短信验证码"),
            task("c", "done", updated = 30, text = "别的"),
        )
        val hits = SearchSnippet.local(tasks, query = "登录")
        assertEquals(listOf("b"), hits.map { it.taskId })
        assertEquals("⟦登录⟧页要短信验证码", hits.firstOrNull()?.snippet, "what came of it before the task text, which is the title")
        assertEquals("登录⟦财务⟧平台", SearchSnippet.local(tasks, query = "财务").firstOrNull()?.snippet, "the task text when nothing else matches")
        assertEquals("7 个⟦重复⟧文件移进了“⟦重复⟧”", SearchSnippet.local(tasks, query = "重复").firstOrNull()?.snippet, "the result is searched too")
        assertEquals(emptyList(), SearchSnippet.local(tasks, query = "  "))
        val long = "甲".repeat(100) + "目标" + "乙".repeat(100)
        val snippet = SearchSnippet.marked(long, query = "目标")
        assertTrue(snippet.startsWith("…") && snippet.endsWith("…"))
        assertTrue(snippet.contains("⟦目标⟧"))
    }
}
