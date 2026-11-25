package com.agentswitch.kit

import com.agentswitch.kit.api.APIEndpoint
import com.agentswitch.kit.api.AgentSwitchAPI
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.FixedEndpoint
import com.agentswitch.kit.api.session
import com.agentswitch.kit.api.sessions
import com.agentswitch.kit.api.workdir
import kotlinx.coroutines.test.runTest
import com.agentswitch.kit.api.SessionDetail
import com.agentswitch.kit.api.SessionGroups
import com.agentswitch.kit.api.SessionList
import com.agentswitch.kit.api.SessionMessage
import com.agentswitch.kit.api.SessionSummary
import com.agentswitch.kit.api.WorkdirSetting
import com.agentswitch.kit.support.KitJson
import com.agentswitch.kit.support.PathDisplay
import kotlinx.serialization.DeserializationStrategy
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * control-v0's wire shapes and routes: default folder, coding sessions.
 */
class ControlModelTests {
    private fun <T> decode(strategy: DeserializationStrategy<T>, obj: Any?): T = KitJson.decodeFromString(strategy, mapToJsonText(obj))

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

    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    @Test
    fun testRoutes() = runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.method to req.path) {
                "GET" to "/settings/workdir" -> json(mapOf("path" to "/Users/me/AgentSwitch", "default" to "/Users/me/AgentSwitch", "problem" to null)) to httpResponse(req.url)
                "GET" to "/sessions" -> json(mapOf("sessions" to listOf(mapOf("harness" to "codex", "id" to "x", "updatedAt" to 1)))) to httpResponse(req.url)
                "GET" to "/sessions/claude-code/abc" ->
                    json(mapOf("session" to mapOf("harness" to "claude-code", "id" to "abc", "updatedAt" to 1), "messages" to emptyList<Any>())) to httpResponse(req.url)
                else -> json(mapOf("error" to "not found")) to httpResponse(req.url, status = 404)
            }
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val workdir = api.workdir()
        assertEquals("/Users/me/AgentSwitch", workdir.path)
        val sessions = api.sessions(limit = 60)
        assertEquals(listOf("x"), sessions.map { it.sessionId })
        val detail = api.session(harness = "claude-code", id = "abc", limit = 80)
        assertEquals("abc", detail.session.sessionId)
        assertEquals(
            listOf("GET /settings/workdir", "GET /sessions", "GET /sessions/claude-code/abc"),
            transport.requests.map { "${it.method} ${it.path}" },
        )
        assertEquals("limit=60", transport.requests[1].query)
        assertEquals("limit=80", transport.requests[2].query)
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
