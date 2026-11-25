package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.pairing.*
import com.agentswitch.kit.storage.*
import com.agentswitch.kit.support.KitJson
import java.io.File
import java.nio.file.Files
import kotlin.test.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonPrimitive

class LocalStoreTests {
    private fun tempDir(): File = Files.createTempDirectory("as-store-").toFile().also { it.deleteRecursively() }

    @Test
    fun macsRoundTrip() {
        val dir = tempDir()
        try {
            val store = LocalStore(directory = dir)
            assertTrue(store.loadMacs().isEmpty)

            val profile = ServerProfile(payload = PairingPayload.sample(), deviceId = "dev1", pairedAt = 1_790_000_000_000)
            val other = profile(fp = "cd", name = "MacBook")
            val macs = PairedMacs().adding(profile).adding(other)
            store.saveMacs(macs)
            assertEquals(macs, store.loadMacs())
            assertEquals(other, store.loadMacs().current)

            store.saveMacs(PairedMacs())
            assertTrue(store.loadMacs().isEmpty)
        } finally {
            dir.deleteRecursively()
        }
    }

    /** A phone updated from the one-Mac version keeps its pairing: `server.json` becomes a one-Mac `macs.json`. */
    @Test
    fun migratesTheSingleProfile() {
        val dir = tempDir()
        try {
            dir.mkdirs()
            val profile = ServerProfile(payload = PairingPayload.sample(), deviceId = "dev1", pairedAt = 1_790_000_000_000)
            val legacy = File(dir, "server.json")
            legacy.writeText(KitJson.encodeToString(ServerProfile.serializer(), profile))

            val store = LocalStore(directory = dir)
            val macs = store.loadMacs()
            assertEquals(listOf(profile), macs.servers)
            assertEquals(profile, macs.current)
            assertFalse(legacy.exists())
            assertEquals(macs, store.loadMacs())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun pairedMacs() {
        val a = profile(fp = "aa", name = "Mac mini")
        val b = profile(fp = "bb", name = "MacBook")
        var macs = PairedMacs().adding(a)
        assertEquals(a, macs.current)
        macs = macs.adding(b)
        assertEquals(listOf(a, b), macs.servers)
        assertEquals(b, macs.current, "a new pairing becomes the current Mac")

        val renewed = profile(fp = "aa", name = "Mac mini", deviceId = "dev2")
        macs = macs.adding(renewed)
        assertEquals(listOf(renewed, b), macs.servers, "pairing the same Mac again replaces it in place")
        assertEquals(renewed, macs.current)

        macs = macs.activating(b.fingerprint)
        assertEquals(b, macs.current)
        assertEquals(macs, macs.activating("zz"), "unknown Macs change nothing")

        val moved = b.updated(with = MacAddresses(lan = listOf("10.0.0.9"), tailnet = emptyList()))!!
        assertEquals(moved, macs.updating(moved).current)
        assertEquals(macs, macs.updating(profile(fp = "zz", name = "?")))

        assertEquals(b, macs.removing(a.fingerprint).current, "removing another Mac keeps the current one")
        macs = macs.removing(b.fingerprint)
        assertEquals(renewed, macs.current, "removing the current Mac moves to the first left")
        macs = macs.removing(a.fingerprint)
        assertTrue(macs.isEmpty)
        assertNull(macs.current)
        assertEquals(a, PairedMacs(servers = listOf(a), active = "gone").current, "a stale current Mac falls back to the first")
    }

    private fun profile(fp: String, name: String, deviceId: String = "dev1"): ServerProfile =
        ServerProfile(name = name, port = 4713, fingerprint = fp.repeat(32), lan = listOf("192.168.1.5"), tailnet = emptyList(),
            bonjour = "AgentSwitch on $name", deviceId = deviceId, pairedAt = 1_790_000_000_000)

    /** The in-memory half of Swift's testVaults; the Keychain half is iOS's (the app's Keystore vault is not in the kit). */
    @Test
    fun vaults() {
        val vault = MemoryTokenVault()
        vault.save("tok", account = "fp")
        assertEquals("tok", vault.load(account = "fp"))
        vault.delete(account = "fp")
        assertNull(vault.load(account = "fp"))
    }
}

class PairingServiceTests {
    private fun transport(pairStatus: Int = 200): FakeTransport = FakeTransport({ req, _ ->
        when (req.path) {
            "/healthz" -> json(mapOf("ok" to true)) to httpResponse(req.url)
            "/pair" -> if (pairStatus != 200) json(mapOf("error" to "invalid code")) to httpResponse(req.url, status = pairStatus)
                else json(mapOf("deviceId" to "dev-9", "token" to "tok-9")) to httpResponse(req.url)
            else -> json(mapOf("error" to "not found")) to httpResponse(req.url, status = 404)
        }
    })

    @Test
    fun pairsOverTheFirstReachableAddress() = runTest {
        val t = transport()
        val outcome = PairingService(transport = t, discovery = null).pair(PairingPayload.sample(), deviceName = "我的 iPhone")
        assertEquals("tok-9", outcome.token)
        assertEquals("dev-9", outcome.profile.deviceId)
        assertEquals(EndpointKind.Lan, outcome.endpoint.kind)
        val pair = assertNotNull(t.requests.firstOrNull { it.path == "/pair" })
        assertNull(pair.header("Authorization"))
        val body = assertNotNull(pair.jsonBody).mapValues { it.value.jsonPrimitive.content }
        assertEquals(mapOf("code" to "7K3M-9QZX", "name" to "我的 iPhone", "platform" to "android"), body)
        assertEquals(listOf("/pair"), t.paths.filter { it != "/healthz" }, "nothing else is asked of the Mac")
    }

    @Test
    fun anEmptyNameFallsBack() = runTest {
        val t = transport()
        PairingService(transport = t, discovery = null).pair(PairingPayload.sample(), deviceName = "")
        assertEquals("Android", t.requests.first { it.path == "/pair" }.jsonBody?.get("name")?.jsonPrimitive?.content, "an empty name falls back")
    }

    @Test
    fun rejectedCode() = runTest {
        val error = assertFailsWith<PairingError> {
            PairingService(transport = transport(pairStatus = 401), discovery = null).pair(PairingPayload.sample(), deviceName = "x")
        }
        assertEquals(PairingError.CodeRejected, error)
    }

    @Test
    fun rateLimited() = runTest {
        val t = FakeTransport({ req, _ ->
            if (req.path == "/pair") json(mapOf("error" to "too many pairing attempts; wait a minute")) to httpResponse(req.url, status = 429)
            else json(mapOf("ok" to true)) to httpResponse(req.url)
        })
        val error = assertFailsWith<PairingError> {
            PairingService(transport = t, discovery = null).pair(PairingPayload.sample(), deviceName = "长".repeat(80))
        }
        assertEquals(PairingError.RateLimited, error)
        val name = t.requests.firstOrNull { it.path == "/pair" }?.jsonBody?.get("name")?.jsonPrimitive?.content
        assertEquals(64, name?.length)
    }

    @Test
    fun unreachable() = runTest {
        val t = FakeTransport({ _, _ -> throw APIError.Transport("offline") })
        val error = assertFailsWith<PairingError> { PairingService(transport = t, discovery = null).pair(PairingPayload.sample(), deviceName = "x") }
        assertEquals(PairingError.Unreachable, error)
    }
}
