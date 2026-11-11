package com.agentswitch.kit.api

import com.agentswitch.kit.secrets.SecretPayload
import com.agentswitch.kit.secrets.SecretUse
import com.agentswitch.kit.support.unicodePattern
import java.io.ByteArrayOutputStream
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A proxy as the Mac's service tells it (docs/profiles-v0.md §4, docs/browser-v0.md §7.2 第 5 条): where it is, who
 * asks, and whether it has a password — the password itself is never told.
 */
@Serializable(with = ProxySettingSerializer::class)
data class ProxySetting(
    val server: String,
    val username: String? = null,
    val sealed: Boolean = false,
)

object ProxySettingSerializer : KSerializer<ProxySetting> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): ProxySetting {
        val o = decoder.jsonObject("ProxySetting")
        return ProxySetting(
            server = o.requireString("server"),
            username = o.lenientString("username")?.takeIf { it.isNotEmpty() },
            sealed = o.lenientBool("sealed") ?: false,
        )
    }

    override fun serialize(encoder: Encoder, value: ProxySetting) {
        val m = linkedMapOf<String, JsonElement>("server" to JsonPrimitive(value.server), "sealed" to JsonPrimitive(value.sealed))
        value.username?.let { m["username"] = JsonPrimitive(it) }
        encoder.encodeObject(m)
    }
}

/** Where a proxy lets traffic out, as last found. */
@Serializable
data class ProxyExit(
    val ip: String,
    val place: String? = null,
) {
    /** `Tokyo 203.0.113.9`. */
    val text: String get() = listOfNotNull(place, ip).filter { it.isNotEmpty() }.joinToString(" ")
}

/**
 * A proxy to set: `password` is a ciphertext for the proxy's own `host:port`, made on this phone (the service takes
 * no other); `keepPassword`: none is sent because the one stored stays.
 */
@Serializable
data class ProxyRequest(
    val server: String,
    val username: String? = null,
    val password: String? = null,
    val keepPassword: Boolean? = null,
)

/**
 * The proxy form as typed (the Mac's `BrowserProxyDraft`): the same rules, the same taking apart of a proxy written
 * whole in one field.
 */
data class ProxyDraft(
    val server: String = "",
    val username: String = "",
    /** As typed; sealed on this phone before anything is sent. */
    val password: String = "",
) {
    /** The fields as the proxy in force has them (the password is never sent back: its field starts empty). */
    constructor(proxy: ProxySetting?) : this(proxy?.server ?: "", proxy?.username ?: "")

    internal val user: String get() = username.trim { it.isUnicodeWhitespace() }

    /** The proxy's own `host:port`: what its password is sealed for. */
    val site: String? get() = ProxyText.site(server)

    /** What stands in the way of `Apply`, once something has been typed. */
    val problem: String?
        get() {
            if (server.trim { it.isUnicodeWhitespace() }.isEmpty()) return null
            if (site == null) return "代理地址须写作 scheme://host:port（http、https、socks4、socks5）。"
            if (password.isNotEmpty() && user.isEmpty()) return "带密码的代理需要用户名。"
            return null
        }

    val canApply: Boolean get() = site != null && problem == null

    /** No password was typed and the proxy in force has one under the same user: it stays. */
    fun keepsPassword(current: ProxySetting?): Boolean = password.isEmpty() && user.isNotEmpty() && current?.sealed == true

    /**
     * The same with a proxy written whole in the server field taken apart: `http://user:pass@host:port` — the name
     * and the password go to their own fields and the server keeps `http://host:port`. Also taken: the same without
     * a scheme (`http` is meant), `host:port` alone, and the `host:port:user:pass` that proxy sellers hand out. A
     * name or a password written with `%` escapes is read as what it stands for. Anything else is left as it is.
     */
    fun split(): ProxyDraft {
        var text = server.trim { it.isUnicodeWhitespace() }
        while (text.endsWith("/")) text = text.dropLast(1)
        sold.matcher(text).let { m ->
            if (m.matches()) return ProxyDraft(server = "http://${m.group(1)}:${m.group(2)}", username = m.group(3)!!, password = m.group(4)!!)
        }
        var scheme = "http"
        var rest = text
        val named = schemePrefix.matcher(text)
        if (named.lookingAt()) {
            scheme = named.group(1)!!.lowercase()
            rest = text.substring(named.end())
        } else if (text.contains("://")) {
            return this
        }
        // What stands before the last `@` is who asks; the first `:` in it parts the name from the password.
        var name: String? = null
        var word: String? = null
        val at = rest.lastIndexOf('@')
        if (at >= 0) {
            val who = rest.substring(0, at)
            val colon = who.indexOf(':')
            name = if (colon >= 0) who.substring(0, colon) else who
            word = if (colon >= 0) who.substring(colon + 1) else null
            rest = rest.substring(at + 1)
        }
        if (!place.matcher(rest).matches()) return this
        val plain = { s: String? -> if (s.isNullOrEmpty()) null else (percentDecoded(s) ?: s) }
        return ProxyDraft(server = "$scheme://$rest", username = plain(name) ?: username, password = plain(word) ?: password)
    }

    /** The request, with `ciphertext` for a typed password (null: none was typed). */
    fun request(ciphertext: String?, current: ProxySetting?): ProxyRequest =
        ProxyRequest(
            server = server.trim { it.isUnicodeWhitespace() },
            username = if (user.isEmpty()) null else user,
            password = ciphertext,
            keepPassword = if (ciphertext == null && keepsPassword(current)) true else null,
        )

    /**
     * A typed password as the gate is to have it: for the proxy's own `host:port` and nowhere else, to be put into
     * requests and typed (the uses the Mac seals it with). Null: no password was typed. Throws what the gate's rules
     * say no to (a host it does not take). Sealing it (a `TokenMinter` with the app's `BoxSealer`) is the caller's.
     */
    fun sealing(label: String): SecretPayload? {
        val site = site
        if (password.isEmpty() || site == null) return null
        return SecretPayload.make(value = password, hosts = listOf(site), uses = setOf(SecretUse.Http, SecretUse.Fill), label = label)
    }

    private companion object {
        val place = unicodePattern("""(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5})""")
        val sold = unicodePattern("""(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):(\d{1,5}):([^:\s]+):(\S+)""")
        val schemePrefix = unicodePattern("""(?i)(https?|socks4|socks5)://""")
    }
}

/** Foundation's `removingPercentEncoding`: null when a `%` is not followed by two hex digits or the bytes are not UTF-8. */
internal fun percentDecoded(s: String): String? {
    val out = ByteArrayOutputStream()
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '%') {
            if (i + 2 >= s.length) return null
            val hi = Character.digit(s[i + 1], 16)
            val lo = Character.digit(s[i + 2], 16)
            if (hi < 0 || lo < 0 || s[i + 1].code > 127 || s[i + 2].code > 127) return null
            out.write(hi * 16 + lo)
            i += 3
        } else {
            val end = if (c.isHighSurrogate() && i + 1 < s.length) i + 2 else i + 1
            out.write(s.substring(i, end).toByteArray(Charsets.UTF_8))
            i = end
        }
    }
    val decoder = Charsets.UTF_8.newDecoder()
    return try {
        decoder.decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
        null
    }
}

/** Whose proxy a form sets. */
sealed class ProxyOwner {
    /** The browser everything shares. */
    data object Browser : ProxyOwner()

    /** One of an agent's profiles. */
    data class Profile(val agent: String, val id: String) : ProxyOwner()

    /** The name its password is sealed under (the Mac's). */
    val sealLabel: String
        get() = when (this) {
            Browser -> "browser/proxy"
            is Profile -> "profile/proxy"
        }
}

object ProxyText {
    private val sitePattern = Regex("""(http|https|socks4|socks5)://(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.\-]+):([0-9]{1,5})""")

    /** `host:port` of a `scheme://host:port`; null for anything else. */
    fun site(server: String): String? {
        val text = server.trim { it.isUnicodeWhitespace() }
        val match = sitePattern.matchEntire(text) ?: return null
        val port = match.groupValues[3].toIntOrNull() ?: return null
        if (port <= 0 || port >= 65_536) return null
        return "${match.groupValues[2]}:$port"
    }

    /** A proxy in a few words: where it lets traffic out once that is known, else the proxy's own place. */
    fun way(proxy: ProxySetting?, exit: ProxyExit?, none: String): String {
        if (proxy == null) return none
        val text = exit?.text
        if (text != null && text.isNotEmpty()) return text
        return site(proxy.server) ?: proxy.server
    }

    // "这台 iPhone" → "这台手机" (this device).
    const val passwordHint = "密码在这台手机上封成密文再发给 Mac，只能用于这个代理自己的地址；使用时由 Mac 的凭据网关解密。"
    const val browserHint = "更换代理立即生效，无需重新启动浏览器。"
    const val profileHint = "这个配置名下的终端和它自己的浏览器都从这个代理出去；已经开着的终端要重新开才换。"

    /** The exit's time zone differs from the one the running browser was started in. */
    const val restartHint = "时区随代理出口变化，将在浏览器下次启动时生效。"
}

/**
 * The shared browser's way out, as a phone is told it (`GET /browser/identity`): the fingerprint in a line (its text
 * stays on the Mac), the proxy, where the proxy lets traffic out.
 */
@Serializable(with = BrowserProxyStateSerializer::class)
data class BrowserProxyState(
    /** `macOS · Firefox 156`. */
    val fingerprint: String? = null,
    val proxy: ProxySetting? = null,
    val exit: Exit? = null,
    /** The running browser was started with another time zone than it would be given now. */
    val restartNeeded: Boolean = false,
) {
    sealed class Exit {
        data class Found(val exit: ProxyExit) : Exit()
        data class Problem(val text: String) : Exit()
    }

    /** `Direct`, or where the proxy lets traffic out (the proxy's own place till that is known). */
    val way: String
        get() {
            val e = exit
            if (e is Exit.Found) return ProxyText.way(proxy, exit = e.exit, none = "Direct")
            return ProxyText.way(proxy, exit = null, none = "Direct")
        }
}

internal object BrowserProxyStateSerializer : ObjectReader<BrowserProxyState>("BrowserProxyState") {
    override fun read(o: JsonObject): BrowserProxyState {
        val summary = ((o["fingerprint"] as? JsonObject)?.get("summary")) as? JsonObject
        val words = listOfNotNull(summary?.lenientString("system"), summary?.lenientString("browser"))
        val exitObject = o["exit"] as? JsonObject
        val ip = exitObject?.lenientString("ip")
        val problem = exitObject?.lenientString("problem")
        val exit = when {
            ip != null -> BrowserProxyState.Exit.Found(ProxyExit(ip = ip, place = exitObject.lenientString("place")))
            problem != null -> BrowserProxyState.Exit.Problem(problem)
            else -> null
        }
        return BrowserProxyState(
            fingerprint = if (words.isEmpty()) null else words.joinToString(" · "),
            proxy = o.lenient("proxy", ProxySetting.serializer()),
            exit = exit,
            restartNeeded = o.lenientBool("restartNeeded") ?: false,
        )
    }
}
