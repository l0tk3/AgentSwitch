package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.connection.*
import com.agentswitch.kit.pairing.*
import java.util.Collections
import kotlin.test.*
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest

/**
 * control-v0 §5: finding the Mac again without the user doing anything — the foreground check, retries without a
 * cap, half-open event streams — and saying how it goes (the tiers, 排障).
 */
class ConnectionRecoveryTests {
    private val payload = PairingPayload.sample()
    private val book = payload.addressBook
    private val lan = APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)
    private val fastRetry = ReconnectPolicy(initial = 50.milliseconds, maximum = 80.milliseconds)

    // MARK: - tiers

    @Test
    fun tiersFromConnectingToLost() {
        val start = 0L
        var progress = ConnectionProgress()
        assertEquals(ConnectionPhase.Connecting, progress.phase(ConnectionState.Selecting, now = start))
        progress = progress.after(ConnectionState.Connected(lan), at = start)
        assertEquals(ConnectionPhase.Connected(lan), progress.phase(ConnectionState.Connected(lan)))
        assertEquals(ConnectionPhase.Reconnecting, progress.phase(ConnectionState.Idle, now = start), "connected before: the way back")
        assertEquals(ConnectionPhase.Reconnecting, progress.phase(ConnectionState.Selecting, now = start))
        progress = progress.after(ConnectionState.Unreachable, at = start + 10_000)
        assertEquals(ConnectionPhase.Failing(attempt = 1), progress.phase(ConnectionState.Unreachable, now = start + 11_000))
        progress = progress.after(ConnectionState.Selecting, at = start + 12_000).after(ConnectionState.Unreachable, at = start + 20_000)
        assertEquals(ConnectionPhase.Failing(attempt = 2), progress.phase(ConnectionState.Selecting, now = start + 21_000), "a retry keeps the count")
        assertEquals(ConnectionPhase.Lost, progress.phase(ConnectionState.Unreachable, now = start + 10_000 + ConnectionProgress.lostAfter.inWholeMilliseconds))
        assertEquals(ConnectionPhase.Unpaired, progress.phase(ConnectionState.Unauthorized))
        assertEquals(ConnectionPhase.CertificateChanged, progress.phase(ConnectionState.PinMismatch(seen = null)))
        progress = progress.after(ConnectionState.Connected(lan))
        assertEquals(0, progress.failures)
        assertNull(progress.failingSince)
        assertEquals(ConnectionPhase.Reconnecting, progress.phase(ConnectionState.Idle))
        assertEquals(listOf("Connecting", "Reconnecting", "Unreachable · Try 3", "Mac Not Found", "Unpaired"),
            listOf(ConnectionPhase.Connecting, ConnectionPhase.Reconnecting, ConnectionPhase.Failing(attempt = 3), ConnectionPhase.Lost, ConnectionPhase.Unpaired).map { it.text })
        assertEquals("Connected · LAN", ConnectionPhase.Connected(lan).text)
        assertTrue(ConnectionPhase.Lost.canRetry)
        assertFalse(ConnectionPhase.Unpaired.canRetry)
    }

    // MARK: - 排障

    @Test
    fun checksSayWhichLineFailedAndWhy() {
        val reports = listOf(
            ProbeReport(endpoint = lan, outcome = ProbeOutcome.Unreachable("请求超时。"), seconds = 4.0),
            ProbeReport(endpoint = APIEndpoint(host = "100.101.102.103", port = 4713, kind = EndpointKind.Tailnet), outcome = ProbeOutcome.Unreachable("无法连接服务器。"), seconds = 4.0),
            ProbeReport(endpoint = APIEndpoint(host = "mac.tail1234.ts.net", port = 4713, kind = EndpointKind.Tailnet), outcome = null, seconds = 0.0),
        )
        val checks = Troubleshooting.checks(state = ConnectionState.Unreachable, reports = reports, book = book)
        assertEquals(listOf("Mac", "LAN", "Tailscale"), checks.map { it.title })
        assertEquals(listOf<Boolean?>(false, false, false), checks.map { it.ok })
        assertEquals("无法连接：请求超时。", checks[1].detail)
        assertEquals("无法连接：无法连接服务器。", checks[2].detail)

        val connected = Troubleshooting.checks(state = ConnectionState.Connected(lan), reports = listOf(ProbeReport(endpoint = lan, outcome = ProbeOutcome.Ok, seconds = 0.2),
            ProbeReport(endpoint = reports[1].endpoint, outcome = null, seconds = 0.0)), book = book)
        assertEquals(listOf(true, true, null), connected.map { it.ok }, "Tailscale was not needed")
        assertEquals(listOf("已通过 LAN 连接", "OK", "Unused · 已通过其他线路连接"), connected.map { it.detail })

        val noTailnet = ServerProfile(name = "Mac", port = 4713, fingerprint = payload.fp, lan = listOf("192.168.1.5"), tailnet = emptyList(), bonjour = "b", gate = null,
            deviceId = "d", pairedAt = System.currentTimeMillis())
        val missing = Troubleshooting.checks(state = ConnectionState.Unreachable, reports = listOf(reports[0]), book = noTailnet)
        assertEquals(false, missing[2].ok)
        assertTrue(missing[2].detail.contains("无 Tailscale 地址"))
        assertEquals(listOf<Boolean?>(null, null, null), Troubleshooting.checks(state = ConnectionState.Selecting, reports = null, book = book).map { it.ok }, "nothing tried yet")
        assertEquals(5, Troubleshooting.causes.size)
        assertTrue(Troubleshooting.causes.any { it.contains("Mac 更换了网络") }, "a Mac that moved where devices cannot find each other, and the two ways to tell the phone")
    }

    // MARK: - manager

    @Test
    fun foregroundCheckKeepsAWorkingAddress() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok, "100.101.102.103" to ProbeOutcome.Ok))
        val manager = manager(book, prober, retry = fastRetry)
        manager.endpoint()
        val state = manager.verify()
        assertEquals(ConnectionState.Connected(lan), state)
        assertEquals(2, prober.probed.count { it == "192.168.1.5" }, "one selection, one check")
        manager.stop()
    }

    @Test
    fun foregroundCheckReselectsWhenTheAddressIsGone() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok, "100.101.102.103" to ProbeOutcome.Ok))
        val manager = manager(book, prober, retry = fastRetry)
        manager.endpoint()
        prober.set("192.168.1.5", ProbeOutcome.Unreachable("another Wi-Fi"))
        val state = manager.verify()
        assertEquals(ConnectionState.Connected(APIEndpoint(host = "100.101.102.103", port = 4713, kind = EndpointKind.Tailnet)), state)
        manager.stop()
    }

    @Test
    fun foregroundCheckLeavesARevokedPairingAlone() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Unauthorized))
        val manager = manager(book, prober, retry = fastRetry)
        runCatching { manager.endpoint() }
        val before = prober.probed.size
        val state = manager.verify()
        assertEquals(ConnectionState.Unauthorized, state)
        assertEquals(before, prober.probed.size, "no probe: the Mac already said no")
    }

    @Test
    fun unreachableKeepsRetryingOnItsOwnAndCallersFailFast() = runTest {
        val prober = FakeProber(emptyMap())
        val manager = manager(book, prober, retry = fastRetry)
        val states = manager.states().produceIn(backgroundScope)
        states.receive()   // idle
        assertEquals(APIError.Unreachable, assertFailsWith<APIError>("nothing answers") { manager.endpoint() })
        val probedAfterFirst = prober.probed.size
        assertEquals(APIError.Unreachable, assertFailsWith<APIError>("still nothing") { manager.endpoint() })
        assertEquals(probedAfterFirst, prober.probed.size, "a caller does not start a selection while a retry is due")

        // Several retries in a row (no cap), then the Mac comes back and is found without anyone asking.
        var failures = 0
        while (failures < 4) { if (states.receive() == ConnectionState.Unreachable) failures += 1 }
        prober.set("192.168.1.5", ProbeOutcome.Ok)
        while (true) { if (states.receive().endpoint != null) break }
        val endpoint = manager.endpoint()
        assertEquals(lan, endpoint)
        manager.stop()
    }

    @Test
    fun stopEndsTheRetries() = runTest {
        val prober = FakeProber(emptyMap())
        val manager = manager(book, prober, retry = fastRetry)
        runCatching { manager.endpoint() }
        manager.stop()
        val count = prober.probed.size
        delay(150.milliseconds)
        assertEquals(count, prober.probed.size)
    }

    // MARK: - half-open event streams

    @Test
    fun aSilentStreamIsDroppedAndResumed() = runTest {
        val transport = SilentStreamTransport()
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(lan), transport = transport, token = "tok")
        val policy = ReconnectPolicy(initial = 5.milliseconds, maximum = 10.milliseconds, idleTimeout = 150.milliseconds)
        val started = System.nanoTime()
        val got = api.events(taskId = "t1", policy = policy).toList().map { it.seq }
        assertEquals(listOf(1L, 2L), got)
        assertEquals(listOf("after=0", "after=1"), transport.queries, "resumed after the last event before the silence")
        assertTrue((System.nanoTime() - started) / 1e9 < 5)
    }

    @Test
    fun idleGuardPassesBytesThrough() = runTest {
        val body = flowOf("a".toByteArray(), "b".toByteArray())
        val out = AgentSwitchAPI.idleGuarded(body, limit = 5.seconds).toList().fold(ByteArray(0)) { a, b -> a + b }
        assertEquals("ab", out.decodeToString())
    }
}

/** First connection: one event, then nothing at all (a half-open socket). Second: the end. */
private class SilentStreamTransport : HTTPTransport {
    private val log = Collections.synchronizedList(mutableListOf<String>())

    val queries: List<String> get() = synchronized(log) { log.toList() }

    override suspend fun send(request: HTTPRequest): Pair<ByteArray, HTTPResponse> =
        json(mapOf("id" to "t1", "createdAt" to 0, "updatedAt" to 0, "status" to "running", "task" to "x")) to httpResponse(request.url)

    override suspend fun stream(request: HTTPRequest): Pair<HTTPResponse, Flow<ByteArray>> {
        val n = synchronized(log) { log.add(request.query ?: ""); log.size - 1 }
        val body = if (n == 0) {
            flow { emit(frame(1, "text")); awaitCancellation() }
        } else {
            flowOf(frame(2, "done"))
        }
        return httpResponse(request.url, contentType = "text/event-stream") to body
    }

    companion object {
        fun frame(seq: Int, type: String): ByteArray {
            val obj = mapOf("taskId" to "t1", "seq" to seq, "ts" to seq, "type" to type, "payload" to mapOf("text" to "x"))
            return "data: ${json(obj).decodeToString()}\n\n".toByteArray()
        }
    }
}
