package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.feed.QuestionPicks
import com.agentswitch.kit.files.UploadFile
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds

/**
 * The terminal routes through the client and a fake transport: the cases of TerminalTests.swift that need
 * `AgentSwitchAPI` (and the second test of TerminalDraftTests).
 */
class TerminalRoutesTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)

    private fun api(transport: FakeTransport) = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")

    @Test
    fun testAnsweringAQuestionSendsWhatWasPickedByQuestion() = runTest {
        val transport = FakeTransport({ req, n ->
            if (n == 0) """{"ok":true,"sealed":1}""".toByteArray() to httpResponse(req.url)
            else """{"error":"no such request (answered already?)"}""".toByteArray() to httpResponse(req.url, status = 404)
        })
        val api = api(transport)
        val sealed = api.answerTerminalQuestion("t1", "p1", mapOf(
            "存哪？" to QuestionPicks.Answer(listOf("Redis"), null),
            "记哪些？" to QuestionPicks.Answer(listOf("id"), "密码 hunter2"),
        ))
        assertEquals(1, sealed)
        assertEquals(listOf("/terminals/t1/permissions/p1"), transport.paths)
        val body = assertNotNull(transport.requests[0].jsonBody)
        assertEquals("allow", body["decision"]?.jsonPrimitive?.content)
        val answers = body["answers"]!!.jsonObject
        assertEquals(listOf("Redis"), answers["存哪？"]!!.jsonObject["labels"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertNull(answers["存哪？"]!!.jsonObject["other"])
        assertEquals("密码 hunter2", answers["记哪些？"]!!.jsonObject["other"]?.jsonPrimitive?.content)
        val late = api.answerTerminalQuestion("t1", "p1", mapOf("存哪？" to QuestionPicks.Answer(listOf("Redis"), null)))
        assertNull(late, "answered in the terminal meanwhile: the card just goes")
    }

    @Test
    fun testResumeStartedExistingOrOpenElsewhere() = runTest {
        val replies = listOf(
            201 to """{"terminal":{"id":"t1","status":"idle"}}""",
            200 to """{"terminal":{"id":"t0","status":"working"},"existing":true}""",
            409 to """{"error":"会话正在iTerm2中运行","elsewhere":{"app":"iTerm2","pid":42}}""",
            403 to """{"error":"跳过权限只能在 Mac 上选择"}""",
            422 to """{"error":"会话所在的文件夹 /Users/u/p 已不存在。","folderGone":"/Users/u/p","alike":["/Users/u/Projects/p"],"near":"/Users/u"}""",
        )
        val transport = FakeTransport({ req, n -> replies[n].second.toByteArray() to httpResponse(req.url, status = replies[n].first) })
        val api = api(transport)
        val body = ResumeTerminalRequest(harness = "claude-code", cwd = "/Users/u/p", agentSessionId = "s-1", mode = "auto")
        val started = api.resumeTerminal(body)
        assertTrue(started is ResumeOutcome.Started, "not started")
        assertEquals("t1", started.terminal.id)
        val existing = api.resumeTerminal(body)
        assertTrue(existing is ResumeOutcome.Existing, "not existing")
        assertEquals("t0", existing.terminal.id)
        val third = api.resumeTerminal(body)
        assertEquals(ResumeOutcome.Elsewhere(app = "iTerm2", pid = 42), third)
        val e = assertFailsWith<APIError.Http>("403 is an error") { api.resumeTerminal(body) }
        assertEquals(403, e.status)
        assertEquals("跳过权限只能在 Mac 上选择", e.message)
        // Its folder gone (2026-10-03): where it may be now, and the same request again in a folder picked.
        val gone = api.resumeTerminal(body)
        assertEquals(ResumeOutcome.FolderGone(cwd = "/Users/u/p", alike = listOf("/Users/u/Projects/p"), near = "/Users/u"), gone)
        assertEquals(ResumeTerminalRequest(harness = "claude-code", cwd = "~/Projects/p", agentSessionId = "s-1", mode = "auto"), body.continuing("~/Projects/p"))
        assertEquals("/terminals/resume", transport.paths.first())
        // An absent optional is left out of what is sent.
        assertEquals(setOf("harness", "cwd", "agentSessionId", "mode"), transport.requests[0].jsonBody!!.keys)
    }

    @Test
    fun testKeysAndInputGoByNameAndThroughTheSealer() = runTest {
        val transport = FakeTransport({ req, _ ->
            val reply = if (req.path.endsWith("/input")) """{"ok":true,"sealed":1}""" else """{"ok":true}"""
            reply.toByteArray() to httpResponse(req.url)
        })
        val api = api(transport)
        api.sendTerminalKeys("t1", listOf(TerminalKey.Esc, TerminalKey.ShiftTab, TerminalKey.CtrlC, TerminalKey.One))
        val result = api.sendTerminalInput("t1", text = "密码是 hunter2")
        assertEquals(1, result.sealed)
        api.decideTerminalPermission("t1", "p1", allow = true)
        assertEquals(listOf("/terminals/t1/keys", "/terminals/t1/input", "/terminals/t1/permissions/p1"), transport.paths)
        // A tap on a program that tracks the mouse (2026-09-30, user: 手机上的终端只能滚动，点击操作没透传).
        api.clickTerminal("t1", col = 4, row = 2)
        val click = transport.requests.last().jsonBody!!
        assertEquals(listOf("click:4:2"), click["keys"]!!.jsonArray.map { it.jsonPrimitive.content })
        val keys = transport.requests[0].jsonBody!!
        assertEquals(listOf("esc", "shift-tab", "ctrl-c", "1"), keys["keys"]!!.jsonArray.map { it.jsonPrimitive.content })
        val decision = transport.requests[2].jsonBody!!
        assertEquals("allow", decision["decision"]?.jsonPrimitive?.content)
        // The input goes with seal and submit.
        val input = transport.requests[1].jsonBody!!
        assertEquals(setOf("text", "submit", "seal"), input.keys)
        assertTrue(input["seal"]!!.jsonPrimitive.boolean)
        // Answered on the Mac while the phone was away (2026-09-30, user: 手机上再次确认会显示 no such request).
        val answered = FakeTransport({ req, _ -> """{"error":"no such request (answered already?)"}""".toByteArray() to httpResponse(req.url, status = 404) })
        val decided = api(answered).decideTerminalPermission("t1", "p1", allow = false)
        assertFalse(decided)
        // never the raw keystroke route
        assertFalse(transport.paths.any { it.endsWith("/write") })
    }

    /** 2026-09-30, user: 手机上不能直接发图. */
    @Test
    fun testPicturesAreStagedThenPutInTheTerminal() = runTest {
        val transport = FakeTransport({ req, _ ->
            val reply = if (req.path == "/uploads") """{"files":[{"id":"abc123def456","name":"photo-1.jpg","size":4,"type":"image/jpeg"}]}"""
            else """{"files":[{"name":"photo-1.jpg","path":"/var/folders/x/T/agentswitch-attach/t1/photo-1.jpg","size":4,"type":"image/jpeg"}]}"""
            reply.toByteArray() to httpResponse(req.url)
        })
        val api = api(transport)
        val staged = api.upload(listOf(UploadFile(name = "photo-1.jpg", type = "image/jpeg", data = byteArrayOf(1, 2, 3, 4))))
        val files = api.attachToTerminal("t1", staged.map { it.id })
        assertEquals(listOf(AttachedFile(name = "photo-1.jpg", path = "/var/folders/x/T/agentswitch-attach/t1/photo-1.jpg")), files)
        assertEquals(listOf("/uploads", "/terminals/t1/attach"), transport.paths)
        val body = transport.requests[1].jsonBody!!
        assertEquals(listOf("abc123def456"), body["uploads"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun testStreamResumesAfterTheLastSeqAndEndsWhenRemoved() = runTest {
        val frames = listOf(
            "event: snapshot\ndata: {\"type\":\"snapshot\",\"seq\":5,\"cols\":40,\"rows\":10,\"data\":\"a\"}\n\n",
            "event: output\ndata: {\"type\":\"output\",\"seq\":6,\"data\":\"b\"}\n\n",
        )
        val transport = FakeTransport(streamHandler = { req, n ->
            if (n == 0) Triple(httpResponse(req.url, contentType = "text/event-stream"), frames.map { it.toByteArray() }, APIError.Transport("dropped"))
            else {
                val replay = "event: output\ndata: {\"type\":\"output\",\"seq\":6,\"data\":\"b\"}\n\nevent: removed\ndata: {\"type\":\"removed\"}\n\n"
                Triple(httpResponse(req.url, contentType = "text/event-stream"), listOf(replay.toByteArray()), null)
            }
        })
        val api = api(transport)
        val got = api.terminalEvents("t1", screen = "phone-7c", policy = ReconnectPolicy(initial = 1.milliseconds, maximum = 2.milliseconds)).toList()
        assertEquals(listOf(TerminalEvent.Snapshot(5, 40, 10, "a"), TerminalEvent.Output(6, "b"), TerminalEvent.Removed), got)
        // Each connection says which screen follows: the size this phone owns goes back when it stops.
        assertEquals("screen=phone-7c", transport.requests.first().query)
        assertEquals("after=6&screen=phone-7c", transport.requests.last().query)
    }

    /** A 404 on the stream ends it with `Removed`; the record view skips what carries a seq. */
    @Test
    fun aMissingTerminalEndsTheStreamAndTheRecordViewSkipsSeqEvents() = runTest {
        val gone = FakeTransport(streamHandler = { req, _ ->
            Triple(httpResponse(req.url, status = 404), listOf("""{"error":"no such terminal"}""".toByteArray()), null)
        })
        assertEquals(listOf<TerminalEvent>(TerminalEvent.Removed), api(gone).terminalEvents("t9").toList())

        val record = FakeTransport(streamHandler = { req, _ ->
            val text = "event: snapshot\ndata: {\"type\":\"snapshot\",\"seq\":5,\"cols\":40,\"rows\":10,\"data\":\"a\"}\n\n" +
                "event: status\ndata: {\"type\":\"status\",\"status\":\"idle\"}\n\n" +
                "event: removed\ndata: {\"type\":\"removed\"}\n\n"
            Triple(httpResponse(req.url, contentType = "text/event-stream"), listOf(text.toByteArray()), null)
        })
        val got = api(record).terminalEvents("t1", screen = "ignored", record = true).toList()
        assertEquals(listOf(TerminalEvent.Status(TerminalStatus.Idle), TerminalEvent.Removed), got)
        assertEquals("view=record", record.requests.single().query)
    }

    @Test
    fun testTheReplyCarriesWhereEachFileGoes() = runTest {
        val transport = FakeTransport({ req, _ -> """{"ok":true,"sealed":0,"attached":1}""".toByteArray() to httpResponse(req.url) })
        val api = api(transport)
        val result = api.sendTerminalInput("t1", text = "看 [Image #1] 这里", sealed = false,
            attachments = listOf(TerminalAttachmentRef(token = "[Image #1]", upload = "abc123def456")))
        assertEquals(1, result.attached)
        val body = transport.requests.first().jsonBody!!
        assertEquals(JsonObject(mapOf("token" to JsonPrimitive("[Image #1]"), "upload" to JsonPrimitive("abc123def456"))),
            body["attachments"]!!.jsonArray.first())
        // Without files the body is as before (an older Mac is not asked for what it does not know).
        api.sendTerminalInput("t1", text = "hi", sealed = false)
        val plain = transport.requests.last().jsonBody!!
        assertNull(plain["attachments"])
    }
}
