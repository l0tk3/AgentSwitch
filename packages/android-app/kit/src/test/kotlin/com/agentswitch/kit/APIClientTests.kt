package com.agentswitch.kit

import com.agentswitch.kit.api.*
import java.util.Collections
import kotlin.test.*
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Counts failure reports and hands out endpoints in turn. */
class RotatingEndpoints(private val list: List<APIEndpoint>) : EndpointProviding {
    @Volatile private var index = 0
    private val reports = Collections.synchronizedList(mutableListOf<APIEndpoint>())

    val failures: List<APIEndpoint> get() = synchronized(reports) { reports.toList() }

    override suspend fun endpoint(): APIEndpoint = list[minOf(index, list.size - 1)]
    override suspend fun reportFailure(endpoint: APIEndpoint) {
        reports.add(endpoint)
        synchronized(this) { index += 1 }
    }
}

class APIClientTests {
    /**
     * One session carries everything said to a Mac, its streams too, and iOS gives a host four connections unless
     * told otherwise: with four streams followed, nothing else got through (2026-11-10). Here: the dispatcher's limit.
     */
    @Test
    fun theSessionMayHoldMoreConnectionsThanStreamsAreFollowed() {
        assertTrue(PinnedSessionTransport.maxConnections >= 32)
    }

    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)
    private val tailnet = APIEndpoint(host = "fd7a:115c:a1e0::5", port = 4713, kind = EndpointKind.Tailnet)

    @Test
    fun requestShape() = runTest {
        val transport = FakeTransport({ req, _ -> Fixture.data("task.json") to httpResponse(req.url, status = 201) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val task = api.createTask(NewTaskRequest(task = "整理 CSV", pin = TargetRef(harness = "codex", model = "gpt-5.5")))
        assertEquals("t_8f3a2c1d", task.id)
        val req = assertNotNull(transport.requests.firstOrNull())
        assertEquals("POST", req.method)
        assertEquals("https://192.168.1.5:4713/tasks", req.url)
        assertEquals("Bearer tok", req.header("Authorization"))
        assertEquals("application/json", req.header("Content-Type"))
        val body = assertNotNull(req.jsonBody)
        assertEquals("整理 CSV", body["task"]?.jsonPrimitive?.content)
        assertEquals("gpt-5.5", body["pin"]?.jsonObject?.get("model")?.jsonPrimitive?.content)
    }

    @Test
    fun contextReadAndSave() = runTest {
        val transport = FakeTransport({ req, _ ->
            when (req.method to req.path) {
                "GET" to "/context" -> json(mapOf("path" to "/x/CONTEXT.md", "text" to "# 站点", "warnings" to emptyList<String>())) to httpResponse(req.url)
                "GET" to "/context/example" -> json(mapOf("text" to "# 示例")) to httpResponse(req.url)
                "PUT" to "/context" -> json(mapOf("path" to "/x/CONTEXT.md", "warnings" to listOf("line 3: \"密码\" value is not an enc:v1: token; line removed"),
                    "sealed" to listOf(mapOf("label" to "fin/pass", "field" to "account password", "hosts" to listOf("fin.example.test"), "uses" to listOf("http"))))) to httpResponse(req.url)
                else -> json(mapOf("error" to "not found")) to httpResponse(req.url, status = 404)
            }
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val doc = api.context()
        assertEquals("# 站点", doc.text)
        assertEquals(emptyList(), doc.warnings)
        val example = api.contextExample()
        assertEquals("# 示例", example)
        val saved = api.saveContext("# 站点\n- 财务")
        assertEquals(1, saved.warnings.size)
        assertEquals(listOf("account password"), saved.sealed.map { it.field })
        val put = assertNotNull(transport.requests.lastOrNull())
        assertEquals("PUT", put.method)
        assertEquals("application/json", put.header("Content-Type"))
        val body = assertNotNull(put.jsonBody)
        assertEquals("# 站点\n- 财务", body["text"]?.jsonPrimitive?.content)
    }

    @Test
    fun taskCreationWaitsLongerThanTheSealer() = runTest {
        val transport = FakeTransport({ req, _ ->
            if (req.method == "POST") Fixture.data("task.json") to httpResponse(req.url, status = 201) else json(emptyList<Any>()) to httpResponse(req.url)
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        api.createTask(NewTaskRequest(task = "x"))
        api.tasks()
        assertEquals(listOf(AgentSwitchAPI.createTaskTimeout, api.requestTimeout), transport.requests.map { it.timeout })
        assertTrue(AgentSwitchAPI.createTaskTimeout > 30.seconds, "the daemon's sealer may take 30 s before it answers")
    }

    @Test
    fun deletesAreDeleteRequestsAndNeverResent() = runTest {
        val transport = FakeTransport({ req, n ->
            when (n) {
                0 -> json(mapOf("ok" to true)) to httpResponse(req.url)
                1 -> json(mapOf("error" to "thread has a running task")) to httpResponse(req.url, status = 409)
                else -> throw APIError.Transport("timed out")
            }
        })
        val endpoints = RotatingEndpoints(listOf(lan, tailnet))
        val api = AgentSwitchAPI(endpoints = endpoints, transport = transport, token = "tok")
        api.deleteTask("t1")
        val conflict = assertFailsWith<APIError> { api.deleteThread("th1") }
        assertEquals(APIError.Http(status = 409, message = "thread has a running task"), conflict)
        val lost = assertFailsWith<APIError> { api.deleteTask("t2") }
        assertEquals(APIError.Transport("timed out"), lost)
        assertEquals(listOf("DELETE /tasks/t1", "DELETE /threads/th1", "DELETE /tasks/t2"), transport.requests.map { "${it.method} ${it.path}" },
            "a DELETE is sent once, like a POST")
        assertNull(transport.requests[0].body)
    }

    @Test
    fun anEntryAndAllHistoryAreDeletesOfTheirOwn() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("ok" to true)) to httpResponse(req.url) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        api.deleteEntry(12)
        api.clearHistory()
        assertEquals(listOf("DELETE /assistant/12", "DELETE /history"), transport.requests.map { "${it.method} ${it.path}" })
    }

    @Test
    fun idsArePathSegmentsNotRoutes() {
        val url = tailnet.url(listOf("tasks", "a/../b?x#y", "events"), query = listOf(URLQueryItem(name = "after", value = "12")))
        assertEquals("https://[fd7a:115c:a1e0::5]:4713/tasks/a%2F..%2Fb%3Fx%23y/events?after=12", url)
    }

    @Test
    fun errorsCarryTheDaemonMessage() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("error" to "thread is archived; reopen it first")) to httpResponse(req.url, status = 409) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val error = assertFailsWith<APIError> { api.handoff(taskId = "t1") }
        assertEquals(APIError.Http(status = 409, message = "thread is archived; reopen it first"), error)
        assertEquals(listOf("/tasks/t1/handoff"), transport.paths)
    }

    @Test
    fun unauthorized() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("error" to "unauthorized")) to httpResponse(req.url, status = 401) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "revoked")
        assertEquals(APIError.Unauthorized, assertFailsWith<APIError> { api.tasks() })
    }

    @Test
    fun getRetriesOnceOnANewEndpointButPostDoesNot() = runTest {
        val transport = FakeTransport({ req, _ ->
            if (req.host == "192.168.1.5") throw APIError.Transport("timed out")
            json(emptyList<Any>()) to httpResponse(req.url)
        })
        val endpoints = RotatingEndpoints(listOf(lan, tailnet))
        val api = AgentSwitchAPI(endpoints = endpoints, transport = transport, token = "tok")
        val approvals = api.approvals()
        assertTrue(approvals.isEmpty())
        assertEquals(listOf(lan), endpoints.failures)

        val endpoints2 = RotatingEndpoints(listOf(lan, tailnet))
        val api2 = AgentSwitchAPI(endpoints = endpoints2, transport = transport, token = "tok")
        assertEquals(APIError.Transport("timed out"), assertFailsWith<APIError> { api2.createTask(NewTaskRequest(task = "x")) })
        assertEquals(1, transport.requests.count { it.method == "POST" }, "no automatic resend of a POST")
    }

    @Test
    fun approveAndAnswerBodies() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("ok" to true)) to httpResponse(req.url) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        api.approve(taskId = "t1", approvalId = "ap1", decision = ApprovalDecision.Deny)
        api.answer(taskId = "t1", approvalId = "ap2", answers = mapOf("clarify" to listOf("用工作账号")))
        val bodies = transport.requests.mapNotNull { it.jsonBody }
        assertEquals("ap1", bodies[0]["approval_id"]?.jsonPrimitive?.content)
        assertEquals("deny", bodies[0]["decision"]?.jsonPrimitive?.content)
        assertEquals(listOf("用工作账号"), bodies[1]["answers"]?.jsonObject?.get("clarify")?.jsonArray?.map { it.jsonPrimitive.content })
        assertEquals(listOf("/tasks/t1/approve", "/tasks/t1/answer"), transport.paths)
    }
}

class EventStreamTests {
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)
    private val fast = ReconnectPolicy(initial = 5.milliseconds, maximum = 20.milliseconds)

    companion object {
        fun frame(seq: Int, type: String, payload: Map<String, Any?> = emptyMap()): ByteArray {
            val obj = mapOf("taskId" to "t1", "seq" to seq, "ts" to seq * 1000, "type" to type, "payload" to payload)
            return "event: $type\ndata: ${json(obj).decodeToString()}\nid: $seq\n\n".toByteArray()
        }

        fun detail(status: String): ByteArray =
            json(mapOf("id" to "t1", "createdAt" to 0, "updatedAt" to 0, "status" to status, "task" to "x", "approvals" to emptyList<Any>()))
    }

    @Test
    fun replayThenFollowUntilTerminal() = runTest {
        val transport = FakeTransport(streamHandler = { req, _ ->
            Triple(httpResponse(req.url, contentType = "text/event-stream"),
                listOf(frame(1, "queued"), frame(2, "text", mapOf("text" to "hi")), frame(3, "done", mapOf("result" to "ok"))), null)
        })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val got = api.events(taskId = "t1", policy = fast).toList().map { it.seq }
        assertEquals(listOf(1L, 2L, 3L), got)
        val req = assertNotNull(transport.requests.firstOrNull())
        assertEquals("after=0", req.query)
        assertEquals("text/event-stream", req.header("Accept"))
        assertEquals("Bearer tok", req.header("Authorization"))
    }

    @Test
    fun reconnectsFromTheLastSeqWithoutDuplicates() = runTest {
        val transport = FakeTransport(
            handler = { req, _ -> detail("running") to httpResponse(req.url) },
            streamHandler = { req, n ->
                val head = httpResponse(req.url, contentType = "text/event-stream")
                when (n) {
                    0 -> Triple(head, listOf(frame(5, "text"), frame(6, "text")), APIError.Transport("connection lost"))
                    1 -> throw APIError.Transport("still offline")
                    else -> Triple(head, listOf(frame(6, "text"), frame(7, "failed", mapOf("error" to "x"))), null)
                }
            },
        )
        val endpoints = RotatingEndpoints(listOf(lan, lan, lan))
        val api = AgentSwitchAPI(endpoints = endpoints, transport = transport, token = "tok")
        val got = api.events(taskId = "t1", after = 4, policy = fast).toList().map { it.seq }
        assertEquals(listOf(5L, 6L, 7L), got)
        val queries = transport.requests.filter { it.path.endsWith("/events") }.map { it.query ?: "" }
        assertEquals(listOf("after=4", "after=6", "after=6"), queries)
        assertEquals(2, endpoints.failures.size)
    }

    @Test
    fun stopsWhenTheTaskIsAlreadyOver() = runTest {
        val transport = FakeTransport(
            handler = { req, _ -> detail("cancelled") to httpResponse(req.url) },
            streamHandler = { req, _ -> Triple(httpResponse(req.url, contentType = "text/event-stream"), emptyList(), null) },
        )
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        assertEquals(0, api.events(taskId = "t1", after = 9, policy = fast).toList().size)
        assertEquals(listOf("/tasks/t1/events", "/tasks/t1"), transport.paths)
    }

    @Test
    fun notFoundEndsWithAnError() = runTest {
        val transport = FakeTransport(streamHandler = { req, _ -> Triple(httpResponse(req.url, status = 404), listOf(json(mapOf("error" to "not found"))), null) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val error = assertFailsWith<APIError> { api.events(taskId = "t1", policy = fast).collect() }
        assertEquals(APIError.Http(status = 404, message = "not found"), error)
    }

    @Test
    fun backoff() {
        val p = ReconnectPolicy(initial = 1.seconds, maximum = 15.seconds)
        assertEquals(listOf(1, 2, 4, 8, 15, 15).map { it.seconds }, (1..6).map { p.delay(afterFailures = it) })
    }
}
