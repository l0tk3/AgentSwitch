package com.agentswitch.kit.secrets

import com.agentswitch.kit.support.Base64URL

sealed class TokenError(message: String) : Exception(message) {
    data object BadPublicKey : TokenError("gate 公钥无效（应为 32 字节 base64url）")
    data object SealFailed : TokenError("加密失败")
}

/** libsodium's `crypto_box_seal`: the app gives the kit libsodium itself; nothing is hand-written here. */
fun interface BoxSealer {
    fun seal(message: ByteArray, recipientPublicKey: ByteArray): ByteArray
}

/**
 * Mints `enc:v1:` tokens on the phone, compatible with `secret-gate enc`: the payload JSON sealed with libsodium
 * `crypto_box_seal` to the gate's X25519 public key, then base64url without padding. The plaintext never leaves the
 * device; only the Mac's gate can open the result. The sealing itself is the [BoxSealer] the app hands over.
 */
class TokenMinter(publicKey: ByteArray, private val sealer: BoxSealer) {
    val publicKey: ByteArray

    init {
        if (publicKey.size != publicKeyBytes) throw TokenError.BadPublicKey
        this.publicKey = publicKey.copyOf()
    }

    /** The key as the pairing payload and `GET /gate/pubkey` carry it. */
    constructor(publicKeyBase64URL: String, sealer: BoxSealer) :
        this(decodePublicKey(publicKeyBase64URL) ?: throw TokenError.BadPublicKey, sealer)

    fun mint(payload: SecretPayload): String {
        val sealed = try {
            sealer.seal(payload.jsonData, publicKey.copyOf())
        } catch (e: Exception) {
            throw TokenError.SealFailed
        }
        return prefix + Base64URL.encode(sealed)
    }

    companion object {
        const val prefix = "enc:v1:"
        const val publicKeyBytes = 32

        /** The key's bytes as the pairing payload carries them (trimmed, base64url), or null when it is not one. */
        private fun decodePublicKey(text: String): ByteArray? = Base64URL.decode(text.trimmingWhitespacesAndNewlines())

        /** Whether `text` is a gate public key a minter accepts (base64url of 32 bytes), with no sealer needed. */
        fun isValidPublicKey(publicKeyBase64URL: String): Boolean = decodePublicKey(publicKeyBase64URL)?.size == publicKeyBytes

        /** `enc:v1:[A-Za-z0-9_-]{16,}={0,2}` (constants.TOKEN_PATTERN), the whole string. */
        fun looksLikeToken(text: String): Boolean {
            if (!text.startsWith(prefix)) return false
            var body = text.substring(prefix.length)
            var padding = 0
            while (body.endsWith("=")) { body = body.dropLast(1); padding += 1 }
            return padding <= 2 && body.length >= 16 && Base64URL.decode(body) != null
        }
    }
}
