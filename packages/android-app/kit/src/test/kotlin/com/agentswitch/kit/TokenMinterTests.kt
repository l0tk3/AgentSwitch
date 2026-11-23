package com.agentswitch.kit

import com.agentswitch.kit.secrets.SecretPayload
import com.agentswitch.kit.secrets.SecretUse
import com.agentswitch.kit.support.JSONValue
import com.agentswitch.kit.support.KitJson
import com.agentswitch.kit.secrets.TokenError
import com.agentswitch.kit.secrets.TokenMinter
import com.agentswitch.kit.support.Base64URL
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TokenMinterTests {
    @Test
    fun sealedTokenOpensToThePayload() {
        val pair = TestSodium.keyPair()
        val minter = TokenMinter(Base64URL.encode(pair.publicKey), TestSodium.sealer)
        val payload = SecretPayload.make(value = "pw-fake-1234", hosts = listOf("a.example.com"), uses = setOf(SecretUse.Http), label = "a/pass")
        val token = minter.mint(payload)

        assertTrue(token.startsWith("enc:v1:"))
        assertFalse(token.contains("="), "no padding")
        assertTrue(TokenMinter.looksLikeToken(token))
        val sealed = assertNotNull(Base64URL.decode(token.drop(7)))
        assertEquals(48 + payload.sealedData.size, sealed.size, "crypto_box_seal: 32-byte ephemeral key + 16-byte MAC")
        val opened = assertNotNull(TestSodium.open(sealed, pair.publicKey, pair.secretKey))
        assertContentEquals(payload.sealedData, opened)
        assertEquals(KitJson.decodeFromString(JSONValue.serializer(), payload.jsonText),
            KitJson.decodeFromString(JSONValue.serializer(), String(opened, Charsets.UTF_8)), "a JSON reader takes the padding as is")
    }

    /** gate-simple-v0 §3.4: values of 1..200 characters give ciphertexts in 64-byte steps, each opening to its payload. */
    @Test
    fun ciphertextLengthComesInSixtyFourByteSteps() {
        val pair = TestSodium.keyPair()
        val minter = TokenMinter(pair.publicKey, TestSodium.sealer)
        val lengths = mutableSetOf<Int>()
        for (n in 1..200) {
            // `otp` has no length floor, so the short values can be minted too (the length rule is tested on its own).
            val payload = SecretPayload.make(value = "x".repeat(n), hosts = listOf("a.example.com"), uses = setOf(SecretUse.Otp), label = "a/pass")
            val sealed = assertNotNull(Base64URL.decode(minter.mint(payload).drop(7)))
            assertEquals(0, (sealed.size - 48) % 64, "value of $n")
            lengths.add(sealed.size)
            val opened = assertNotNull(TestSodium.open(sealed, pair.publicKey, pair.secretKey))
            assertEquals(payload.jsonText, String(opened, Charsets.UTF_8).trimEnd(' '))
        }
        assertEquals(4, lengths.size, "200 lengths collapse into four sizes")
    }

    @Test
    fun paddingIsExact() {
        val short = SecretPayload.make(value = "12345678", hosts = emptyList(), uses = setOf(SecretUse.Exec), label = "x")
        assertEquals(0, short.sealedData.size % 64)
        assertContentEquals(short.jsonData, short.sealedData.copyOfRange(0, short.jsonData.size))
        assertTrue(short.sealedData.drop(short.jsonData.size).all { it == 0x20.toByte() })
        // A JSON already a multiple of 64 bytes gets nothing added.
        val base = short.jsonData.size
        val exact = SecretPayload.make(value = "y".repeat(8 + (64 - base % 64) % 64), hosts = emptyList(), uses = setOf(SecretUse.Exec), label = "x")
        assertEquals(0, exact.jsonData.size % 64)
        assertContentEquals(exact.jsonData, exact.sealedData)
    }

    @Test
    fun everyTokenIsFresh() {
        val minter = TokenMinter(ByteArray(32) { 9 }, TestSodium.sealer)
        val payload = SecretPayload.make(value = "v-fresh-1", hosts = emptyList(), uses = setOf(SecretUse.Fill), label = "x")
        assertNotEquals(minter.mint(payload), minter.mint(payload))
    }

    @Test
    fun rejectsBadKeys() {
        assertEquals(TokenError.BadPublicKey, assertFailsWith<TokenError> { TokenMinter("short", TestSodium.sealer) })
        assertFailsWith<TokenError> { TokenMinter("not+base64/url", TestSodium.sealer) }
        assertFailsWith<TokenError> { TokenMinter(ByteArray(31) { 1 }, TestSodium.sealer) }
        assertFalse(TokenMinter.isValidPublicKey("short"))
        assertTrue(TokenMinter.isValidPublicKey(" " + Base64URL.encode(ByteArray(32)) + "\n"))
    }

    @Test
    fun sealerFailureIsSealFailed() {
        val minter = TokenMinter(ByteArray(32), { _, _ -> error("no libsodium") })
        val payload = SecretPayload.make(value = "v-fresh-1", hosts = emptyList(), uses = setOf(SecretUse.Fill), label = "x")
        assertEquals(TokenError.SealFailed, assertFailsWith<TokenError> { minter.mint(payload) })
    }

    @Test
    fun looksLikeToken() {
        assertFalse(TokenMinter.looksLikeToken("enc:v1:short"))
        assertFalse(TokenMinter.looksLikeToken("enc:v2:AAAAAAAAAAAAAAAAAAAA"))
        assertTrue(TokenMinter.looksLikeToken("enc:v1:AAAAAAAAAAAAAAAAAAAA"))
    }

    @Test
    fun base64URL() {
        val bytes = byteArrayOf(0xfb.toByte(), 0xff.toByte(), 0xfe.toByte(), 0x00, 0x10)
        assertEquals("-__-ABA", Base64URL.encode(bytes))
        assertContentEquals(bytes, Base64URL.decode("-__-ABA"))
        assertContentEquals(bytes, Base64URL.decode("-__-ABA="))
        assertNull(Base64URL.decode("+//+ABA="))
        assertNull(Base64URL.decode("-__-ABA==="))
    }
}
