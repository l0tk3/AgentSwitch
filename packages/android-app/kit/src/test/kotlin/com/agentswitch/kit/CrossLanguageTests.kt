package com.agentswitch.kit

import com.agentswitch.kit.api.CertificatePin
import com.agentswitch.kit.secrets.GatePolicy
import com.agentswitch.kit.secrets.SecretKind
import com.agentswitch.kit.secrets.SecretPayload
import com.agentswitch.kit.secrets.SecretUse
import com.agentswitch.kit.secrets.TokenMinter
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

/**
 * Kotlin-minted tokens opened by the real Python gate (app-v0 §3, §7). Opt-in: `AGENTSWITCH_GATE_CROSSCHECK=1`, with
 * `AGENTSWITCH_PACKAGES` the repository's `packages/` folder (or `SECRET_GATE_BIN` and `SECRET_GATE_PYTHON`). Uses a
 * throw-away SECRET_GATE_HOME, never the user's own gate home, and never prints a secret value: the gate's `check`
 * shows metadata only, and payload bytes are compared by SHA-256 inside Python.
 */
class CrossLanguageTests {
    private var home: File? = null
    private lateinit var gate: String
    private lateinit var python: String

    @BeforeTest
    fun setUp() {
        assumeTrue(System.getenv("AGENTSWITCH_GATE_CROSSCHECK") == "1", "set AGENTSWITCH_GATE_CROSSCHECK=1")
        val venv = Proc.packagesRoot?.resolve("secret-gate/.venv/bin")
        gate = System.getenv("SECRET_GATE_BIN") ?: venv?.resolve("secret-gate")?.path ?: ""
        python = System.getenv("SECRET_GATE_PYTHON") ?: venv?.resolve("python")?.path ?: ""
        assumeTrue(File(gate).canExecute() && File(python).canExecute(), "secret-gate venv not found at $venv")
        val dir = Proc.temporaryDirectory("as-gate-crosscheck")
        home = dir
        val realHome = File(System.getProperty("user.home"), "." + "secret-gate").canonicalPath
        check(dir.canonicalPath != realHome && !dir.canonicalPath.startsWith(realHome)) { "must never touch the user's gate home" }
    }

    @AfterTest
    fun tearDown() {
        home?.deleteRecursively()
    }

    private val env: Map<String, String> get() = mapOf("SECRET_GATE_HOME" to home!!.path)

    private fun newKeypair(): String {
        val r = Proc.run(gate, listOf("keys", "--json", "new", "default", "--use"), env = env)
        assertEquals(0, r.status, r.stderr)
        val rows = KitJson.decodeFromString(JSONValue.serializer(), r.stdout).array.orEmpty()
        return assertNotNull(rows.firstOrNull { it["name"]?.string == "default" }?.get("public")?.string)
    }

    /** `secret-gate check`: `label: x` / `kind: y` / `hosts: ['a', 'b']` / `uses: ['http']`. */
    private fun check(token: String): Map<String, String>? {
        val r = Proc.run(gate, listOf("check", token), env = env)
        if (r.status != 0) return null
        val fields = mutableMapOf<String, String>()
        for (line in r.stdout.split("\n").filter { it.isNotEmpty() }) {
            val colon = line.indexOf(':')
            if (colon < 0) continue
            fields[line.substring(0, colon)] = line.substring(colon + 1).trim(' ', '\t')
        }
        return fields
    }

    private fun pyList(items: List<String>): String = "[" + items.joinToString(", ") { "'$it'" } + "]"

    @Test
    fun gateOpensKotlinTokens() {
        val minter = TokenMinter(newKeypair(), TestSodium.sealer)
        val payloads = listOf(
            SecretPayload.make(value = "pw-fake-1234", hosts = listOf("A.example.com", "*.b.example:8443"), uses = setOf(SecretUse.Http), label = "site-a/pass"),
            SecretPayload.make(value = "JBSW Y3DP EHPK 3PXP", hosts = listOf("*.corp.example"), uses = setOf(SecretUse.Otp, SecretUse.Fill),
                label = "corp/totp", kind = SecretKind.Totp, seedImportHosts = listOf("vpn.corp.example:443")),
            SecretPayload.make(value = "\"quote\" \\ 中文 😀 " + 0x7F.toChar() + "\n", hosts = listOf("192.168.1.5:8000"),
                uses = setOf(SecretUse.Exec, SecretUse.Http, SecretUse.Fill), label = "U.1_x-y"),
        )
        for (payload in payloads) {
            val token = minter.mint(payload)
            val fields = assertNotNull(check(token), "gate could not open ${payload.label}")
            assertEquals(payload.label, fields["label"])
            assertEquals(payload.kind.rawValue, fields["kind"])
            assertEquals(pyList(payload.hosts), fields["hosts"])
            assertEquals(pyList(payload.uses.map { it.rawValue }), fields["uses"])
            assertTrue(payloadBytesMatch(token, payload), "plaintext bytes differ from Python's to_json for ${payload.label}")
        }
    }

    @Test
    fun gateRejectsTamperedAndForeignTokens() {
        val minter = TokenMinter(newKeypair(), TestSodium.sealer)
        val payload = SecretPayload.make(value = "pw-fake", hosts = listOf("a.example.com"), uses = setOf(SecretUse.Http), label = "a")
        val token = minter.mint(payload).toCharArray()
        token[20] = if (token[20] == 'A') 'B' else 'A'
        assertNull(check(String(token)))
        val foreign = TokenMinter(TestSodium.keyPair().publicKey, TestSodium.sealer)
        assertNull(check(foreign.mint(payload)))
    }

    /**
     * Decrypts with the gate's own code and compares SHA-256 of the plaintext with Kotlin's bytes and with Python's
     * canonical `to_json()`; prints only booleans.
     */
    private fun payloadBytesMatch(token: String, payload: SecretPayload): Boolean {
        val script = """
            import hashlib, json, sys
            from secret_gate.keystore import gate_home, load_private_key
            from secret_gate.crypto import decrypt, b64url_decode
            from secret_gate.policy import SecretPayload
            req = json.load(sys.stdin)
            plain = decrypt(load_private_key(gate_home()), b64url_decode(req["token"][len("enc:v1:"):]))
            canon = SecretPayload.from_json(plain).to_json().encode("utf-8")
            digest = hashlib.sha256(plain).hexdigest()
            print(json.dumps({"swift": digest == req["sha256"], "canonical": hashlib.sha256(canon).hexdigest() == digest}))
        """.trimIndent()
        val digest = CertificatePin.fingerprint(payload.jsonData)  // SHA-256 hex
        val r = Proc.run(python, listOf("-c", script), env = env, stdin = json(mapOf("token" to token, "sha256" to digest)))
        assertEquals(0, r.status, "python helper failed")
        val verdict = KitJson.decodeFromString(JSONValue.serializer(), r.stdout)
        return verdict["swift"]?.bool == true && verdict["canonical"]?.bool == true
    }

    /**
     * The same host / label / base32 tables through policy.py and GatePolicy: Kotlin must never accept what Python
     * rejects, and must normalize identically where both accept.
     */
    @Test
    fun policyAgreesWithPython() {
        val hosts = listOf("Site.Example.COM", " example.com. ", "example.com:8001", "example.com.:0443", "*.Example.com", "*.com",
            "192.168.1.5", "", "exa mple.com", "example.com:", ":443", "example.com:0", "example.com:65536", "a:b:1",
            "-bad.com", "bad-.com", "*", "a..b", "a.*.b", "under_score.com", "https://x.com", "例子.com", "x.y.z:1")
        val labels = listOf("a", "site-a/pass", "A.b_c-d/e", "-a", "/a", "a b", "a:b", "ä", "x".repeat(64), "x".repeat(65))
        val base32 = listOf("JBSWY3DPEHPK3PXP", "jbswy3dpehpk3pxp", "JBSW Y3DP", "MZXW6YQ", "MZXW6===", "MY", "A", "ABC", "ABCDEF", "MZ=XW6YQ", "JBSWY3DPEHPK3PX1")
        val script = """
            import json, sys
            from secret_gate.policy import normalize_host, _validate_base32
            from secret_gate.constants import LABEL_PATTERN
            req = json.load(sys.stdin)
            def host(h):
                try: return normalize_host(h)
                except Exception: return None
            def b32(v):
                try: _validate_base32(v); return True
                except Exception: return False
            print(json.dumps({"hosts": [host(h) for h in req["hosts"]], "labels": [bool(LABEL_PATTERN.match(l)) for l in req["labels"]],
                              "base32": [b32(v) for v in req["base32"]]}))
        """.trimIndent()
        val r = Proc.run(python, listOf("-c", script), env = env, stdin = json(mapOf("hosts" to hosts, "labels" to labels, "base32" to base32)))
        assertEquals(0, r.status, r.stderr)
        val py = KitJson.decodeFromString(JSONValue.serializer(), r.stdout)
        for ((i, h) in hosts.withIndex()) {
            assertEquals(py["hosts"]?.array?.get(i)?.string, runCatching { GatePolicy.normalizeHost(h) }.getOrNull(), "host $h")
        }
        for ((i, l) in labels.withIndex()) {
            assertEquals(py["labels"]?.array?.get(i)?.bool, GatePolicy.isValidLabel(l), "label $l")
        }
        for ((i, v) in base32.withIndex()) {
            assertEquals(py["base32"]?.array?.get(i)?.bool, GatePolicy.isBase32(v), "base32 $v")
        }
    }
}
