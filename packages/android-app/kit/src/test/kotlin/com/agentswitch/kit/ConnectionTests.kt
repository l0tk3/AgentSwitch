package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.connection.*
import com.agentswitch.kit.pairing.*
import kotlin.test.*
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.produceIn
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest

class EndpointSelectorTests {
    private val payload = PairingPayload.sample()
    private val book = payload.addressBook
    private val prefix: String get() = payload.fp.take(16)

    @Test
    fun orderBonjourThenLanThenTailnet() {
        val found = listOf(
            DiscoveredService(name = "AgentSwitch on Other", fingerprintPrefix = "0000000000000000", host = "192.168.1.9", port = 4713),
            DiscoveredService(name = "AgentSwitch on Mac mini", fingerprintPrefix = prefix.uppercase(), host = "192.168.1.77", port = 4800),
            DiscoveredService(name = "no txt", fingerprintPrefix = null, host = "192.168.1.10", port = 4713),
        )
        val c = EndpointSelector.candidates(book, discovered = found)
        assertEquals(listOf(EndpointKind.Bonjour, EndpointKind.Lan, EndpointKind.Tailnet, EndpointKind.Tailnet), c.map { it.kind })
        assertEquals(listOf("192.168.1.77:4800", "192.168.1.5:4713", "100.101.102.103:4713", "mac.tail1234.ts.net:4713"), c.map { it.authority })
    }

    @Test
    fun duplicateAddressKeepsTheBetterKind() {
        val found = listOf(DiscoveredService(name = "m", fingerprintPrefix = prefix, host = "192.168.1.5", port = 4713))
        val c = EndpointSelector.candidates(book, discovered = found)
        assertEquals(listOf(EndpointKind.Bonjour), c.filter { it.host == "192.168.1.5" }.map { it.kind })
    }

    @Test
    fun prefersEarlierCandidateEvenIfSlower() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok, "100.101.102.103" to ProbeOutcome.Ok), delays = mapOf("192.168.1.5" to 80.milliseconds))
        val c = EndpointSelector.candidates(book, discovered = emptyList())
        val result = EndpointSelector.select(c, token = "t", prober = prober)
        assertEquals(SelectionResult.Selected(APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)), result)
    }

    @Test
    fun fallsBackToTailnet() = runTest {
        val prober = FakeProber(mapOf("mac.tail1234.ts.net" to ProbeOutcome.Ok))
        val result = EndpointSelector.select(EndpointSelector.candidates(book, discovered = emptyList()), token = null, prober = prober)
        assertEquals(SelectionResult.Selected(APIEndpoint(host = "mac.tail1234.ts.net", port = 4713, kind = EndpointKind.Tailnet)), result)
    }

    /** Settings › Mac lists every address with what came of it (2026-09-26: the app gave no reason over Tailscale). */
    @Test
    fun theSelectionReportsEveryAddress() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Unreachable("请求超时。"), "100.101.102.103" to ProbeOutcome.Ok))
        val candidates = EndpointSelector.candidates(book, discovered = emptyList())
        val (result, reports) = EndpointSelector.selectReporting(candidates, token = "t", prober = prober)
        assertEquals(SelectionResult.Selected(APIEndpoint(host = "100.101.102.103", port = 4713, kind = EndpointKind.Tailnet)), result)
        assertEquals(candidates, reports.map { it.endpoint })
        assertEquals(ProbeOutcome.Unreachable("请求超时。"), reports.first().outcome)
        assertEquals(ProbeOutcome.Ok, reports.first { it.endpoint.host == "100.101.102.103" }.outcome)
    }

    @Test
    fun failureReasons() {
        val c = EndpointSelector.candidates(book, discovered = emptyList())
        assertEquals(SelectionResult.Unauthorized, EndpointSelector.decide(c, listOf(ProbeOutcome.Unreachable("x"), ProbeOutcome.Unauthorized,
            ProbeOutcome.PinMismatch(seen = "ff"), ProbeOutcome.Unreachable("y"))))
        assertEquals(SelectionResult.PinMismatch(seen = "ff"), EndpointSelector.decide(c, listOf(ProbeOutcome.Unreachable("x"),
            ProbeOutcome.PinMismatch(seen = "ff"), ProbeOutcome.Unreachable("y"), ProbeOutcome.Unreachable("z"))))
        assertEquals(SelectionResult.Unreachable, EndpointSelector.decide(emptyList(), emptyList()))
    }
}

/** Path changes on demand. */
class ScriptedPaths : PathMonitoring {
    private val channel = Channel<NetworkPathSnapshot>(Channel.UNLIMITED)
    override fun changes(): Flow<NetworkPathSnapshot> = channel.receiveAsFlow()
    fun emit(s: NetworkPathSnapshot) { channel.trySend(s) }
}

/** A manager whose selections, retries and monitor run in the test's virtual time. */
fun TestScope.manager(
    book: ServerAddressBook,
    prober: EndpointProber,
    discovery: ServiceDiscovery? = null,
    settleDelay: Duration = 500.milliseconds,
    retry: ReconnectPolicy = ConnectionManager.standardRetry,
): ConnectionManager = ConnectionManager(book = book, token = "t", discovery = discovery, prober = prober, settleDelay = settleDelay,
    retry = retry, scope = backgroundScope)

class ConnectionManagerTests {
    private val payload = PairingPayload.sample()
    private val book = payload.addressBook

    @Test
    fun selectsOnceForConcurrentCallers() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok), delays = mapOf("192.168.1.5" to 50.milliseconds))
        val manager = manager(book, prober)
        val a = async { manager.endpoint() }
        val b = async { manager.endpoint() }
        val (ea, eb) = a.await() to b.await()
        assertEquals(ea, eb)
        assertEquals(1, prober.probed.count { it == "192.168.1.5" })
        val again = manager.endpoint()
        assertEquals("192.168.1.5", again.host)
        assertEquals(1, prober.probed.count { it == "192.168.1.5" }, "cached until a failure")
    }

    @Test
    fun failureTriggersReselection() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok, "100.101.102.103" to ProbeOutcome.Ok))
        val manager = manager(book, prober)
        val first = manager.endpoint()
        assertEquals(EndpointKind.Lan, first.kind)
        prober.set("192.168.1.5", ProbeOutcome.Unreachable("left home"))
        manager.reportFailure(first)
        val second = manager.endpoint()
        assertEquals("100.101.102.103", second.host)
    }

    /**
     * 2026-09-26: a phone paired while the Mac had no Tailscale address could not connect on mobile data. Once
     * connected it takes the Mac's current addresses; the next selection off the LAN finds the Tailscale one.
     */
    @Test
    fun addressesLearnedLaterAreUsedOffTheLan() = runTest {
        val saved = ServerProfile(name = "Mac", port = 4713, fingerprint = "ab".repeat(32), lan = listOf("192.168.1.5"), tailnet = emptyList(),
            bonjour = "AgentSwitch on Mac", gate = null, deviceId = "d", pairedAt = System.currentTimeMillis())
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok, "100.101.102.103" to ProbeOutcome.Ok))
        val manager = manager(saved, prober)
        val home = manager.endpoint()
        assertEquals(EndpointKind.Lan, home.kind)
        val learned = assertNotNull(saved.updated(with = MacAddresses(lan = listOf("192.168.1.5"), tailnet = listOf("100.101.102.103", "mac.tail1234.ts.net"))))
        assertEquals(listOf("100.101.102.103", "mac.tail1234.ts.net"), learned.tailnet)
        manager.update(book = learned)
        prober.set("192.168.1.5", ProbeOutcome.Unreachable("mobile data"))
        manager.reportFailure(home)
        val away = manager.endpoint()
        assertEquals(APIEndpoint(host = "100.101.102.103", port = 4713, kind = EndpointKind.Tailnet), away)
    }

    @Test
    fun anEmptyKindKeepsTheSavedAddressesAndNothingNewChangesNothing() {
        val saved = ServerProfile(name = "Mac", port = 4713, fingerprint = "ab".repeat(32), lan = listOf("192.168.1.5"), tailnet = listOf("100.101.102.103"),
            bonjour = "b", gate = null, deviceId = "d", pairedAt = System.currentTimeMillis())
        assertNull(saved.updated(with = MacAddresses(lan = listOf("192.168.1.5"), tailnet = emptyList())), "Tailscale off for a moment keeps the saved address")
        assertNull(saved.updated(with = MacAddresses(lan = emptyList(), tailnet = listOf("100.101.102.103"))))
        assertEquals(listOf("192.168.1.20", "192.168.1.5"), saved.updated(with = MacAddresses(lan = listOf("192.168.1.20", "bad host!"), tailnet = emptyList()))?.lan,
            "the new address first, the one before kept behind it; what is no address dropped")
    }

    /**
     * 2026-10-07: a Mac that moves between networks has another address on each, and the phone kept only the last
     * one it was told. It keeps the earlier ones too, so the Mac is found where it has been before without Bonjour
     * or Tailscale to tell the phone again.
     */
    @Test
    fun aMacThatMovesBetweenNetworksIsFoundOnEitherOne() = runTest {
        val fp = "ab".repeat(32)
        val home = ServerProfile(name = "Mac", port = 4713, fingerprint = fp, lan = listOf("192.168.31.137"), tailnet = listOf("100.77.168.100"),
            bonjour = "b", gate = null, deviceId = "d", pairedAt = System.currentTimeMillis())
        // At the office, reached over Tailscale: the phone is told the address there.
        val office = assertNotNull(home.updated(with = MacAddresses(lan = listOf("10.38.120.101"), tailnet = listOf("100.77.168.100"))))
        assertEquals(listOf("10.38.120.101", "192.168.31.137"), office.lan)
        assertEquals(listOf("100.77.168.100"), office.tailnet)
        // Told the same again: nothing to save. Back home: the order turns, nothing is lost.
        assertNull(office.updated(with = MacAddresses(lan = listOf("10.38.120.101"), tailnet = listOf("100.77.168.100"))))
        val back = assertNotNull(office.updated(with = MacAddresses(lan = listOf("192.168.31.137"), tailnet = emptyList())))
        assertEquals(listOf("192.168.31.137", "10.38.120.101"), back.lan)
        // On both at once (two interfaces): both first, in the Mac's order.
        assertNull(back.updated(with = MacAddresses(lan = listOf("192.168.31.137", "10.38.120.101"), tailnet = emptyList())))
        assertEquals(listOf("10.38.120.101", "192.168.31.137"), back.updated(with = MacAddresses(lan = listOf("10.38.120.101", "192.168.31.137"), tailnet = emptyList()))?.lan)

        // The next morning at the office, no Bonjour on that network and Tailscale off: the address from yesterday answers.
        val prober = FakeProber(mapOf("10.38.120.101" to ProbeOutcome.Ok))
        val manager = manager(back, prober)
        val found = manager.endpoint()
        assertEquals(APIEndpoint(host = "10.38.120.101", port = 4713, kind = EndpointKind.Lan), found)

        // Only so many are kept, the newest first.
        var many = home
        for (i in 1..12) many = assertNotNull(many.updated(with = MacAddresses(lan = listOf("10.0.$i.2"), tailnet = emptyList())))
        assertEquals(ServerProfile.rememberedLAN, many.lan.size)
        assertEquals("10.0.12.2", many.lan.first())
        assertEquals("10.0.5.2", many.lan.last())
        assertFalse(many.lan.contains("192.168.31.137"), "the oldest go")
    }

    @Test
    fun revokedTokenSurfacesAsUnauthorized() = runTest {
        val manager = manager(book, FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Unauthorized)))
        assertEquals(APIError.Unauthorized, assertFailsWith<APIError> { manager.endpoint() })
        assertEquals(ConnectionState.Unauthorized, manager.current)
    }

    @Test
    fun pathChangeReselects() = runTest {
        val prober = FakeProber(mapOf("192.168.1.5" to ProbeOutcome.Ok, "100.101.102.103" to ProbeOutcome.Ok))
        val manager = manager(book, prober, settleDelay = 10.milliseconds)
        manager.endpoint()
        val paths = ScriptedPaths()
        manager.startMonitoring(paths)
        val states = manager.states().produceIn(backgroundScope)
        states.receive()  // current: connected(lan)

        prober.set("192.168.1.5", ProbeOutcome.Unreachable("cellular now"))
        paths.emit(NetworkPathSnapshot(satisfied = true, interfaces = listOf("wifi:en0")))   // baseline, no reselect
        paths.emit(NetworkPathSnapshot(satisfied = true, interfaces = listOf("cellular:pdp_ip0")))
        val seen = mutableListOf<ConnectionState>()
        for (s in states) {
            seen.add(s)
            if (s.endpoint != null) break
        }
        assertEquals(ConnectionState.Connected(APIEndpoint(host = "100.101.102.103", port = 4713, kind = EndpointKind.Tailnet)), seen.last())
        assertTrue(seen.contains(ConnectionState.Selecting))
        manager.stop()
    }

    @Test
    fun bonjourServiceWinsWhenFingerprintMatches() = runTest {
        val prefix = payload.fp.take(16)
        val discovery = FakeDiscovery(listOf(DiscoveredService(name = "AgentSwitch on Mac mini", fingerprintPrefix = prefix, host = "192.168.1.77", port = 4713)))
        val prober = FakeProber(mapOf("192.168.1.77" to ProbeOutcome.Ok, "192.168.1.5" to ProbeOutcome.Ok))
        val manager = manager(book, prober, discovery = discovery)
        val endpoint = manager.endpoint()
        assertEquals(APIEndpoint(host = "192.168.1.77", port = 4713, kind = EndpointKind.Bonjour), endpoint)
    }
}
