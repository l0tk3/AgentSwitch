package com.agentswitch.kit

import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.AgentTask
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.FixedEndpoint
import com.agentswitch.kit.api.acknowledge
import com.agentswitch.kit.api.approvalPolicy
import com.agentswitch.kit.api.search
import com.agentswitch.kit.api.session
import com.agentswitch.kit.api.sessions
import com.agentswitch.kit.api.workdir
import kotlinx.coroutines.test.runTest
import com.agentswitch.kit.api.ApprovalPolicyInfo
import com.agentswitch.kit.api.ApprovalStatus
import com.agentswitch.kit.api.EventDescriber
import com.agentswitch.kit.api.PermissionMode
import com.agentswitch.kit.api.SessionDetail
import com.agentswitch.kit.api.SessionGroups
import com.agentswitch.kit.api.SessionList
import com.agentswitch.kit.api.SessionMessage
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.TaskEvent
import com.agentswitch.kit.api.TaskStatus
import com.agentswitch.kit.api.WorkdirSetting
import com.agentswitch.kit.feed.acknowledged
import com.agentswitch.kit.feed.isInterrupted
import com.agentswitch.kit.feed.isUnread
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import com.agentswitch.kit.support.PathDisplay
import kotlinx.serialization.DeserializationStrategy
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * control-v0's wire shapes and routes: permission mode, default folder, coding sessions, read marks, search.
 */
class ControlModelTests {
    private fun <T> decode(strategy: DeserializationStrategy<T>, obj: Any?): T = KitJson.decodeFromString(strategy, mapToJsonText(obj))

    @Test
    fun testPolicyDecodesEveryModeAndToleratesNewOnes() {
        val info = decode(ApprovalPolicyInfo.serializer(), mapOf("policy" to mapOf("mode" to "skip", "human" to listOf("delete", "git_push")),
            "categories" to listOf(mapOf("id" to "delete", "title" to "删除文件"), mapOf("id" to "git_push", "title" to "git push"))))
        assertEquals(PermissionMode.Skip, info.policy.mode)
        assertEquals("Bypass", info.policy.mode.label)
        assertEquals(listOf("删除文件", "git push"), info.humanTitles)
        assertEquals("Ask Each", decode(ApprovalPolicyInfo.serializer(), mapOf("policy" to mapOf("mode" to "manual"))).policy.mode.label)
        assertEquals("Auto", decode(ApprovalPolicyInfo.serializer(), mapOf("policy" to mapOf("mode" to "scoped", "human" to emptyList<String>()))).policy.mode.label)
        assertEquals("All Auto", decode(ApprovalPolicyInfo.serializer(), mapOf("policy" to mapOf("mode" to "auto"))).policy.mode.label)
        val future = decode(ApprovalPolicyInfo.serializer(), mapOf("policy" to mapOf("mode" to "yolo", "human" to "not a list"), "categories" to "nope"))
        assertEquals(PermissionMode.Other("yolo"), future.policy.mode)
        assertEquals(emptyList(), future.policy.human)
        assertEquals(emptyList(), future.categories)
        assertFalse(future.policy.mode.explanation.isEmpty())
    }

    @Test
    fun testWorkdirReadsDefaultEitherWay() {
        val asPath = decode(WorkdirSetting.serializer(), mapOf("path" to "/Users/me/AgentSwitch", "default" to "/Users/me/AgentSwitch", "problem" to null))
        assertTrue(asPath.isDefault)
        assertNull(asPath.problem)
        val asFlag = decode(WorkdirSetting.serializer(), mapOf("path" to "/Users/me/Work", "default" to false, "problem" to "目录不存在"))
        assertFalse(asFlag.isDefault)
        assertEquals("目录不存在", asFlag.problem)
        assertNull(decode(WorkdirSetting.serializer(), mapOf("path" to "/x", "problem" to "")).problem, "an empty problem is none")
    }

    @Test
    fun testSessionsDecodeWithMissingFields() {
        val list = decode(SessionList.serializer(), mapOf("sessions" to listOf(
            mapOf("harness" to "claude-code", "id" to "a1", "cwd" to "/Users/me/Projects/AgentSwitch", "title" to "修 SSE 重连", "lastText" to "改好了",
                "updatedAt" to 2000, "active" to true, "branch" to "main"),
            mapOf("harness" to "codex", "id" to "b2", "cwd" to null, "title" to null, "lastText" to "第一行\n第二行", "updatedAt" to 1000, "origin" to "desktop"),
        )))
        assertEquals(listOf("claude-code/a1", "codex/b2"), list.sessions.map { it.id })
        assertTrue(list.sessions[0].active)
        assertEquals("Claude Code", list.sessions[0].harnessName)
        assertEquals("", list.sessions[1].cwd)
        assertFalse(list.sessions[1].active)
        assertEquals("第一行", list.sessions[1].displayTitle, "no title: the first line of the last text")
        assertEquals("desktop", list.sessions[1].origin)

        val detail = decode(SessionDetail.serializer(), mapOf("session" to mapOf("harness" to "opencode", "id" to "s", "updatedAt" to 5),
            "messages" to listOf(mapOf("role" to "assistant", "text" to "b", "ts" to 2), mapOf("role" to "user", "text" to "a", "ts" to 1),
                mapOf("role" to "tool", "text" to "ls", "ts" to 3, "tool" to "bash"), mapOf("role" to "system", "text" to "?", "ts" to 4))))
        assertEquals(listOf("a", "b", "ls", "?"), detail.messages.map { it.text }, "oldest first")
        assertEquals(listOf(SessionMessage.Role.User, SessionMessage.Role.Assistant, SessionMessage.Role.Tool, SessionMessage.Role.Other), detail.messages.map { it.role })
        assertEquals("bash", detail.messages[2].tool)
        assertEquals("未命名会话", detail.session.displayTitle)
    }

    @Test
    fun testSessionsGroupByFolderNewestFirst() {
        val sessions = listOf(
            SessionSummary(harness = "codex", sessionId = "1", cwd = "/a", title = "old a", updatedAt = 10),
            SessionSummary(harness = "claude-code", sessionId = "2", cwd = "/b", title = "b", updatedAt = 30),
            SessionSummary(harness = "opencode", sessionId = "3", cwd = "/a", title = "new a", updatedAt = 40),
        )
        val groups = SessionGroups.grouped(sessions)
        assertEquals(listOf("/a", "/b"), groups.map { it.folder })
        assertEquals(listOf("new a", "old a"), groups[0].sessions.map { it.title })
    }

    @Test
    fun testTaskReadMarkAndInterruption() {
        val task = decode(AgentTask.serializer(), mapOf("id" to "t", "createdAt" to 1, "updatedAt" to 500, "status" to "blocked", "task" to "x",
            "blockCause" to "interrupted", "error" to "服务重启时这个任务还在进行，做到哪一步无法确认。", "acknowledgedAt" to 400))
        assertTrue(task.isInterrupted)
        assertEquals("Incomplete", task.statusLabel, "the status word stays")
        assertTrue(task.isUnread, "changed after it was read")
        val read = task.acknowledged(600)
        assertFalse(read.isUnread)
        assertEquals(600L, read.acknowledgedAt)
        assertEquals(task.error, read.error, "everything else is kept")
        assertEquals(400L, task.acknowledgedAt, "the original is not changed")
        val old = decode(AgentTask.serializer(), mapOf("id" to "t", "createdAt" to 1, "updatedAt" to 5, "status" to "done", "task" to "x"))
        assertNull(old.acknowledgedAt)
        assertTrue(old.isUnread, "an older daemon without read marks: every ended task is unread")
        val running = decode(AgentTask.serializer(), mapOf("id" to "t", "createdAt" to 1, "updatedAt" to 5, "status" to "running", "task" to "x"))
        assertFalse(running.isUnread, "only ended tasks are unread")
    }

    @Test
    fun testWithdrawnAndInterruptedEventLines() {
        val withdrawn = TaskEvent(taskId = "t", seq = 1, ts = 0, type = "approval_resolved",
            payload = JSONValue.Object(mapOf("approvalId" to JSONValue.Str("a"), "decision" to JSONValue.Str("withdrawn"), "status" to JSONValue.Str("withdrawn"), "by" to JSONValue.Str("executor"))))
        assertEquals("已撤回（执行器已取消请求）", EventDescriber.line(withdrawn))
        val interrupted = TaskEvent(taskId = "t", seq = 2, ts = 0, type = "blocked",
            payload = JSONValue.Object(mapOf("cause" to JSONValue.Str("interrupted"), "error" to JSONValue.Str("服务重启时这个任务还在进行，做到哪一步无法确认。"))))
        assertEquals("未完成：服务重启时这个任务还在进行，做到哪一步无法确认。", EventDescriber.line(interrupted))
        assertEquals(EventDescriber.Tone.Muted, EventDescriber.tone(interrupted), "a restart is not a failure of the task")
        assertEquals(ApprovalStatus.Withdrawn, KitJson.decodeFromString(ApprovalStatus.serializer(), "\"withdrawn\""))
    }

    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    @Test
    fun testRoutes() = runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.method to req.path) {
                "GET" to "/approvals/policy" -> json(mapOf("policy" to mapOf("mode" to "skip", "human" to emptyList<Any>()), "categories" to emptyList<Any>())) to httpResponse(req.url)
                "GET" to "/settings/workdir" -> json(mapOf("path" to "/Users/me/AgentSwitch", "default" to "/Users/me/AgentSwitch", "problem" to null)) to httpResponse(req.url)
                "GET" to "/sessions" -> json(mapOf("sessions" to listOf(mapOf("harness" to "codex", "id" to "x", "updatedAt" to 1)))) to httpResponse(req.url)
                "GET" to "/sessions/claude-code/abc" ->
                    json(mapOf("session" to mapOf("harness" to "claude-code", "id" to "abc", "updatedAt" to 1), "messages" to emptyList<Any>())) to httpResponse(req.url)
                "POST" to "/tasks/t1/ack" -> json(mapOf("ok" to true, "task" to mapOf("acknowledgedAt" to 1234))) to httpResponse(req.url)
                "GET" to "/search" ->
                    json(mapOf("results" to listOf(mapOf("taskId" to "t1", "title" to "整理", "snippet" to "把⟦下载⟧目录", "status" to "done", "updatedAt" to 9)))) to httpResponse(req.url)
                else -> json(mapOf("error" to "not found")) to httpResponse(req.url, status = 404)
            }
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val policy = api.approvalPolicy()
        assertEquals(PermissionMode.Skip, policy.policy.mode)
        val workdir = api.workdir()
        assertEquals("/Users/me/AgentSwitch", workdir.path)
        val sessions = api.sessions(limit = 60)
        assertEquals(listOf("x"), sessions.map { it.sessionId })
        val detail = api.session(harness = "claude-code", id = "abc", limit = 80)
        assertEquals("abc", detail.session.sessionId)
        val acked = api.acknowledge(taskId = "t1")
        assertEquals(1234L, acked)
        val results = api.search(query = "下载 目录", limit = 30)
        assertEquals(TaskStatus.Done, results.first().status)
        assertEquals(
            listOf("GET /approvals/policy", "GET /settings/workdir", "GET /sessions", "GET /sessions/claude-code/abc", "POST /tasks/t1/ack", "GET /search"),
            transport.requests.map { "${it.method} ${it.path}" },
        )
        assertEquals("limit=60", transport.requests[2].query)
        assertEquals("limit=80", transport.requests[3].query)
        assertEquals("q=%E4%B8%8B%E8%BD%BD%20%E7%9B%AE%E5%BD%95&limit=30", transport.requests[5].query)
        assertEquals("POST", transport.requests[4].method)
    }

    @Test
    fun testAckWithAPlainOkReply() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("ok" to true)) to httpResponse(req.url) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val acked = api.acknowledge(taskId = "t1")
        assertNull(acked)
    }

    @Test
    fun testPathDisplay() {
        assertEquals("~/Projects/AgentSwitch", PathDisplay.short("/Users/me/Projects/AgentSwitch"))
        assertEquals("~", PathDisplay.short("/Users/me"))
        assertEquals("~", PathDisplay.short("/Users/me/"))
        assertEquals("/Users/Shared/x", PathDisplay.short("/Users/Shared/x"))
        assertEquals("/opt/work", PathDisplay.short("/opt/work"))
        assertEquals("", PathDisplay.short(""))
        assertEquals("AgentSwitch", PathDisplay.name("/Users/me/Projects/AgentSwitch"))
    }
}
