package com.agentswitch.kit.browser

import com.agentswitch.kit.api.BrowserStreamOptions
import com.agentswitch.kit.api.BrowserViewport
import com.agentswitch.kit.api.swiftTrimmed
import kotlin.math.abs
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The page's own zoom (browser-v0 §1, 2026-10-03 页面缩放; user: 然后我发现agentswitch的浏览器页没有放大缩小的选项，加上
 * 用来调节大小): the browser's zoom, as Chrome's and Safari's — the page is laid out for a smaller or a larger window and
 * so drawn larger or smaller (at 50% a 402 pt phone is an 804 px window: room for a page made for a desktop). Not
 * `BrowserZoom`, which enlarges the picture on the phone only and tells the page nothing.
 *
 * The Mac's service knows no zoom. A tab has one size and the screen that holds it sets it ("尺寸有主"), so the zoom is
 * part of that size: the screen's area over the factor in whole CSS pixels, at its own pixel ratio times the factor —
 * the picture comes out the size of the area again, and input, in frame pixels as ever, lands where the finger is.
 * Only the screen that sizes a tab can zoom its page.
 */
object BrowserPageZoom {
    /** The steps in percent (Chrome's). */
    val steps = listOf(25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500)

    /** No zoom: where a site not zoomed is, and a blank tab always. */
    const val standard = 100

    /** The sides in CSS pixels and the pixel ratios `POST /browser/tabs/:id/viewport` takes (§5). */
    val sides = 200..4096
    val pixelRatios = 0.5..4.0

    /**
     * The most CSS pixels a zoomed page has in all: what the Mac draws of a view at most (3840 × 2400, §5). Zoomed out
     * the page is drawn at its CSS size whatever that is — 25% of a 945 × 726 area is 3780 × 2904, 11 million pixels
     * drawn to show fewer than 3 — so a step that would pass it is not used (review, 2026-10-03; the same rule and
     * name as the Mac's). A phone's area never comes near it: 1608 × 2760 at 25%.
     */
    const val pagePixels = 3840 * 2400

    /** 1 at 100%; a percent that is none counts as 100. */
    fun factor(percent: Int): Double = if (percent > 0) percent.toDouble() / 100 else 1.0

    /** A blank tab (no site, `about:blank`): never zoomed, never remembered. */
    fun isBlank(site: String): Boolean {
        val place = site.swiftTrimmed(newlines = true)
        return place.isEmpty() || place == "about:blank"
    }

    /**
     * What a screen sets for a tab it holds: its `area` (points) over the factor in whole CSS pixels, and its pixels a
     * point times the factor, as far as the Mac takes a pixel ratio (to the hundredth). `mobile`: a phone's layout.
     */
    fun viewport(area: Size, screenScale: Double, percent: Int, mobile: Boolean = true): BrowserViewport {
        val by = factor(percent)
        val ratio = swiftMin(swiftMax(screenScale * by, pixelRatios.start), pixelRatios.endInclusive)
        return BrowserViewport(width = pixels(area.width, by), height = pixels(area.height, by),
            scale = (ratio * 100).roundedHalfAway() / 100, mobile = mobile)
    }

    /** Whole pixels, and never a number that cannot be sent. */
    private fun pixels(points: Double, factor: Double): Double {
        val side = (points / factor).roundedHalfAway()
        return if (side.isFinite()) swiftMin(swiftMax(side, 0.0), 1_000_000.0) else 0.0
    }

    /**
     * The area a page is sized for, in whole points: the screen area as it is `now` and, its width the same, no lower
     * than `sent` — the area it was sized for before; the page passes the roomiest the area has stood at this width,
     * whether or not it holds the tab just then (null: none yet). What a keyboard, a note or the zoom row takes of the
     * height neither shrinks the page — a phone's browser keeps its layout under the keyboard — nor moves the steps
     * it can use; another width (the phone turned) or more height is the area as it is.
     */
    fun sizedArea(now: Size, sent: Size?): Size {
        val rounded = Size(now.width.roundedHalfAway(), now.height.roundedHalfAway())
        if (sent == null || sent.width != rounded.width) return rounded
        return Size(rounded.width, swiftMax(rounded.height, sent.height))
    }

    /**
     * How long a screen area takes to settle: a size waits this long for the area to stop changing, and an area that
     * stood for less was a passing one.
     */
    val settle: Duration = 300.milliseconds

    /**
     * The roomiest area a page has had at this width (`sizedArea`'s `sent`), now that `area` was replaced after
     * standing for `stood`. Only an area that stood for `settle` is room the page has, not every area it was given
     * (review, 2026-10-03): a page just opened is laid out in passes, the first before its bars are — on a 402 pt
     * simulator 800 pt high for 0.06 s, then 601 until the tab bar has gone, then its 650 — and with those counted
     * the page was sized 150 pt taller than what is seen of it. No area (zero) is none.
     */
    fun roomiest(roomiest: Size?, after: Size, stood: Duration): Size? {
        if (!(after.width > 0 && after.height > 0 && stood >= settle)) return roomiest
        return sizedArea(now = after, sent = roomiest)
    }

    /**
     * The steps a screen with this area can use: those that keep both sides of the page within what the Mac takes
     * and the page within `pagePixels` — on a phone about 25% to 200%. None before the area is known.
     */
    fun usable(area: Size): List<Int> =
        steps.filter { percent ->
            val page = viewport(area = area, screenScale = 1.0, percent = percent)
            val width = page.width.toInt()
            val height = page.height.toInt()
            sides.contains(width) && sides.contains(height) && width.toLong() * height <= pagePixels
        }

    /**
     * The step in force for a site: the usable one nearest to what is `remembered` for it (the area may not allow
     * that one; what is remembered stays as it is), a tie going toward 100%; 100% for a site not remembered. Before
     * the area is known, the nearest of all the steps.
     */
    fun inForce(remembered: Int?, area: Size): Int {
        if (remembered == null) return standard
        // Whatever was kept: far outside the steps is as far as their ends.
        val wanted = minOf(maxOf(remembered.toLong(), 0L), 2L * (steps.lastOrNull() ?: standard)).toInt()
        val allowed = usable(area)
        val candidates = if (allowed.isEmpty()) steps else allowed
        // Swift's `min(by:)`: the first element no later one is less than.
        var nearest: Int? = null
        for (e in candidates) {
            val best = nearest
            if (best == null) { nearest = e; continue }
            val da = abs(e - wanted)
            val db = abs(best - wanted)
            val less = if (da == db) abs(e - standard) < abs(best - standard) else da < db
            if (less) nearest = e
        }
        return nearest ?: standard
    }

    /**
     * Zooming in on a tab at `site`: the next usable step above `percent`; null at the end of the range, and on a blank
     * tab, which is always at 100%.
     */
    fun stepIn(from: Int, site: String, area: Size): Int? =
        if (isBlank(site)) null else usable(area).firstOrNull { it > from }

    /** Zooming out: the next usable step below `percent`; null at the end of the range, and on a blank tab. */
    fun stepOut(from: Int, site: String, area: Size): Int? =
        if (isBlank(site)) null else usable(area).lastOrNull { it < from }

    /**
     * What a stream asks for above the product where its bound is the screen's own pixels (`streamScale`): a fiftieth
     * of a frame pixel a CSS pixel.
     */
    const val streamMargin = 0.02

    /**
     * The frame pixels per CSS pixel a stream asks for at a zoom: what the screen shows a point at (`scale`: its
     * device pixels, fewer on a slower link) times the factor, the Mac's own rule (its
     * BrowserScreenPolicy.frameScale). A page zoomed in has fewer CSS pixels across the same screen and is still
     * drawn at the screen's pixels; a page zoomed out comes no larger than the screen shows it (review, 2026-10-03:
     * asking `scale` itself there, only the whole screen's pixels bounded the frame, and over Tailscale a page at 50%
     * came at 2.25 times its tier's pixels). Never under 1, where the Mac draws the CSS size (`pastPixels`), nor over
     * what it takes.
     *
     * `met`: the stream's bound is the screen's own pixels at this scale (the way shows the screen's pixels: the
     * local network, a fast link). There the ask is `streamMargin` more than the product, to the hundredth the query
     * sends (review, 2026-10-03). The page's sides are whole CSS pixels, up to half a pixel off the area over the
     * factor — at 200 pixels a quarter of a percent of the scale, 0.02 at 8 — so at the product itself the view came
     * a pixel or two narrower than the screen and was stretched across it: a 365 px page at 3.3 is 1205 wide for the
     * 1206 of the screen, a 433 px one at 2.7 (90% on a 390 pt phone) 1169 for 1170. Asked the little more, the
     * bound settles the view at exactly the screen's width (1206 / 365: drawn at 3.304). Not at 100% (the page is as
     * wide as the area to the point), not under a product of 1 (the CSS size: nothing to settle), and not on a way
     * that shows fewer pixels than the screen has (a fair or a slow link): no bound of its own meets the ask there,
     * and the frame would only come a few pixels larger than the way's.
     */
    fun streamScale(scale: Double, factor: Double, met: Boolean = false): Double {
        val by = if (factor > 0) factor else 1.0
        val product = scale * by
        val asked = if (met && by != 1.0 && product > 1) ((product + streamMargin) * 100).roundedHalfAway() / 100 else product
        return swiftMin(swiftMax(asked, 1.0), BrowserStreamOptions.maxScale)
    }

    /**
     * The page is zoomed out past a frame pixel a CSS pixel on a screen (or a link) that shows `scale` to a point:
     * their product is under 1. The stream cannot ask for less than 1, and the Mac draws the CSS size, more pixels
     * than are shown: there the frame is bounded by what is shown instead (BrowserStreamPolicy).
     */
    fun pastPixels(scale: Double, factor: Double): Boolean = factor > 0 && scale * factor < 1
}

/**
 * The page zoom a device remembers, a site at a time as Chrome does (browser-v0 §1 页面缩放). The key is the tab's
 * `site` — the list's second line: a host, `localhost:5173`, a file's path — so every tab of a site is at its zoom
 * here. The phone's own: the Mac keeps another (a page wanted at 50% on the phone is at 100% there). A site at 100%
 * is not kept, nor a blank tab; at most `limit` sites, the one set longest ago dropped first.
 */
@Serializable(with = BrowserZoomMemorySerializer::class)
class BrowserZoomMemory(sites: List<Entry> = emptyList()) {
    /** A site and the percent its pages are at. */
    @Serializable(with = BrowserZoomMemoryEntrySerializer::class)
    data class Entry(val site: String, val percent: Int)

    /**
     * The sites zoomed, the one set last first. What was kept, as this keeps it: a site once (its first, the newest),
     * nothing blank, at 100% or outside the steps (a value this did not write), at most `limit`.
     */
    val sites: List<Entry> = run {
        val seen = HashSet<String>()
        sites.filter { keeps(it) && seen.add(it.site) }.take(limit)
    }

    /** The percent remembered for a site; null for one not zoomed (100%). */
    fun percent(forSite: String): Int? = sites.firstOrNull { it.site == forSite }?.percent

    /** With `site` at `percent` from now on, the newest of them: 100% forgets it; a blank tab is never kept. */
    fun setting(percent: Int, forSite: String): BrowserZoomMemory =
        BrowserZoomMemory(listOf(Entry(site = forSite, percent = percent)) + sites.filter { it.site != forSite })

    override fun equals(other: Any?): Boolean = other is BrowserZoomMemory && other.sites == sites
    override fun hashCode(): Int = sites.hashCode()
    override fun toString(): String = "BrowserZoomMemory(sites=$sites)"

    companion object {
        const val limit = 200

        private fun keeps(entry: Entry): Boolean {
            val least = BrowserPageZoom.steps.firstOrNull() ?: return false
            val most = BrowserPageZoom.steps.lastOrNull() ?: return false
            return !BrowserPageZoom.isBlank(entry.site) && entry.percent != BrowserPageZoom.standard && entry.percent in least..most
        }
    }
}

internal object BrowserZoomMemoryEntrySerializer : KSerializer<BrowserZoomMemory.Entry> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): BrowserZoomMemory.Entry =
        read((decoder as? JsonDecoder ?: throw SerializationException("JSON only")).decodeJsonElement())

    /** Both keys, of their types, or it does not read (Swift's synthesized `Decodable`); an `Int64` outside `Int` is read as its end. */
    fun read(element: JsonElement): BrowserZoomMemory.Entry {
        val o = element as? JsonObject ?: throw SerializationException("an entry is an object")
        val site = (o["site"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: throw SerializationException("site")
        val p = (o["percent"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: throw SerializationException("percent")
        return BrowserZoomMemory.Entry(site, p.coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt())
    }

    override fun serialize(encoder: Encoder, value: BrowserZoomMemory.Entry) {
        (encoder as? JsonEncoder ?: throw SerializationException("JSON only"))
            .encodeJsonElement(JsonObject(linkedMapOf("site" to JsonPrimitive(value.site), "percent" to JsonPrimitive(value.percent))))
    }
}

internal object BrowserZoomMemorySerializer : KSerializer<BrowserZoomMemory> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): BrowserZoomMemory {
        val o = (decoder as? JsonDecoder ?: throw SerializationException("JSON only")).decodeJsonElement() as? JsonObject
            ?: throw SerializationException("the memory is an object")
        val sites = o["sites"] as? JsonArray ?: throw SerializationException("sites")
        return BrowserZoomMemory(sites.map { BrowserZoomMemoryEntrySerializer.read(it) })
    }

    override fun serialize(encoder: Encoder, value: BrowserZoomMemory) {
        val entries = value.sites.map {
            JsonObject(linkedMapOf("site" to JsonPrimitive(it.site), "percent" to JsonPrimitive(it.percent)))
        }
        (encoder as? JsonEncoder ?: throw SerializationException("JSON only"))
            .encodeJsonElement(JsonObject(linkedMapOf("sites" to JsonArray(entries))))
    }
}
