package com.agentswitch.kit.browser

import com.agentswitch.kit.api.BrowserBox
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.truncate

// Swift's CGSize / CGPoint / CGRect as small kit types of Doubles. Equality is IEEE (`-0.0 == 0.0`), as CoreGraphics'.

/** Swift's `Double.rounded()`: to the nearest whole number, halves away from zero. */
internal fun Double.roundedHalfAway(): Double {
    if (isNaN() || isInfinite()) return this
    val whole = truncate(this)
    return if (abs(this - whole) >= 0.5) whole + (if (this < 0) -1.0 else 1.0) else whole
}

/** Swift's `min(a, b)` / `max(a, b)` for the values of this file: `NaN` is not propagated, as there. */
internal fun swiftMin(a: Double, b: Double): Double = if (b < a) b else a
internal fun swiftMax(a: Double, b: Double): Double = if (b >= a) b else a

/** `CGSize`. */
data class Size(val width: Double, val height: Double) {
    override fun equals(other: Any?): Boolean = other is Size && other.width == width && other.height == height
    override fun hashCode(): Int = 31 * (width + 0.0).hashCode() + (height + 0.0).hashCode()

    companion object {
        val zero = Size(0.0, 0.0)
    }
}

/** `CGPoint`. */
data class Point(val x: Double, val y: Double) {
    override fun equals(other: Any?): Boolean = other is Point && other.x == x && other.y == y
    override fun hashCode(): Int = 31 * (x + 0.0).hashCode() + (y + 0.0).hashCode()

    companion object {
        val zero = Point(0.0, 0.0)
    }
}

/** `CGRect`. */
data class Rect(val x: Double, val y: Double, val width: Double, val height: Double) {
    constructor(origin: Point, size: Size) : this(origin.x, origin.y, size.width, size.height)

    val origin: Point get() = Point(x, y)
    val size: Size get() = Size(width, height)

    val minX: Double get() = min(x, x + width)
    val maxX: Double get() = max(x, x + width)
    val minY: Double get() = min(y, y + height)
    val maxY: Double get() = max(y, y + height)
    val midX: Double get() = (minX + maxX) / 2
    val midY: Double get() = (minY + maxY) / 2

    /** `CGRectNull`: what [intersection] says of two rectangles that do not meet. */
    val isNull: Boolean get() = x == Double.POSITIVE_INFINITY || y == Double.POSITIVE_INFINITY
    val isEmpty: Boolean get() = isNull || width == 0.0 || height == 0.0

    /** `CGRect.intersection`: [NULL] when they do not overlap. */
    fun intersection(other: Rect): Rect {
        if (isNull || other.isNull) return NULL
        val left = max(minX, other.minX)
        val right = min(maxX, other.maxX)
        val top = max(minY, other.minY)
        val bottom = min(maxY, other.maxY)
        if (left > right || top > bottom) return NULL
        return Rect(left, top, right - left, bottom - top)
    }

    override fun equals(other: Any?): Boolean =
        other is Rect && other.x == x && other.y == y && other.width == width && other.height == height

    override fun hashCode(): Int =
        ((31 * (x + 0.0).hashCode() + (y + 0.0).hashCode()) * 31 + (width + 0.0).hashCode()) * 31 + (height + 0.0).hashCode()

    companion object {
        val zero = Rect(0.0, 0.0, 0.0, 0.0)
        val NULL = Rect(Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 0.0, 0.0)
    }
}

/**
 * The phone's own zoom of the picture (browser-v0 §1: two fingers zoom the picture on the phone only, the page is not
 * told): content point `p` shows at `p × scale + offset`. Pinching keeps the point under the fingers where it is; the
 * zoomed picture always covers the screen area (no empty margin dragged in). Not the page's zoom (`BrowserPageZoom`,
 * which lays the page out afresh): that one is the zoom key's while this phone sizes the tab; while it only watches,
 * the same key steps this one (`steps`, `stepped`).
 */
data class BrowserZoom(val scale: Double = 1.0, val offset: Point = Point.zero) {
    val isZoomed: Boolean get() = scale > 1.001

    /** The scale as the zoom key writes it (`150%`). */
    val percent: Int get() = (scale * 100).roundedHalfAway().toInt()

    /**
     * The scale as the chip at the picture's top right writes it (browser-v0 §1 iPhone: `2.0×`): to one decimal,
     * wherever two fingers left it (`1.4×`) — but a step of the zoom key that has hundredths in full (`1.25×`, as the
     * demo page; review, 2026-10-03: to one decimal the 125% step read `1.2×` beside a key and a row saying `125%`).
     */
    val times: String
        get() {
            val step = steps.firstOrNull { abs(it - scale) < 0.001 }
            val tenths = step?.let { (it * 10).roundedHalfAway() == it * 10 } ?: true
            return fixed(step ?: scale, if (tenths) 1 else 2) + "×"
        }

    /** The next step above the scale now; null at the end of the range. */
    val stepIn: Double? get() = steps.firstOrNull { it > scale + 0.001 }

    /** The next step below the scale now; null at the whole picture. */
    val stepOut: Double? get() = steps.lastOrNull { it < scale - 0.001 }

    fun apply(p: Point): Point = Point(p.x * scale + offset.x, p.y * scale + offset.y)

    fun invert(p: Point): Point = Point((p.x - offset.x) / scale, (p.y - offset.y) / scale)

    /** Zoomed to `newScale` (kept in `range`) about `center`, a point of the screen area. */
    fun pinched(to: Double, around: Point, area: Size): BrowserZoom {
        val s = swiftMin(swiftMax(to, range.start), range.endInclusive)
        val content = invert(around)
        return BrowserZoom(scale = s, offset = Point(around.x - content.x * s, around.y - content.y * s)).clamped(area)
    }

    /**
     * Zoomed to `newScale` by the key rather than by fingers: about the middle of the part of the picture now in view
     * (`picture`: where it is drawn before the zoom, BrowserLayout). A picture still shorter than the area keeps its
     * top edge at the area's top, where a page being watched sits — it grows downwards, never out of sight with room
     * left under it; a taller one covers the area's height.
     */
    fun stepped(to: Double, picture: Rect, area: Size): BrowserZoom {
        val shown = Rect(apply(picture.origin), Size(picture.width * scale, picture.height * scale))
        val seen = shown.intersection(Rect(Point.zero, area))
        val middle = if (seen.isNull || seen.isEmpty) Point(area.width / 2, area.height / 2) else Point(seen.midX, seen.midY)
        val next = pinched(to, middle, area)
        val top = picture.minY * next.scale + next.offset.y
        val kept = swiftMin(0.0, swiftMax(swiftMin(0.0, area.height - picture.height * next.scale), top))
        return BrowserZoom(scale = next.scale, offset = Point(next.offset.x, next.offset.y + kept - top)).clamped(area)
    }

    /** Moved by a two-finger drag. */
    fun panned(by: Size, area: Size): BrowserZoom =
        BrowserZoom(scale = scale, offset = Point(offset.x + by.width, offset.y + by.height)).clamped(area)

    /** The offset kept so the zoomed area still covers the screen area; none at all at scale 1. */
    fun clamped(area: Size): BrowserZoom {
        val minX = area.width - area.width * scale
        val minY = area.height - area.height * scale
        return BrowserZoom(scale = scale, offset = Point(swiftMin(0.0, swiftMax(minX, offset.x)), swiftMin(0.0, swiftMax(minY, offset.y))))
    }

    companion object {
        val none = BrowserZoom()
        val range: ClosedFloatingPointRange<Double> = 1.0..4.0

        /**
         * The scales the zoom key goes through (browser-v0 §1 页面缩放, 2026-10-03: 100 125 150 200 300 400); a pinch
         * stops anywhere between.
         */
        val steps: List<Double> = listOf(1.0, 1.25, 1.5, 2.0, 3.0, 4.0)
    }
}

/** `String(format: "%.<digits>f")`: the exact binary value rounded half to even, as C does. */
internal fun fixed(value: Double, digits: Int): String =
    java.math.BigDecimal(value).setScale(digits, java.math.RoundingMode.HALF_EVEN).toPlainString()

/**
 * Where a tab's picture sits on the phone, and how a touch maps back to the frame (docs/browser-v0.md §5: input points
 * are frame pixels of the frame they were aimed at; the Mac divides by the frame's scale for the page's CSS pixels).
 *
 * Watching, the picture is fitted into the screen area, its top at the top. While this phone holds the tab at its own
 * size the frame is the screen area's size, drawn one to one across the width; when the keyboard takes part of the
 * area, the picture stays that size and is `lift`ed so what was touched stays in sight.
 */
class BrowserLayout(
    /** The frame's size in pixels. */
    val frame: Size,
    /** The screen area. */
    val area: Size,
    fillWidth: Boolean = false,
    lift: Double = 0.0,
    val zoom: BrowserZoom = BrowserZoom.none,
) {
    /** Where the picture is drawn, before the zoom. */
    val picture: Rect = run {
        if (!(frame.width > 0 && frame.height > 0 && area.width > 0 && area.height > 0)) {
            Rect.zero
        } else {
            val fit = swiftMin(area.width / frame.width, area.height / frame.height)
            val k = if (fillWidth) area.width / frame.width else fit
            val size = Size(frame.width * k, frame.height * k)
            val room = swiftMax(0.0, size.height - area.height)
            // `0.0 - x`, not `-x`: no negative zero for a picture that is not lifted.
            Rect((area.width - size.width) / 2, 0.0 - swiftMin(swiftMax(lift, 0.0), room), size.width, size.height)
        }
    }

    /** Screen points per frame pixel, the zoom included. */
    val pointsPerPixel: Double
        get() {
            if (!(frame.width > 0)) return 1.0
            return picture.width / frame.width * zoom.scale
        }

    /** The frame pixel under a point of the screen area; null off the picture. */
    fun framePoint(at: Point): Point? {
        if (!(picture.width > 0 && picture.height > 0)) return null
        val p = zoom.invert(at)
        val x = (p.x - picture.minX) / picture.width * frame.width
        val y = (p.y - picture.minY) / picture.height * frame.height
        if (!(x >= 0 && y >= 0 && x <= frame.width && y <= frame.height)) return null
        return Point(x, y)
    }

    /** Where a box of the page (CSS pixels) shows on the screen area: `frameScale` frame pixels per CSS pixel. */
    fun screenRect(ofPage: BrowserBox, frameScale: Double): Rect {
        if (!(frame.width > 0 && frame.height > 0)) return Rect.zero
        val s = if (frameScale > 0) frameScale else 1.0
        val kx = picture.width / frame.width
        val ky = picture.height / frame.height
        val origin = zoom.apply(Point(picture.minX + ofPage.x * s * kx, picture.minY + ofPage.y * s * ky))
        return Rect(origin.x, origin.y, ofPage.width * s * kx * zoom.scale, ofPage.height * s * ky * zoom.scale)
    }

    /**
     * A finger's movement as the wheel's delta in frame pixels: the page follows the finger (drag up, the page goes on
     * down), as a touch screen scrolls.
     */
    fun wheelDelta(forDrag: Size): Size {
        val k = if (pointsPerPixel > 0) pointsPerPixel else 1.0
        return Size(-forDrag.width / k, -forDrag.height / k)
    }

    override fun equals(other: Any?): Boolean =
        other is BrowserLayout && other.frame == frame && other.area == area && other.picture == picture && other.zoom == zoom

    override fun hashCode(): Int = ((frame.hashCode() * 31 + area.hashCode()) * 31 + picture.hashCode()) * 31 + zoom.hashCode()

    companion object {
        /**
         * How far to lift a picture drawn across the width so that frame row `frameY` shows `margin` of the way down an
         * area `visible` tall: 0 when it fits.
         */
        fun lift(toShow: Double, frame: Size, areaWidth: Double, visible: Double, margin: Double = 0.4): Double {
            if (!(frame.width > 0 && areaWidth > 0 && visible > 0)) return 0.0
            val k = areaWidth / frame.width
            val height = frame.height * k
            val room = swiftMax(0.0, height - visible)
            return swiftMin(swiftMax(toShow * k - visible * margin, 0.0), room)
        }
    }
}
