package com.agentswitch.kit.api

import com.agentswitch.kit.pairing.HostAddress
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** How an address was learned, in the order endpoint selection prefers them. */
@Serializable
enum class EndpointKind(val rawValue: String) {
    @SerialName("bonjour") Bonjour("bonjour"),
    @SerialName("lan") Lan("lan"),
    @SerialName("tailnet") Tailnet("tailnet");

    val title: String
        get() = when (this) {
            Bonjour -> "LAN (Bonjour)"
            Lan -> "LAN"
            Tailnet -> "Tailscale"
        }

    /** The line without how it was found: "局域网" or "Tailscale" (the connection state, "已连接（局域网）"). */
    val lineTitle: String
        get() = when (this) {
            Bonjour, Lan -> "LAN"
            Tailnet -> "Tailscale"
        }
}

/** Foundation's `URLQueryItem`: one `name=value` of a query; a `null` value is written as the bare name. */
data class URLQueryItem(val name: String, val value: String?)

/** One way to reach the Mac's remote listener. */
@Serializable
data class APIEndpoint(val host: String, val port: Int, val kind: EndpointKind) {
    val authority: String get() = "${HostAddress.urlHost(host)}:$port"
    val baseURL: String get() = "https://$authority"

    /** `path` is already split into segments; each is percent-encoded so an id can never change the route. */
    fun url(segments: List<String>, query: List<URLQueryItem> = emptyList()): String {
        val sb = StringBuilder("https://").append(HostAddress.urlHost(host)).append(':').append(port)
        sb.append('/').append(segments.joinToString("/") { encodeSegment(it) })
        if (query.isNotEmpty()) {
            // As `URLComponents.queryItems` writes them: a name and a value keep the query's characters but `&` and
            // `=` (the iPhone's test of a path with `=` in it: `a&b=c.md` goes out as `a%26b%3Dc.md`).
            val text = query.joinToString("&") { item ->
                val name = percentEncode(item.name) { isQueryAllowed(it) && it != '&'.code && it != '='.code }
                if (item.value == null) name else name + "=" + percentEncode(item.value) { isQueryAllowed(it) && it != '&'.code && it != '='.code }
            }
            // A `+` is left as it is in a query, and read back as a space by the Mac (a path like `c++/notes`).
            sb.append('?').append(text.replace("+", "%2B"))
        }
        return sb.toString()
    }

    companion object {
        fun encodeSegment(s: String): String =
            percentEncode(s) { isPathAllowed(it) && it != '/'.code && it != ';'.code && it != '?'.code && it != '#'.code && it != '%'.code }

        private fun isUnreserved(b: Int): Boolean =
            b in 'A'.code..'Z'.code || b in 'a'.code..'z'.code || b in '0'.code..'9'.code || b == '-'.code || b == '.'.code ||
                b == '_'.code || b == '~'.code

        private fun isSubDelim(b: Int): Boolean = b.toChar() in "!\$&'()*+,;="

        /** `CharacterSet.urlPathAllowed`. */
        private fun isPathAllowed(b: Int): Boolean = isUnreserved(b) || isSubDelim(b) || b == ':'.code || b == '@'.code || b == '/'.code

        /** `CharacterSet.urlQueryAllowed`. */
        private fun isQueryAllowed(b: Int): Boolean = isPathAllowed(b) || b == '?'.code

        /** `addingPercentEncoding(withAllowedCharacters:)` on UTF-8 bytes, uppercase hex; `s` itself if it is not valid UTF-16. */
        internal fun percentEncode(s: String, allowed: (Int) -> Boolean): String {
            if (hasLoneSurrogate(s)) return s
            val out = StringBuilder()
            for (byte in s.toByteArray(Charsets.UTF_8)) {
                val b = byte.toInt() and 0xff
                if (b < 0x80 && allowed(b)) out.append(b.toChar()) else out.append('%').append("%02X".format(b))
            }
            return out.toString()
        }

        private fun hasLoneSurrogate(s: String): Boolean {
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c.isHighSurrogate()) {
                    if (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) return true
                    i += 2
                    continue
                }
                if (c.isLowSurrogate()) return true
                i += 1
            }
            return false
        }
    }
}

/**
 * Supplies the endpoint to use and hears about failures, so a broken path is re-selected. ConnectionManager in the
 * app; a fixed endpoint in tests.
 */
interface EndpointProviding {
    suspend fun endpoint(): APIEndpoint
    suspend fun reportFailure(endpoint: APIEndpoint)
}

/** Always the same endpoint (pairing, tests). */
class FixedEndpoint(val value: APIEndpoint) : EndpointProviding {
    override suspend fun endpoint(): APIEndpoint = value
    override suspend fun reportFailure(endpoint: APIEndpoint) {}
}
