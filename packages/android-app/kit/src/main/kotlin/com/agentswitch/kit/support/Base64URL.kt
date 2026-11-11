package com.agentswitch.kit.support

import java.util.Base64

/**
 * base64url as the gate and the daemon write it: `-_` alphabet, padding stripped. Decoding accepts optional padding
 * but nothing outside the url-safe alphabet.
 */
object Base64URL {
    fun encode(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)

    fun decode(text: String): ByteArray? {
        var body = text
        var padding = 0
        while (body.endsWith("=")) { body = body.dropLast(1); padding += 1 }
        if (padding > 2 || !body.all(::isURLSafe)) return null
        if (padding > 0 && (body.length + padding) % 4 != 0) return null
        // One character over a multiple of four is no base64 at all.
        if (body.length % 4 == 1) return null
        return try { Base64.getUrlDecoder().decode(body) } catch (_: IllegalArgumentException) { null }
    }

    private fun isURLSafe(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'
}

/** Lowercase hex, as the daemon prints certificate fingerprints. */
val ByteArray.hexString: String get() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
