package com.agentswitch.kit

import com.agentswitch.kit.pairing.HostAddress
import com.agentswitch.kit.pairing.PairingLink
import com.agentswitch.kit.pairing.PairingLinkError
import com.agentswitch.kit.pairing.PairingPayload
import com.agentswitch.kit.support.Base64URL
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PairingLinkTests {
    private fun link(obj: Map<String, Any?>): String = "agentswitch://pair?p=" + Base64URL.encode(json(obj))

    private val docExample: Map<String, Any?>
        get() = mapOf(
            "v" to 1, "name" to "Mac mini", "port" to 4713, "fp" to "AB".repeat(32), "code" to "7k3m-9qzx",
            "lan" to listOf("192.168.1.5"), "tailnet" to listOf("100.101.102.103", "mac.tail1234.ts.net"),
            "bonjour" to "AgentSwitch on Mac mini", "gate" to mapOf("publicKey" to PairingPayload.sampleKey, "keypair" to "default"),
        )

    @Test
    fun parsesTheDocExampleAndNormalizes() {
        val p = PairingLink.parse(link(docExample))
        assertEquals("Mac mini", p.name)
        assertEquals(4713, p.port)
        assertEquals("ab".repeat(32), p.fp)
        assertEquals("7K3M-9QZX", p.code)
        assertEquals(listOf("100.101.102.103", "mac.tail1234.ts.net"), p.tailnet)
        assertEquals("default", p.gate?.keypair)
    }

    @Test
    fun codeDecodesLikeTheDaemon() {
        assertEquals("7K3M-9QZ0", PairingLink.normalizeCode("7k3m 9qzo"))
        assertEquals("1100-0000", PairingLink.normalizeCode("IL00-0000"))
        assertNull(PairingLink.normalizeCode("UUUU-UUUU"))
    }

    @Test
    fun findsTheLinkInsidePastedText() {
        val text = "在手机上打开：\n${link(docExample)}  （5 分钟内有效）"
        assertEquals("Mac mini", PairingLink.parse(text).name)
    }

    @Test
    fun roundTripThroughMake() {
        val p = PairingPayload.sample()
        assertEquals(p, PairingLink.parse(PairingLink.make(p)))
    }

    @Test
    fun gateIsOptionalButMustBeValidWhenPresent() {
        val noGate = docExample - "gate"
        assertNull(PairingLink.parse(link(noGate)).gate)
        val badGate = docExample + ("gate" to mapOf("publicKey" to "AAAA", "keypair" to "default"))
        assertEquals(PairingLinkError.InvalidField("gate.publicKey"), assertFailsWith<PairingLinkError> { PairingLink.parse(link(badGate)) })
    }

    @Test
    fun rejections() {
        val cases = listOf(
            "https://example.com/pair?p=x" to PairingLinkError.NotALink,
            "agentswitch://other?p=x" to PairingLinkError.NotALink,
            "agentswitch://pair" to PairingLinkError.MissingPayload,
            "agentswitch://pair?p=***" to PairingLinkError.BadEncoding,
            "agentswitch://pair?p=" + Base64URL.encode("not json".toByteArray()) to PairingLinkError.BadJSON,
        )
        for ((text, error) in cases) {
            assertEquals(error, assertFailsWith<PairingLinkError>(text) { PairingLink.parse(text) }, text)
        }
        fun rejects(key: String, value: Any, expected: PairingLinkError) {
            val obj = docExample + (key to value)
            assertEquals(expected, assertFailsWith<PairingLinkError>(key) { PairingLink.parse(link(obj)) }, key)
        }
        rejects("v", 2, PairingLinkError.UnsupportedVersion(2))
        rejects("fp", "abcd", PairingLinkError.InvalidField("fp"))
        rejects("fp", "zz".repeat(32), PairingLinkError.InvalidField("fp"))
        rejects("code", "ABCD-EFGU", PairingLinkError.InvalidField("code"))
        rejects("code", "ABC", PairingLinkError.InvalidField("code"))
        rejects("code", "ABCD-EFG!", PairingLinkError.InvalidField("code"))
        rejects("port", 0, PairingLinkError.InvalidField("port"))
        rejects("name", "  ", PairingLinkError.InvalidField("name"))
        rejects("lan", listOf("192.168.1.5/evil?x"), PairingLinkError.InvalidField("lan"))
        rejects("tailnet", listOf("host name"), PairingLinkError.InvalidField("tailnet"))
    }

    @Test
    fun addressKinds() {
        assertTrue(HostAddress.isIPv4("100.101.102.103"))
        assertTrue(HostAddress.isIPv6("fd7a:115c:a1e0::1"))
        assertTrue(HostAddress.isDNSName("mac.tail1234.ts.net"))
        assertFalse(HostAddress.isValid("a/b"))
        assertFalse(HostAddress.isValid("-a.com"))
        assertEquals("[fd7a:115c:a1e0::1]", HostAddress.urlHost("fd7a:115c:a1e0::1"))
    }

    /** Not in the Swift tests (there `inet_pton` is the system's): the literal checks accept what `inet_pton` accepts. */
    @Test
    fun ipLiteralsAsInetPton() {
        for (ok in listOf("0.0.0.0", "255.255.255.255", "10.0.0.1")) assertTrue(HostAddress.isIPv4(ok), ok)
        for (bad in listOf("", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1..2.3", "1.2.3.4.", " 1.2.3.4", "1.2.3.a", "localhost")) {
            assertFalse(HostAddress.isIPv4(bad), bad)
        }
        for (ok in listOf("::", "::1", "1::", "fe80::1", "2001:db8:0:0:0:0:2:1", "::ffff:192.168.1.5", "64:ff9b::1.2.3.4",
            "1:2:3:4:5:6:1.2.3.4", "ABCD:EF01::", "1:2:3:4:5:6:7::")) {
            assertTrue(HostAddress.isIPv6(ok), ok)
        }
        for (bad in listOf("", ":", ":1", "1:", ":::", "1::2::3", "12345::", "fe80::1%en0", "[::1]", "1:2:3:4:5:6:7:8:9",
            "1:2:3:4:5:6:7:1.2.3.4", "::1.2.3", "g::1", "1:2:3:4:5:6:7:8::", "mac.local")) {
            assertFalse(HostAddress.isIPv6(bad), bad)
        }
    }

    @Test
    fun profileFromPayload() {
        val profile = com.agentswitch.kit.pairing.ServerProfile(payload = PairingPayload.sample(), deviceId = "dev1", gate = null)
        assertEquals("default", profile.gate?.keypair, "falls back to the payload's key")
        assertEquals(profile.fingerprint, profile.tokenAccount)
        assertEquals("abcd ef01 2345", com.agentswitch.kit.pairing.ServerProfile.grouped("abcdef012345"))
        val rotated = profile.with(gate = com.agentswitch.kit.pairing.GateKey(publicKey = PairingPayload.sampleKey, keypair = "work"))
        assertEquals("work", rotated.gate?.keypair)
        assertEquals("dev1", rotated.deviceId)
    }
}
