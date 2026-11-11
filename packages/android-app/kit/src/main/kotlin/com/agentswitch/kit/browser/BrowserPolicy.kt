package com.agentswitch.kit.browser

import com.agentswitch.kit.api.BrowserStreamOptions
import com.agentswitch.kit.api.BrowserTarget
import com.agentswitch.kit.api.EndpointKind
import com.agentswitch.kit.api.swiftTrimmed
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * How much picture a tab's stream asks for (browser-v0 §1 iPhone, §2: 15–30 frames on the local network, fewer and a
 * lower quality on a slow link). On the local network the screen's device pixels (3). Over Tailscale by the speed
 * measured (2026-10-03, user: tailscale 直接根据网速来行了，中转有的时候比直连快): whether the path is direct or relayed
 * (once guessed from how fast the Mac answered) says little about how much it carries. Each frame is at most the
 * screen's pixels, so a desktop page shown across the phone's width comes no larger than the screen shows it. A page
 * this phone zoomed (browser-v0 §1 页面缩放, 2026-10-03) is fewer CSS pixels across the same screen, or more: every
 * way asks for its own pixels a point times the factor (BrowserPageZoom.streamScale), and the frame stays the size
 * the way had at 100% — zoomed out too, where a way's own scale let it grow to the whole screen's pixels (review,
 * 2026-10-03).
 */
object BrowserStreamPolicy {
    /**
     * From this speed (megabits a second) as the local network: the phone's own size at 3× is about 209 KB a frame
     * (§5's measure), 15 a second about 25 Mbps while the page moves.
     */
    const val fastMbps = 25.0

    /** From this speed at most 2× and 10 frames: about 100 KB a frame, about 8 Mbps. */
    const val fairMbps = 8.0
    const val fairScale = 2.0

    /** Slower than that, or not measured: one frame pixel a point, the CSS size. */
    const val slowScale = 1.0

    val local = BrowserStreamOptions(quality = 70, fps = 15)
    val fair = BrowserStreamOptions(quality = 60, fps = 10)
    val slow = BrowserStreamOptions(quality = 45, fps = 5)

    /** The link is measured for the stream: Tailscale (the local network needs no measure; without an address there is nothing to measure). */
    fun measures(kind: EndpointKind?): Boolean = kind == EndpointKind.Tailnet

    /**
     * `mbps`: the speed measured over this address (null: not known, the slow way). `screenPixels`: the phone's screen
     * in pixels, the most any frame needs. `screenScale`: its points to pixels. `zoom`: the factor of the page zoom
     * this phone set the page at (1: none, or the phone only watches). Each way asks its own frame pixels a point —
     * the screen's on the local network and a fast link, at most 2 on a fair one, 1 (the CSS size) on a slow one —
     * times the factor (BrowserPageZoom.streamScale), and is bounded by the screen's pixels, or by its own where the
     * page is zoomed out past them (`most`).
     */
    fun options(kind: EndpointKind?, mbps: Double?, screenPixels: Size? = null, screenScale: Double? = null, zoom: Double = 1.0): BrowserStreamOptions {
        // The screen in points: with them a way's own pixels can be counted.
        val points = screenPixels?.let { pixels ->
            screenScale?.let { if (it > 0) Size(pixels.width / it, pixels.height / it) else null }
        }
        when (kind) {
            EndpointKind.Bonjour, EndpointKind.Lan ->
                return sharp(local, scale = screenScale, own = true, pixels = screenPixels, points = points, zoom = zoom)
            EndpointKind.Tailnet, null -> {
                val speed = mbps ?: 0.0
                if (speed >= fastMbps) return sharp(local, scale = screenScale, own = true, pixels = screenPixels, points = points, zoom = zoom)
                if (speed >= fairMbps) {
                    // A fair link shows a 2× screen's own pixels, and fewer than a 3× screen has.
                    return sharp(fair, scale = screenScale?.let { swiftMin(it, fairScale) }, own = screenScale?.let { it <= fairScale } ?: false,
                        pixels = screenPixels, points = points, zoom = zoom)
                }
                val bound = screenPixels?.let { most(it, points = points, scale = slowScale, zoom = zoom) }
                val asked = BrowserPageZoom.streamScale(slowScale, factor = zoom)
                return BrowserStreamOptions(quality = slow.quality, fps = slow.fps, maxWidth = bound?.let { it.width.roundedHalfAway().toInt() },
                    maxHeight = bound?.let { it.height.roundedHalfAway().toInt() }, scale = if (asked > 1) asked else null)
            }
        }
    }

    /**
     * `base` at `scale` frame pixels a point (times the page zoom), never larger than the screen: without the scale
     * and the screen's pixels known, as `base` — and so is a screen of one pixel a point showing the page as it is,
     * which has nothing to ask (as before the zoom). `own`: `scale` is the screen's own, so the bound, the screen's
     * pixels, is what the frame should be to the pixel (BrowserPageZoom.streamScale's `met`).
     */
    private fun sharp(base: BrowserStreamOptions, scale: Double?, own: Boolean, pixels: Size?, points: Size?, zoom: Double): BrowserStreamOptions {
        if (scale == null || pixels == null) return base
        val asked = BrowserPageZoom.streamScale(scale, factor = zoom, met = own)
        if (!(asked > 1 || (zoom > 0 && zoom < 1))) return base
        val bound = most(pixels, points = points, scale = scale, zoom = zoom)
        return BrowserStreamOptions(quality = base.quality, fps = base.fps, maxWidth = bound.width.roundedHalfAway().toInt(),
            maxHeight = bound.height.roundedHalfAway().toInt(), scale = if (asked > 1) asked else null)
    }

    /**
     * The most pixels a frame needs on a way that shows `scale` frame pixels a point: the screen's own (`pixels`) —
     * except for a page zoomed out past a frame pixel a CSS pixel (BrowserPageZoom.pastPixels; on a 3× phone the
     * local network under 34%, a fair link under 50%, a slow one under 100%), which the Mac still draws at its CSS
     * size, more pixels than the way shows. There the way's own pixels bound it, the screen's `points` times
     * `scale`, and the screencast makes the frame that small (review, 2026-10-03: bounded by the whole screen, the
     * page of a 402 × 690 pt area at 25% came 1206 × 2070 on a fair link for the tier's 804 × 1380, and on a slow one
     * for its 402 × 690). The Mac does the same with its browser area (its BrowserScreenPolicy.stream). Without the
     * points known, the screen's pixels as before.
     */
    private fun most(pixels: Size, points: Size?, scale: Double, zoom: Double): Size {
        if (points == null || !BrowserPageZoom.pastPixels(scale, factor = zoom)) return pixels
        return Size(points.width * scale, points.height * scale)
    }
}

/**
 * The phone's measure of its link to the Mac (`GET /browser/speed`, browser-v0 §5): bytes over the time from the first
 * chunk to the last, so the time to the first byte (the round trip, the Mac starting to answer) is not counted. Ends
 * when the bytes are in or at `limit`, whatever has come by then counting.
 */
object BrowserSpeed {
    /** The bytes asked for: at 25 Mbps about a third of a second, at 8 about one. */
    const val bytes = 1024 * 1024

    /** The longest a measure takes; slower than about 4 Mbps it ends here, on what came. */
    val limit: Duration = 2.seconds

    /** A measure is used again for this long on the same address. */
    val fresh: Duration = 60.seconds

    /** Fewer bytes after the first chunk than this say nothing (a chunk or two, or none). */
    const val least = 32 * 1024

    /** Chunks as they came: (bytes, seconds since the measure began). Swift's value type: [copy] is its copy. */
    class Meter {
        var first: Double? = null
            private set
        var last: Double? = null
            private set

        /** Bytes after the first chunk. */
        var after: Int = 0
            private set

        fun add(count: Int, at: Double) {
            if (count <= 0) return
            if (first == null) first = at else after += count
            last = at
        }

        /** The measure ended before all the bytes came (the limit, a broken connection): the time waited counts. */
        fun cut(at: Double) {
            if (first != null && at > (last ?: at)) last = at
        }

        /** Megabits a second, or null when too little came to tell. */
        val mbps: Double?
            get() {
                val first = first ?: return null
                val last = last ?: return null
                if (!(after >= least && last > first)) return null
                return after.toDouble() * 8 / (last - first) / 1_000_000
            }

        fun copy(): Meter = Meter().also { it.first = first; it.last = last; it.after = after }

        override fun equals(other: Any?): Boolean = other is Meter && other.first == first && other.last == last && other.after == after
        override fun hashCode(): Int = ((first?.hashCode() ?: 0) * 31 + (last?.hashCode() ?: 0)) * 31 + after
    }
}

/** What the address bar sends, and what it shows. */
object BrowserAddress {
    /** What [display] says: the text and whether it is a secure site (the lock). */
    data class Display(val text: String, val secure: Boolean)

    /**
     * The text typed, as the Mac takes it: a port on its own (`5173`, `:5173`) is a local server; anything else goes as
     * typed (`localhost:5173`, a bare host, `/path`, `~/path`, a URL — the Mac reads it, browser-v0 §5). Null when empty.
     * (Swift's `target(for:)`.)
     */
    fun target(typed: String): BrowserTarget? {
        val text = typed.swiftTrimmed(newlines = true)
        if (text.isEmpty()) return null
        val digits = if (text.startsWith(":")) text.substring(1) else text
        if (digits.isNotEmpty() && digits.all { it in '0'..'9' } && digits.length <= 5) {
            val port = digits.toIntOrNull()
            if (port != null && port in 1..65_535) return BrowserTarget.Port(port)
        }
        return BrowserTarget.Url(text)
    }

    private val scheme = Regex("^([A-Za-z][A-Za-z0-9+.\\-]*):(.*)$", RegexOption.DOT_MATCHES_ALL)

    /**
     * The bar's text for a URL: `github.com/acme/app/pull/128` (no scheme, no lone `/`), `localhost:5173/`,
     * `file:///Users/me/x.html`; and whether it is a secure site (the lock).
     */
    fun display(raw: String): Display {
        val m = scheme.find(raw) ?: return Display(raw, false)
        val name = m.groupValues[1].lowercase()
        when (name) {
            "https", "http" -> {
                var text = raw.drop(name.length + 3)
                if (text.startsWith("www.")) text = text.drop(4)
                if (text.endsWith("/") && text.count { it == '/' } == 1) text = text.dropLast(1)
                return Display(text, name == "https")
            }
            "file" -> {
                // `URL.path` (without the host, the query and the fragment, percent-decoded), then decoded once more.
                val rest = m.groupValues[2]
                val path = if (rest.startsWith("//")) rest.drop(2).let { a -> a.indexOf('/').let { if (it < 0) "" else a.substring(it) } } else rest
                val cut = path.takeWhile { it != '?' && it != '#' }
                val once = percentDecoded(cut, strict = false) ?: cut
                return Display("file://" + (percentDecoded(once, strict = true) ?: once), false)
            }
            else -> return Display(raw, false)
        }
    }

    /** Foundation's `removingPercentEncoding` (`strict`: null for a bad escape or bytes that are not UTF-8). */
    private fun percentDecoded(s: String, strict: Boolean): String? {
        val out = java.io.ByteArrayOutputStream()
        val bytes = s.toByteArray(Charsets.UTF_8)
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == '%'.code.toByte()) {
                val h = if (i + 2 < bytes.size) String(bytes, i + 1, 2, Charsets.US_ASCII) else null
                val v = h?.takeIf { it.all { c -> c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F' } }?.toInt(16)
                if (v == null) {
                    if (strict) return null
                    out.write(b.toInt()); i++; continue
                }
                out.write(v)
                i += 3
            } else {
                out.write(b.toInt()); i++
            }
        }
        if (!strict) return String(out.toByteArray(), Charsets.UTF_8)
        return try {
            Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            null
        }
    }

    /** Typed addresses opened from this phone, newest first, without repeats, at most `limit`. */
    fun remember(typed: String, recent: List<String>, limit: Int = 8): List<String> {
        val text = typed.swiftTrimmed(newlines = true)
        if (text.isEmpty()) return recent
        return (listOf(text) + recent.filter { it != text }).take(limit)
    }
}

/** What the page says about a hold, the same words as the Mac's footer (ui-v0 §4.1). */
object BrowserNotice {
    /** Two minutes without input gave the tab back. */
    const val idleHandBack = "2 分钟无操作，已自动交还。"

    /**
     * Said once when a person takes over an agent's tab: what is typed stays on the page for the agent to see after
     * the hand-back, and Fill Ciphertext is only on one's own tabs (docs/browser-v0.md §2 安全, §6).
     */
    const val takeOver = "接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。"

    /** Fill Ciphertext asked for on an agent's tab (the key is not offered there). */
    const val fillOwnTabsOnly = "只能在你自己的标签中填入密文。"
}

/**
 * Where a tab is held: the screen ids carry their kind (`mac-…`, `phone-…`, `web-…`); without one the Mac records the
 * paired device's id, or `local`.
 */
enum class BrowserHolder {
    Mac, Iphone, Web, Elsewhere;

    /** The short words of the holder line (§7.2.7). */
    val label: String
        get() = when (this) {
            Mac -> "On Mac"
            Iphone -> "On Phone"
            Web -> "On Web"
            Elsewhere -> "On Another Device"
        }

    /** The sentence for it (§4.1). */
    val said: String
        get() = when (this) {
            Mac -> "此标签正在 Mac 上使用。"
            Iphone -> "此标签正在另一台手机上使用。"
            Web -> "此标签正在浏览器中使用。"
            Elsewhere -> "此标签正在另一台设备上使用。"
        }

    companion object {
        /** Swift's `init(_ screen:)`. */
        operator fun invoke(screen: String): BrowserHolder = when {
            screen.startsWith("phone") -> Iphone
            screen.startsWith("mac") || screen == "local" -> Mac
            screen.startsWith("web") -> Web
            else -> Elsewhere
        }
    }
}
