package com.agentswitch.kit

import com.agentswitch.kit.secrets.SecretPayload
import com.agentswitch.kit.secrets.SecretUse
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
        assertEquals(48 + payload.jsonData.size, sealed.size, "crypto_box_seal: 32-byte ephemeral key + 16-byte MAC")
        val opened = assertNotNull(TestSodium.open(sealed, pair.publicKey, pair.secretKey))
        assertContentEquals(payload.jsonData, opened)
    }

    @Test
    fun everyTokenIsFresh() {
        val minter = TokenMinter(ByteArray(32) { 9 }, TestSodium.sealer)
        val payload = SecretPayload.make(value = "v", hosts = emptyList(), uses = setOf(SecretUse.Fill), label = "x")
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
        val payload = SecretPayload.make(value = "v", hosts = emptyList(), uses = setOf(SecretUse.Fill), label = "x")
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
