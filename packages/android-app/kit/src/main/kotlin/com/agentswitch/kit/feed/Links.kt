package com.agentswitch.kit.feed

import com.agentswitch.kit.support.unicodePattern
import com.agentswitch.kit.api.APIError
import com.agentswitch.kit.api.BrowserTarget
import com.agentswitch.kit.api.graphemeCount
import com.agentswitch.kit.api.isUnicodeWhitespace
import com.agentswitch.kit.browser.BrowserAddress
import com.agentswitch.kit.support.PathDisplay

// Links on the phone (docs/terminal-v0.md §1 iPhone 链接, browser-v0 §1 入口; 2026-10-03, user: 手机上现在点击和复制链接
// 还是费劲，修复一下交互；修复好之后想办法让手机可以方便的点击链接，点击之后直接在agent switch浏览器中打开): what a tap on
// one opens, what its long press offers, and what happens when the Mac's browser cannot take it. Where they are found is
// TerminalLinks (a terminal's screen) and Markdown (Dispatch's text); the screens only draw and forward.

/** Something tapped that opens in the Mac's shared browser. */
sealed class TappedLink {
    /** A web address (http or https), as written. */
    data class Web(val address: String) : TappedLink()

    /** A file or folder of the Mac's: an absolute path, or one under its home folder (`~/…`). */
    data class File(val path: String) : TappedLink()

    /** What `Copy Link` puts on the pasteboard, and what the menu's first line says. */
    val text: String
        get() = when (this) {
            is Web -> address
            is File -> path
        }

    /** What the Mac is asked to open (`POST /browser/tabs`). */
    val target: BrowserTarget
        get() = when (this) {
            is Web -> BrowserTarget.Url(address)
            is File -> BrowserTarget.Path(path)
        }

    /**
     * The address for Safari on this phone (Swift's `safari`; here the address as text, for the phone's browser): a web
     * address the phone can reach itself. A page of the Mac's own (`localhost`, a loopback address) is only there on the
     * Mac.
     */
    val safari: String?
        get() {
            if (this !is Web) return null
            val host = hostOf(address)?.lowercase() ?: return null
            val loopback = host == "localhost" || host.endsWith(".localhost") || host == "::1" || host == "[::1]" || host.startsWith("127.") || host == "0.0.0.0"
            return if (loopback) null else address
        }

    /**
     * The long press's menu, the tap's own action first: a path of the Mac's opens in the Files browser (docs/files-v0.md
     * §12.4.2; 2026-10-18, user: 终端上有文件的绝对或相对路径时手机点击应该弹出对应的文件管理页), a web address in the
     * Mac's browser.
     */
    val actions: List<LinkAction>
        get() {
            if (this is File) return listOf(LinkAction.ShowInFiles, LinkAction.OpenInBrowser, LinkAction.Copy)
            return if (safari == null) listOf(LinkAction.OpenInBrowser, LinkAction.Copy) else listOf(LinkAction.OpenInBrowser, LinkAction.Copy, LinkAction.OpenInSafari)
        }

    /** The menu's first line: the address without its scheme, a path with the home folder as `~`. */
    val display: String
        get() = when (this) {
            is Web -> BrowserAddress.display(address).text
            is File -> PathDisplay.short(path)
        }

    companion object {
        /**
         * A link by its address (Swift's `init?(address:)`): http(s) as it is, `file://` as its path; null for any other
         * scheme (an agent's output could otherwise name this app's own `agentswitch://pair`).
         */
        fun fromAddress(address: String): TappedLink? {
            val m = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*):(.*)$", RegexOption.DOT_MATCHES_ALL).find(address) ?: return null
            when (m.groupValues[1].lowercase()) {
                "http", "https" -> {
                    val host = hostOf(address)
                    return if (host.isNullOrEmpty()) null else Web(address)
                }
                "file" -> {
                    val rest = m.groupValues[2]
                    val raw = if (rest.startsWith("//")) rest.drop(2).let { a -> a.indexOf('/').let { if (it < 0) "" else a.substring(it) } } else rest
                    val path = percentDecoded(raw.takeWhile { it != '?' && it != '#' })
                    return if (path.startsWith("/") && path.graphemeCount() > 1) File(path) else null
                }
                else -> return null
            }
        }

        /** The host of an `scheme://authority/…` address as Swift's `URL.host` has it (no brackets round an IPv6 one). */
        private fun hostOf(address: String): String? {
            val rest = address.substringAfter(':', "")
            if (!rest.startsWith("//")) return null
            val authority = rest.drop(2).takeWhile { it != '/' && it != '?' && it != '#' }
            val afterUser = authority.substringAfterLast('@')
            val host = if (afterUser.startsWith("[")) afterUser.drop(1).substringBefore(']') else afterUser.substringBefore(':')
            return host
        }

        private fun percentDecoded(s: String): String {
            if (!s.contains('%')) return s
            val out = java.io.ByteArrayOutputStream()
            var i = 0
            val bytes = s.toByteArray(Charsets.UTF_8)
            while (i < bytes.size) {
                val b = bytes[i].toInt()
                if (b == '%'.code && i + 2 < bytes.size) {
                    val hi = Character.digit(bytes[i + 1].toInt(), 16)
                    val lo = Character.digit(bytes[i + 2].toInt(), 16)
                    if (hi >= 0 && lo >= 0) { out.write(hi * 16 + lo); i += 3; continue }
                }
                out.write(b)
                i += 1
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }
    }
}

/** What can be done with a link. */
enum class LinkAction {
    OpenInBrowser, Copy, OpenInSafari,

    /** A path of the Mac's, in the Files browser: its folder, or its folder with its preview on top. */
    ShowInFiles;

    /** The menu's word (docs/ui-v0.md §7.2.7: short English, title case). */
    fun label(link: TappedLink): String = when (this) {
        ShowInFiles -> "Show in Files"
        OpenInBrowser -> "Open in Browser"
        Copy -> if (link is TappedLink.File) "Copy Path" else "Copy Link"
        OpenInSafari -> "Open in Safari"
    }

    companion object {
        /** Said for a moment after copying. */
        fun copied(link: TappedLink): String = if (link is TappedLink.File) "Path Copied" else "Link Copied"
    }
}

/** A link the Mac's browser did not open. */
object LinkOpening {
    sealed class Failure {
        /** No Mac answers now. */
        data object NotConnected : Failure()

        /** The Mac has no browser: an AgentSwitch that predates it, or one with the browser switched off. */
        data object NoBrowser : Failure()

        /** The Mac said no, or could not: its reason in words (a protected path, a missing file, Chrome not starting). */
        data class Refused(val reason: String) : Failure()
    }

    /** What to do then (Swift's `(safari: URL?, said: String)` tuple). */
    data class Fallback(val safari: String?, val said: String)

    /**
     * What then: a web address the phone can reach opens in Safari, as before there was a shared browser, and the
     * reason is said; anything else is only said.
     */
    fun fallback(link: TappedLink, failure: Failure): Fallback {
        val safari = link.safari
        when (failure) {
            Failure.NotConnected ->
                return Fallback(safari, if (safari != null) "未连接到 Mac，已在 Safari 中打开。" else "未连接到 Mac，无法在 Mac 的浏览器中打开。")
            Failure.NoBrowser ->
                return Fallback(safari, if (safari != null) "此 Mac 上的 AgentSwitch 未提供浏览器，已在 Safari 中打开。" else "此 Mac 上的 AgentSwitch 未提供浏览器：版本过旧，或浏览器已关闭。")
            is Failure.Refused -> {
                val why = failure.reason.trim { it.isUnicodeWhitespace() }
                if (link is TappedLink.File) return Fallback(null, why.ifEmpty { "Mac 未能打开此文件。" })
                if (safari == null) return Fallback(null, why.ifEmpty { "Mac 未能打开此链接。" })
                return Fallback(safari, if (why.isEmpty()) "Mac 未能打开此链接，已在 Safari 中打开。" else "Mac 未能打开此链接（$why），已在 Safari 中打开。")
            }
        }
    }

    /**
     * How a failed `POST /browser/tabs` counts: a 404 for a web address is a Mac without the route (a file's 404 is a
     * file that is not there, said in the Mac's words); no answer at all is no connection.
     */
    fun failure(error: Throwable, link: TappedLink): Failure {
        if (error is APIError.Http && error.status == 404) {
            if (link is TappedLink.Web) return Failure.NoBrowser
            return Failure.Refused(error.detail.ifEmpty { "文件不存在。" })
        }
        if (error is APIError.Unreachable || error is APIError.Transport) return Failure.NotConnected
        return Failure.Refused(error.message ?: "")
    }
}

/** An address found in text: where it stands (UTF-16 `start` until `end`) and the address itself. */
data class AddressMatch(val start: Int, val end: Int, val address: String)

/** Web addresses and Mac paths as they stand in running text. */
object LinkText {
    private val ends: Set<Char> = setOf('<', '>', '"', '`', '{', '}', '|', '\\', '^')
    private val trailing: Set<Char> = setOf('.', ',', ';', ':', '!', '?', '\'', '*', '_', '~')

    /**
     * A character a web address runs over once it has begun: printable ASCII but for what ends one in prose. Chinese
     * text and its punctuation follow an address without a space, and are not part of it.
     */
    fun inAddress(c: Char): Boolean = c.code > 0x20 && c.code < 0x7F && c !in ends

    /** [inAddress] for a cell of a terminal's row (one Swift `Character`: a one-unit ASCII string, or none). */
    fun inAddress(cell: String): Boolean = cell.length == 1 && inAddress(cell[0])

    /**
     * An address with what prose put after it taken off its end: a sentence's punctuation, and a bracket that closes
     * one opened before the address began (`(see https://example.com/a_(b))` keeps its own pair).
     */
    fun trimmed(address: String): String {
        var s = address
        while (s.isNotEmpty()) {
            val last = s.last()
            if (last in trailing) { s = s.dropLast(1); continue }
            if (last == ')' && s.count { it == ')' } > s.count { it == '(' }) { s = s.dropLast(1); continue }
            if (last == ']' && s.count { it == ']' } > s.count { it == '[' }) { s = s.dropLast(1); continue }
            break
        }
        return s
    }

    /** Where an `http://` or `https://` address begins in `text` at or after `from`, any case. */
    fun schemeStart(text: String, from: Int = 0): Int? {
        var i = from
        while (i + 7 <= text.length) {
            if (text[i] == 'h' || text[i] == 'H') {
                val head = text.substring(i, minOf(i + 8, text.length)).lowercase()
                if (head.startsWith("http://") || head.startsWith("https://")) return i
            }
            i += 1
        }
        return null
    }

    /** [schemeStart] over the cells of a terminal's row (a string a cell; Swift's `[Character]`). */
    fun schemeStart(cells: List<String>, from: Int = 0): Int? {
        var i = from
        while (i + 7 <= cells.size) {
            if (cells[i] == "h" || cells[i] == "H") {
                val head = cells.subList(i, minOf(i + 8, cells.size)).joinToString("").lowercase()
                if (head.startsWith("http://") || head.startsWith("https://")) return i
            }
            i += 1
        }
        return null
    }

    /** A code unit that, after an ASCII one, makes it part of a longer Swift `Character` (a mark, a joiner, a selector). */
    private fun extendsCluster(c: Char): Boolean {
        val t = Character.getType(c)
        return t == Character.NON_SPACING_MARK.toInt() || t == Character.ENCLOSING_MARK.toInt() || t == Character.COMBINING_SPACING_MARK.toInt() ||
            c == '\u200D' || c == '\u200C'
    }

    /**
     * The web addresses written out in `text`, in order, each with where it stands. An address runs from its scheme
     * to the first character that is not an address's, less what [trimmed] takes off; a scheme alone is none.
     * (Swift's `range` is here `start` until `end`, UTF-16 indexes.)
     */
    fun webAddresses(text: String): List<AddressMatch> {
        val out = mutableListOf<AddressMatch>()
        var at = 0
        while (true) {
            val start = schemeStart(text, at) ?: break
            var end = start
            while (end < text.length && inAddress(text[end]) && !(end + 1 < text.length && extendsCluster(text[end + 1]))) end += 1
            val cut = trimmed(text.substring(start, end))
            at = maxOf(end, start + 1)
            val scheme = cut.indexOf("://")
            if (scheme < 0 || !cut.substring(scheme + 3).any { it.isLetterOrDigit() }) continue
            out.add(AddressMatch(start, start + cut.length, cut))
        }
        return out
    }

    private val position = unicodePattern("(:\\d+){1,2}$").toRegex()

    /**
     * A file's name with an extension: a dot after something, then up to eight letters and digits, a letter among them
     * (`a.md`, `x.tar`, `p.mp4`; not `v2.1`, not `.env`'s lone dot at the start).
     */
    private val named = Regex("^[^/]*[^/.]\\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$")

    /**
     * A word as a path of the Mac's, or null when it is not one: absolute with at least two parts (`/help` is a
     * command, `//` a comment), under the home folder (`~/x`), or relative to `workdir` — `./x`, `../x`, or folders
     * down to a file name with an extension (`docs/a.md`; `and/or`, `text/plain`, `1/2` are words). `:12:5` after it
     * (a place in the file) is not part of the path. Nothing with a scheme, and nothing a relative path can be
     * resolved against when `workdir` is not known.
     */
    fun macPath(word: String, workdir: String?): String? {
        var s = word
        position.find(s)?.let { s = s.removeRange(it.range) }
        if (s.isEmpty() || s.graphemeCount() > 1024 || s.contains("://") || s.any { it.isUnicodeWhitespace() || it == '\u0000' }) return null
        if (s.startsWith("~/")) return if (s.graphemeCount() > 2) s else null
        val parts = s.split("/")
        if (s.startsWith("/")) {
            val rest = parts.drop(1)
            val folders = if (rest.last() == "") rest.dropLast(1) else rest   // a folder written with its closing slash
            return if (folders.size >= 2 && folders.all { it.isNotEmpty() }) s else null
        }
        if (workdir == null || !workdir.startsWith("/")) return null
        val base = if (workdir.endsWith("/")) workdir.dropLast(1) else workdir
        if (s.startsWith("./")) return if (s.graphemeCount() > 2) "$base/${s.drop(2)}" else null
        if (s.startsWith("../")) return if (s.graphemeCount() > 3) "$base/$s" else null
        val name = parts.last()
        val first = s.codePointAt(0)
        if (parts.size < 2 || !parts.all { it.isNotEmpty() }) return null
        val ok = Character.isLetter(first) || isNumberCodePoint(first) || first == '_'.code || first == '.'.code || first == '@'.code
        if (!ok || !named.matches(name)) return null
        return "$base/$s"
    }

    private fun isNumberCodePoint(cp: Int): Boolean {
        val t = Character.getType(cp)
        return t == Character.DECIMAL_DIGIT_NUMBER.toInt() || t == Character.LETTER_NUMBER.toInt() || t == Character.OTHER_NUMBER.toInt()
    }
}
