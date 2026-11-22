package com.agentswitch.kit.pairing

import com.agentswitch.kit.api.CertificatePin
import com.agentswitch.kit.secrets.TokenMinter
import com.agentswitch.kit.secrets.isUnicodeWhiteSpace
import com.agentswitch.kit.secrets.trimmingWhitespacesAndNewlines
import com.agentswitch.kit.support.Base64URL
import com.agentswitch.kit.support.KitJson
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.text.BreakIterator
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The gate's current keypair as the Mac hands it over (`GET /gate/pubkey` has the same shape). */
@Serializable
data class GateKey(
    /** base64url, 32 bytes */
    val publicKey: String,
    val keypair: String,
) {
    val isValid: Boolean get() = TokenMinter.isValidPublicKey(publicKey)
}

/**
 * The JSON inside `agentswitch://pair?p=…` (app-v0 §2), version 1. `v`, `name`, `port`, `fp` and `code` must be
 * present; `lan`, `tailnet` and `bonjour` default to empty.
 */
@Serializable
data class PairingPayload(
    val v: Int,
    val name: String,
    val port: Int,
    val fp: String,
    val code: String,
    val lan: List<String> = emptyList(),
    val tailnet: List<String> = emptyList(),
    val bonjour: String = "",
    /** Optional here so a Mac without a gate keypair can still pair; the phone then asks `GET /gate/pubkey`. */
    val gate: GateKey? = null,
) {
    /** Version 1, as Swift's `init(v: Int = 1, …)`. */
    constructor(name: String, port: Int, fp: String, code: String, lan: List<String>, tailnet: List<String>, bonjour: String, gate: GateKey?) :
        this(1, name, port, fp, code, lan, tailnet, bonjour, gate)

    companion object
}

sealed class PairingLinkError(message: String) : Exception(message) {
    data object NotALink : PairingLinkError("不是 AgentSwitch 配对链接（应以 agentswitch://pair 开头）")
    data object MissingPayload : PairingLinkError("配对链接缺少内容")
    data object BadEncoding : PairingLinkError("配对链接内容不是有效的 base64url")
    data object BadJSON : PairingLinkError("配对链接内容无法解析")
    data class UnsupportedVersion(val v: Int) : PairingLinkError("不支持的配对版本 v=$v，请更新 App")
    data class InvalidField(val field: String) : PairingLinkError("配对信息字段无效：$field")
}

/**
 * `agentswitch://pair?p=<base64url(JSON)>`: parse and validate. Nothing here trusts the link beyond its shape; the
 * fingerprint it carries is what every later TLS connection is pinned to.
 */
object PairingLink {
    const val scheme = "agentswitch"
    const val host = "pair"
    const val supportedVersion = 1

    /** Accepts the bare link or text that contains it (a pasted message). */
    fun parse(text: String): PairingPayload {
        val link = extractLink(text) ?: throw PairingLinkError.NotALink
        val comps = LinkComponents.parse(link) ?: throw PairingLinkError.NotALink
        if (comps.scheme.lowercase() != scheme || comps.host?.lowercase() != host) throw PairingLinkError.NotALink
        val p = comps.queryItems?.firstOrNull { it.first == "p" }?.second
        if (p.isNullOrEmpty()) throw PairingLinkError.MissingPayload
        val data = Base64URL.decode(p) ?: throw PairingLinkError.BadEncoding
        val payload = try {
            KitJson.decodeFromString(PairingPayload.serializer(), strictUTF8(data) ?: throw PairingLinkError.BadJSON)
        } catch (e: PairingLinkError) {
            throw e
        } catch (e: Exception) {
            throw PairingLinkError.BadJSON
        }
        return validate(payload)
    }

    /** The link for a payload (tests and previews; the Mac builds the real one). Keys sorted, slashes not escaped. */
    fun make(payload: PairingPayload): String {
        val json = sortedKeys(KitJson.encodeToJsonElement(PairingPayload.serializer(), payload)).toString()
        return "$scheme://$host?p=${Base64URL.encode(json.toByteArray(Charsets.UTF_8))}"
    }

    /** Normalizes the fingerprint and code; rejects anything that could not be a v1 payload. */
    fun validate(p: PairingPayload): PairingPayload {
        if (p.v != supportedVersion) throw PairingLinkError.UnsupportedVersion(p.v)
        val name = p.name.trimmingWhitespacesAndNewlines()
        if (name.isEmpty() || characterCount(name) > 128) throw PairingLinkError.InvalidField("name")
        if (p.port !in 1..65535) throw PairingLinkError.InvalidField("port")
        val fp = CertificatePin.normalize(p.fp) ?: throw PairingLinkError.InvalidField("fp")
        val code = normalizeCode(p.code) ?: throw PairingLinkError.InvalidField("code")
        if (!p.lan.all(HostAddress::isValid)) throw PairingLinkError.InvalidField("lan")
        if (!p.tailnet.all(HostAddress::isValid)) throw PairingLinkError.InvalidField("tailnet")
        if (p.lan.isEmpty() && p.tailnet.isEmpty() && p.bonjour.isEmpty()) throw PairingLinkError.InvalidField("lan/tailnet/bonjour")
        if (p.gate != null && !p.gate.isValid) throw PairingLinkError.InvalidField("gate.publicKey")
        return PairingPayload(p.v, name, p.port, fp, code, p.lan, p.tailnet, p.bonjour, p.gate)
    }

    /**
     * `XXXX-XXXX`, decoded like the daemon's normalizeCode (remote/pairing.ts): case-insensitive, dashes and spaces
     * ignored, O → 0, I and L → 1; the result is canonical.
     */
    fun normalizeCode(code: String): String? {
        val mapped = mapOf('O' to '0', 'I' to '1', 'L' to '1')
        val raw = code.uppercase().filter { it != '-' && !isUnicodeWhiteSpace(it) }.map { mapped[it] ?: it }.joinToString("")
        val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toSet()
        if (raw.length != 8 || !raw.all { it in alphabet }) return null
        return "${raw.take(4)}-${raw.takeLast(4)}"
    }

    private fun extractLink(text: String): String? {
        val trimmed = text.trimmingWhitespacesAndNewlines()
        val start = trimmed.indexOf("$scheme://", ignoreCase = true)
        if (start < 0) return null
        val tail = trimmed.substring(start)
        val end = tail.indexOfFirst { isUnicodeWhiteSpace(it) || it == '"' || it == '\'' || it == '<' || it == '>' }
        return if (end >= 0) tail.substring(0, end) else tail
    }

    /** Characters as Swift counts them (grapheme clusters). */
    private fun characterCount(s: String): Int {
        val it = BreakIterator.getCharacterInstance()
        it.setText(s)
        var n = 0
        while (it.next() != BreakIterator.DONE) n += 1
        return n
    }

    private fun strictUTF8(data: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(data)).toString()
    } catch (_: CharacterCodingException) {
        null
    }

    private fun sortedKeys(e: JsonElement): JsonElement = when (e) {
        is JsonObject -> JsonObject(e.entries.sortedBy { it.key }.associate { it.key to sortedKeys(it.value) })
        is JsonArray -> JsonArray(e.map(::sortedKeys))
        else -> e
    }
}

/**
 * The parts of a link `URLComponents(string:)` gives: the whole string must be an RFC 3986 URI reference (ASCII,
 * valid `%XX` escapes) or there are no components at all; the host and the query items come back percent-decoded.
 */
private class LinkComponents(val scheme: String, val host: String?, val queryItems: List<Pair<String, String?>>?) {
    companion object {
        private const val allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!\$&'()*+,;=%"

        fun parse(link: String): LinkComponents? {
            if (!link.all { it in allowed }) return null
            var i = 0
            while (i < link.length) {
                if (link[i] == '%') {
                    if (i + 2 >= link.length || !isHex(link[i + 1]) || !isHex(link[i + 2])) return null
                    i += 3
                } else i += 1
            }
            val schemeEnd = link.indexOf("://")
            if (schemeEnd <= 0) return null
            val scheme = link.substring(0, schemeEnd)
            if (!scheme[0].isLetter() || !scheme.all { it.isLetterOrDigit() || it in "+-." }) return null
            val rest = link.substring(schemeEnd + 3)
            val fragment = rest.indexOf('#')
            val beforeFragment = if (fragment >= 0) rest.substring(0, fragment) else rest
            if (fragment >= 0 && rest.substring(fragment + 1).contains('#')) return null
            val authorityEnd = beforeFragment.indexOfFirst { it == '/' || it == '?' }
            val authority = if (authorityEnd >= 0) beforeFragment.substring(0, authorityEnd) else beforeFragment
            val afterAt = authority.substring(authority.lastIndexOf('@') + 1)
            val hostText = if (afterAt.startsWith("[")) {
                val close = afterAt.indexOf(']')
                if (close < 0) return null
                val portText = afterAt.substring(close + 1)
                if (portText.isNotEmpty() && !(portText.startsWith(":") && portText.drop(1).all { it in '0'..'9' })) return null
                afterAt.substring(0, close + 1)
            } else {
                val colon = afterAt.indexOf(':')
                if (colon >= 0) {
                    if (!afterAt.substring(colon + 1).all { it in '0'..'9' }) return null
                    afterAt.substring(0, colon)
                } else afterAt
            }
            if (hostText.contains('[') && !hostText.startsWith("[")) return null
            val host = percentDecode(hostText) ?: return null
            val question = beforeFragment.indexOf('?')
            val items = if (question < 0) null else {
                val query = beforeFragment.substring(question + 1)
                if (query.isEmpty()) emptyList() else query.split("&").map { piece ->
                    val eq = piece.indexOf('=')
                    if (eq < 0) (percentDecode(piece) ?: piece) to null
                    else (percentDecode(piece.substring(0, eq)) ?: piece.substring(0, eq)) to percentDecode(piece.substring(eq + 1))
                }
            }
            return LinkComponents(scheme, host, items)
        }

        private fun isHex(c: Char): Boolean = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

        /** `removingPercentEncoding`: null when the bytes are not UTF-8. `+` stays a `+`. */
        private fun percentDecode(s: String): String? {
            if (!s.contains('%')) return s
            val bytes = java.io.ByteArrayOutputStream()
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '%') {
                    bytes.write(s.substring(i + 1, i + 3).toInt(16))
                    i += 3
                } else {
                    bytes.write(c.code)
                    i += 1
                }
            }
            return try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }
    }
}

/**
 * Addresses from the pairing payload end up in URLs, so they must be plain IP literals or DNS names. The IP checks
 * accept exactly what `inet_pton` accepts and never resolve a name.
 */
object HostAddress {
    fun isValid(host: String): Boolean = isIPv4(host) || isIPv6(host) || isDNSName(host)

    /** `inet_pton(AF_INET, …)`: four decimal parts 0-255, no leading zeros, nothing else. */
    fun isIPv4(host: String): Boolean {
        var octets = 0
        var sawDigit = false
        var value = 0
        var digits = 0
        for (c in host) {
            if (c in '0'..'9') {
                if (sawDigit && value == 0) return false  // a leading zero
                value = value * 10 + (c - '0')
                digits += 1
                if (value > 255) return false
                if (!sawDigit) {
                    octets += 1
                    if (octets > 4) return false
                    sawDigit = true
                }
            } else if (c == '.' && sawDigit) {
                if (octets == 4) return false
                sawDigit = false
                value = 0
                digits = 0
            } else {
                return false
            }
        }
        return octets == 4 && sawDigit
    }

    /**
     * `inet_pton(AF_INET6, …)` (the ISC algorithm): up to eight groups of one to four hex digits, at most one `::`,
     * an IPv4 dotted quad in place of the last two groups; no zone id, no brackets.
     */
    fun isIPv6(host: String): Boolean {
        val endp = 16
        var tp = 0
        var colonp = -1
        var i = 0
        if (host.isEmpty()) return false
        if (host[0] == ':') {
            if (host.length < 2 || host[1] != ':') return false
            i = 1
        }
        var curtok = i
        var sawXDigit = false
        var digits = 0
        while (i < host.length) {
            val ch = host[i++]
            if (ch in '0'..'9' || ch in 'a'..'f' || ch in 'A'..'F') {
                digits += 1
                if (digits > 4) return false
                sawXDigit = true
                continue
            }
            if (ch == ':') {
                curtok = i
                if (!sawXDigit) {
                    if (colonp != -1) return false
                    colonp = tp
                    continue
                } else if (i == host.length) {
                    return false
                }
                if (tp + 2 > endp) return false
                tp += 2
                sawXDigit = false
                digits = 0
                continue
            }
            if (ch == '.' && tp + 4 <= endp && isIPv4(host.substring(curtok))) {
                tp += 4
                sawXDigit = false
                break
            }
            return false
        }
        if (sawXDigit) {
            if (tp + 2 > endp) return false
            tp += 2
        }
        if (colonp != -1) {
            if (tp == endp) return false
            tp = endp
        }
        return tp == endp
    }

    fun isDNSName(host: String): Boolean {
        val name = if (host.endsWith(".")) host.dropLast(1) else host
        if (name.isEmpty() || name.toByteArray(Charsets.UTF_8).size > 253) return false
        return name.split(".").all { label ->
            val size = label.toByteArray(Charsets.UTF_8).size
            if (size !in 1..63 || label.first() == '-' || label.last() == '-') return@all false
            label.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' }
        }
    }

    /** `host` as it goes into a URL authority: IPv6 literals in brackets. */
    fun urlHost(host: String): String = if (isIPv6(host)) "[$host]" else host
}
