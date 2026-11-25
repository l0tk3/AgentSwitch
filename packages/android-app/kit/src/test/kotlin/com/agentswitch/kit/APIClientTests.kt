package com.agentswitch.kit

import com.agentswitch.kit.api.*
import java.util.Collections
import kotlin.test.*
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.test.runTest
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
        val transport = FakeTransport({ req, _ -> json(mapOf("token" to "asv:1:AAAA")) to httpResponse(req.url) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        assertEquals("asv:1:AAAA", api.vaultSeal("代理的密码"))
        val req = assertNotNull(transport.requests.firstOrNull())
        assertEquals("POST", req.method)
        assertEquals("https://192.168.1.5:4713/vault/seal", req.url)
        assertEquals("Bearer tok", req.header("Authorization"))
        assertEquals("application/json", req.header("Content-Type"))
        val body = assertNotNull(req.jsonBody)
        assertEquals(mapOf("value" to "代理的密码"), body.mapValues { it.value.jsonPrimitive.content })
    }

    @Test
    fun deletesAreDeleteRequestsAndNeverResent() = runTest {
        val transport = FakeTransport({ req, n ->
            when (n) {
                0 -> json(mapOf("ok" to true)) to httpResponse(req.url)
                1 -> json(mapOf("error" to "session is in use")) to httpResponse(req.url, status = 409)
                else -> throw APIError.Transport("timed out")
            }
        })
        val endpoints = RotatingEndpoints(listOf(lan, tailnet))
        val api = AgentSwitchAPI(endpoints = endpoints, transport = transport, token = "tok")
        api.deleteSession("codex", "s1")
        val conflict = assertFailsWith<APIError> { api.deleteSession("codex", "s2") }
        assertEquals(APIError.Http(status = 409, message = "session is in use"), conflict)
        val lost = assertFailsWith<APIError> { api.deleteSession("codex", "s3") }
        assertEquals(APIError.Transport("timed out"), lost)
        assertEquals(listOf("DELETE /sessions/codex/s1", "DELETE /sessions/codex/s2", "DELETE /sessions/codex/s3"), transport.requests.map { "${it.method} ${it.path}" },
            "a DELETE is sent once, like a POST")
        assertNull(transport.requests[0].body)
    }

    @Test
    fun idsArePathSegmentsNotRoutes() {
        val url = tailnet.url(listOf("terminals", "a/../b?x#y", "stream"), query = listOf(URLQueryItem(name = "after", value = "12")))
        assertEquals("https://[fd7a:115c:a1e0::5]:4713/terminals/a%2F..%2Fb%3Fx%23y/stream?after=12", url)
    }

    @Test
    fun errorsCarryTheDaemonMessage() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("error" to "这个节点的服务没有加密存储（需要更新 AgentSwitch）。")) to httpResponse(req.url, status = 503) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val error = assertFailsWith<APIError> { api.vaultSeal("x") }
        assertEquals(APIError.Http(status = 503, message = "这个节点的服务没有加密存储（需要更新 AgentSwitch）。"), error)
        assertEquals(listOf("/vault/seal"), transport.paths)
    }

    @Test
    fun unauthorized() = runTest {
        val transport = FakeTransport({ req, _ -> json(mapOf("error" to "unauthorized")) to httpResponse(req.url, status = 401) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "revoked")
        assertEquals(APIError.Unauthorized, assertFailsWith<APIError> { api.me() })
    }

    @Test
    fun getRetriesOnceOnANewEndpointButPostDoesNot() = runTest {
        val transport = FakeTransport({ req, _ ->
            if (req.host == "192.168.1.5") throw APIError.Transport("timed out")
            json(mapOf("lan" to emptyList<String>(), "tailnet" to emptyList<String>())) to httpResponse(req.url)
        })
        val endpoints = RotatingEndpoints(listOf(lan, tailnet))
        val api = AgentSwitchAPI(endpoints = endpoints, transport = transport, token = "tok")
        assertTrue(api.addresses().lan.isEmpty())
        assertEquals(listOf(lan), endpoints.failures)

        val endpoints2 = RotatingEndpoints(listOf(lan, tailnet))
        val api2 = AgentSwitchAPI(endpoints = endpoints2, transport = transport, token = "tok")
        assertEquals(APIError.Transport("timed out"), assertFailsWith<APIError> { api2.vaultSeal("x") })
        assertEquals(1, transport.requests.count { it.method == "POST" }, "no automatic resend of a POST")
    }

    @Test
    fun backoff() {
        val p = ReconnectPolicy(initial = 1.seconds, maximum = 15.seconds)
        assertEquals(listOf(1, 2, 4, 8, 15, 15).map { it.seconds }, (1..6).map { p.delay(afterFailures = it) })
    }
}
