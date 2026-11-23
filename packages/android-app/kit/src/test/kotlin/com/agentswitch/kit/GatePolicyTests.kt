package com.agentswitch.kit

import com.agentswitch.kit.secrets.GatePolicy
import com.agentswitch.kit.secrets.GatePolicyError
import com.agentswitch.kit.secrets.SecretDraft
import com.agentswitch.kit.secrets.SecretKind
import com.agentswitch.kit.secrets.SecretPayload
import com.agentswitch.kit.secrets.SecretUse
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Cases mirror packages/secret-gate/tests (policy.py behaviour); CrossLanguageTests checks the same tables against the
 * real Python code when the gate venv is present.
 */
class GatePolicyTests {
    @Test
    fun labels() {
        for (ok in listOf("a", "site-a/pass", "A.b_c-d/e", "9", "x".repeat(64))) {
            assertTrue(GatePolicy.isValidLabel(ok), ok)
        }
        for (bad in listOf("", "-a", "/a", ".a", "a b", "a:b", "ä", "x".repeat(65), "abc\n")) {
            assertFalse(GatePolicy.isValidLabel(bad), bad)
        }
    }

    @Test
    fun hostNormalization() {
        val cases = listOf(
            "Site.Example.COM" to "site.example.com",
            "  example.com.  " to "example.com",
            "example.com:8001" to "example.com:8001",
            "example.com.:0443" to "example.com:443",
            "*.Example.com" to "*.example.com",
            "192.168.1.5" to "192.168.1.5",
            "localhost:65535" to "localhost:65535",
            "*.com" to "*.com",
        )
        for ((input, expected) in cases) {
            assertEquals(expected, GatePolicy.normalizeHost(input), input)
        }
        for (bad in listOf("", "exa mple.com", "example.com:", ":443", "example.com:0", "example.com:65536", "a:b:1",
            "-bad.com", "bad-.com", "*", "*.", "a..b", "a.*.b", "under_score.com", "https://x.com", "例子.com", "x.com:٤٤٣")) {
            assertFailsWith<GatePolicyError>(bad) { GatePolicy.normalizeHost(bad) }
        }
    }

    @Test
    fun hostMatches() {
        assertTrue(GatePolicy.hostMatches(pattern = "example.com", host = "example.com:8443"))
        assertTrue(GatePolicy.hostMatches(pattern = "example.com:8443", host = "example.com:8443"))
        assertFalse(GatePolicy.hostMatches(pattern = "example.com:8443", host = "example.com"))
        assertTrue(GatePolicy.hostMatches(pattern = "*.example.com", host = "a.example.com"))
        assertFalse(GatePolicy.hostMatches(pattern = "*.example.com", host = "example.com"))
        assertFalse(GatePolicy.hostMatches(pattern = "*.example.com", host = "badexample.com"))
    }

    @Test
    fun base32() {
        for (ok in listOf("JBSWY3DPEHPK3PXP", "jbswy3dpehpk3pxp", "JBSW Y3DP EHPK 3PXP", "MZXW6YQ", "MZXW6===", "MY", "")) {
            assertTrue(GatePolicy.isBase32(ok), ok)
        }
        for (bad in listOf("JBSWY3DPEHPK3PX1", "A", "ABC", "ABCDEF", "MZ=XW6YQ", "MZXW6YQ=====", "密钥")) {
            assertFalse(GatePolicy.isBase32(bad), bad)
        }
    }
}

class SecretPayloadTests {
    @Test
    fun jsonMatchesPythonToJSON() {
        val p = SecretPayload.make(value = "pw-fake-1234", hosts = listOf("A.example.com", "*.b.com:8443"),
            uses = setOf(SecretUse.Http, SecretUse.Exec), label = "site-a/pass")
        assertEquals(
            """{"v":"pw-fake-1234","host":["a.example.com","*.b.com:8443"],"use":["exec","http"],"label":"site-a/pass","kind":"secret"}""",
            p.jsonText,
        )
    }

    @Test
    fun ensureASCIIEscaping() {
        val value = "q\"b\\s/\n\r\t" + "\u0008\u000C\u0001\u007F" + "é中😀"
        val p = SecretPayload.make(value = value, hosts = emptyList(), uses = setOf(SecretUse.Fill), label = "x")
        val expected = """{"v":"q\"b\\s/\n\r\t\b\f#u0001#u007f#u00e9#u4e2d#ud83d#ude00","host":[],"use":["fill"],"label":"x","kind":"secret"}"""
            .replace("#u", "\\u")
        assertEquals(expected, p.jsonText)
        val decoded = KitJson.decodeFromString(JSONValue.serializer(), p.jsonData.toString(Charsets.UTF_8))
        assertEquals(value, decoded["v"]?.string)
    }

    @Test
    fun validationMirrorsCreate() {
        assertEquals(GatePolicyError.EmptyValue, assertFailsWith<GatePolicyError> {
            SecretPayload.make(value = "", hosts = emptyList(), uses = setOf(SecretUse.Http), label = "a")
        })
        assertEquals(GatePolicyError.EmptyUses, assertFailsWith<GatePolicyError> {
            SecretPayload.make(value = "v", hosts = emptyList(), uses = emptySet(), label = "a")
        })
        assertFailsWith<GatePolicyError> { SecretPayload.make(value = "v", hosts = emptyList(), uses = setOf(SecretUse.Http), label = "-a") }
        assertFailsWith<GatePolicyError> { SecretPayload.make(value = "v", hosts = listOf("bad host"), uses = setOf(SecretUse.Http), label = "a") }
        assertEquals(GatePolicyError.TotpNotBase32, assertFailsWith<GatePolicyError> {
            SecretPayload.make(value = "not base32!", hosts = emptyList(), uses = setOf(SecretUse.Otp), label = "a", kind = SecretKind.Totp)
        })
    }
}

class SecretDraftTests {
    @Test
    fun sitesBecomeHosts() {
        val d = SecretDraft(label = "core", sites = "https://user@core.example:8600/login?x, core.example:8600 | *.b.com，c.com", value = "v")
        assertEquals(4, d.siteList.size)
        assertEquals(listOf("core.example:8600", "*.b.com", "c.com"), d.hostList)
        val clean = SecretDraft(label = "core", sites = "https://core.example:8600/login, *.b.com", value = "v-long-enough")
        assertEquals(listOf("core.example:8600", "*.b.com"), clean.hostList)
        assertNull(clean.problem)
        assertEquals("core → core.example:8600, *.b.com", clean.effectiveNote)
    }

    @Test
    fun problems() {
        assertEquals(setOf(SecretUse.Http, SecretUse.Fill), SecretDraft(label = "a", sites = "a.com", value = "v").uses)   // website password by default
        assertEquals("缺少 label", SecretDraft(label = "", value = "v").problem)
        assertEquals("缺少值", SecretDraft(label = "a", value = "").problem)
        assertEquals("http / fill 用途须填写站点", SecretDraft(label = "a", sites = "", value = "v").problem)
        assertEquals("otp 用途仅适用于 TOTP", SecretDraft(label = "a", sites = "a.com", uses = setOf(SecretUse.Otp), value = "v").problem)
        assertNotNull(SecretDraft(label = "a", sites = "a.com", kind = SecretKind.Totp, uses = setOf(SecretUse.Otp), value = "xyz!").problem)
        assertNull(SecretDraft(label = "a", sites = "", kind = SecretKind.Totp, uses = setOf(SecretUse.Otp), value = "JBSWY3DPEHPK3PXP").problem)
        assertEquals("值至少需要 8 个字符（过短的值遮不住，也容易被猜到）", SecretDraft(label = "a", sites = "a.com", value = "1234567").problem)
        assertEquals("值至少需要 8 个字符（过短的值遮不住，也容易被猜到）", SecretDraft(label = "a", uses = setOf(SecretUse.Exec), value = "short").problem)
        assertNull(SecretDraft(label = "a", sites = "a.com", value = "12345678").problem)
        assertNull(SecretDraft(label = "a", sites = "", kind = SecretKind.Totp, uses = setOf(SecretUse.Otp), value = "MZXW6YQ").problem)
    }

    /** gate-simple-v0 §3.3, policy.check_seal_length: under 8 characters is not sealed for http / fill / exec. */
    @Test
    fun sealLengthFloor() {
        for (use in listOf(SecretUse.Http, SecretUse.Fill, SecretUse.Exec)) {
            val e = assertFailsWith<GatePolicyError> { SecretPayload.make(value = "1234567", hosts = listOf("a.com"), uses = setOf(use), label = "a") }
            assertEquals(GatePolicyError.ValueTooShort, e)
            assertEquals("值至少需要 8 个字符（过短的值遮不住，也容易被猜到）", e.message)
            SecretPayload.make(value = "12345678", hosts = listOf("a.com"), uses = setOf(use), label = "a")
            // Code points, as Python counts: seven CJK characters (21 bytes) or seven emoji (14 UTF-16 units) are short.
            assertFailsWith<GatePolicyError> { SecretPayload.make(value = "密码密码密码密", hosts = listOf("a.com"), uses = setOf(use), label = "a") }
            assertFailsWith<GatePolicyError> { SecretPayload.make(value = "😀".repeat(7), hosts = listOf("a.com"), uses = setOf(use), label = "a") }
            SecretPayload.make(value = "密码密码密码密码", hosts = listOf("a.com"), uses = setOf(use), label = "a")
        }
        SecretPayload.make(value = "MZXW6YQ", hosts = emptyList(), uses = setOf(SecretUse.Otp), label = "t", kind = SecretKind.Totp)   // a seed: base32 only
        assertFailsWith<GatePolicyError> {
            SecretPayload.make(value = "MZXW6YQ", hosts = listOf("a.com"), uses = setOf(SecretUse.Otp, SecretUse.Fill), label = "t", kind = SecretKind.Totp)
        }
    }
}
