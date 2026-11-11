package com.agentswitch.kit

import com.agentswitch.kit.api.*
import com.agentswitch.kit.browser.*
import com.agentswitch.kit.support.KitJson
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * The page's own zoom on the phone (docs/browser-v0.md §1, 2026-10-03 页面缩放): the steps a screen can use, the size it
 * sets at one, what the stream asks for, what the phone remembers by site — and the picture's own steps, for the same
 * key while the phone only watches a tab.
 */
class BrowserZoomTests {
    /** A phone's screen area in points, at 3 pixels a point. */
    private val phone = Size(402.0, 700.0)

    private fun assertNear(expected: Double, actual: Double, accuracy: Double, message: String? = null) =
        assertTrue(abs(expected - actual) <= accuracy, "${message ?: ""} expected $expected but was $actual")

    private fun options(quality: Int, fps: Int, maxWidth: Int? = null, maxHeight: Int? = null, scale: Double? = null) =
        BrowserStreamOptions(quality = quality, fps = fps, maxWidth = maxWidth, maxHeight = maxHeight, scale = scale)

    // MARK: the page's size

    @Test
    fun testThePageIsTheAreaOverTheFactorAtThePixelRatioTimesIt() {
        assertEquals(listOf(25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500), BrowserPageZoom.steps)
        assertEquals(0.67, BrowserPageZoom.factor(67))
        // 100%: as before the zoom — the area in points, the screen's pixel ratio, a phone's layout.
        assertEquals(BrowserViewport(width = 402.0, height = 700.0, scale = 3.0, mobile = true), BrowserPageZoom.viewport(area = phone, screenScale = 3.0, percent = 100))
        // 50%: the page sees an 804 px window (room for a page made for a desktop), drawn at half the pixels a CSS pixel.
        assertEquals(BrowserViewport(width = 804.0, height = 1400.0, scale = 1.5, mobile = true), BrowserPageZoom.viewport(area = phone, screenScale = 3.0, percent = 50))
        assertEquals(BrowserViewport(width = 600.0, height = 1045.0, scale = 2.01, mobile = true), BrowserPageZoom.viewport(area = phone, screenScale = 3.0, percent = 67))
        // The pixel ratio stays within what the Mac takes (0.5–4).
        assertEquals(BrowserViewport(width = 268.0, height = 467.0, scale = 4.0, mobile = true), BrowserPageZoom.viewport(area = phone, screenScale = 3.0, percent = 150))
        assertEquals(BrowserViewport(width = 1608.0, height = 2800.0, scale = 0.5, mobile = true), BrowserPageZoom.viewport(area = phone, screenScale = 1.0, percent = 25))
        // A screen area is not always whole points: the page is whole pixels.
        assertEquals(BrowserViewport(width = 491.0, height = 825.0, scale = 2.4, mobile = true),
            BrowserPageZoom.viewport(area = Size(393.0, 659.67), screenScale = 3.0, percent = 80))
        assertEquals(BrowserViewport(width = 990.0, height = 721.0, scale = 2.0),
            BrowserPageZoom.viewport(area = Size(990.0, 721.0), screenScale = 2.0, percent = 100, mobile = false))
        // Never a size that cannot be sent: a percent that is none counts as 100.
        assertEquals(402.0, BrowserPageZoom.viewport(area = phone, screenScale = 3.0, percent = 0).width)
        assertEquals(0.0, BrowserPageZoom.viewport(area = Size(Double.NaN, 700.0), screenScale = 3.0, percent = 100).width)
    }

    @Test
    fun testAScreenUsesTheStepsThatKeepThePageWithinWhatTheMacTakes() {
        // The viewport route takes 200–4096 a side: a phone about 25% to 200%.
        assertEquals(listOf(25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200), BrowserPageZoom.usable(phone))
        // 375 wide: at 200% the page would be 188 wide.
        assertEquals(175, BrowserPageZoom.usable(Size(375.0, 560.0)).last())
        // A Mac's window, for the same rule: 1280 at 25% is 5120 wide, 721 at 400% is 180 high.
        assertEquals(listOf(33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300), BrowserPageZoom.usable(Size(1280.0, 721.0)))
        assertEquals(emptyList(), BrowserPageZoom.usable(Size.zero), "no area yet")
    }

    /**
     * The page stays within what the Mac draws of a view in all (3840 × 2400, §5): zoomed out it is drawn at its CSS
     * size whatever that is, so a step whose sides both fit can still be too much (review, 2026-10-03; the Mac's
     * BrowserPageZoom.pagePixels is the same rule).
     */
    @Test
    fun testAScreenUsesNoStepThatMakesThePageMoreThanTheMacDraws() {
        assertEquals(3840 * 2400, BrowserPageZoom.pagePixels)
        // The Mac's main window: 25% would be 3780 × 2904 — each side within 4096, 11 million pixels in all.
        val window = Size(945.0, 726.0)
        val sides = BrowserPageZoom.viewport(area = window, screenScale = 2.0, percent = 25, mobile = false)
        assertEquals(Size(3780.0, 2904.0), Size(sides.width, sides.height))
        assertTrue(BrowserPageZoom.sides.contains(3780) && BrowserPageZoom.sides.contains(2904), "the sides fit")
        assertEquals(listOf(33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300), BrowserPageZoom.usable(window))
        assertEquals(33, BrowserPageZoom.inForce(remembered = 25, area = window))
        assertNull(BrowserPageZoom.stepOut(from = 33, site = "github.com", area = window))
        // The bound itself: as many pixels as the Mac draws are still a step, one column more is not.
        assertEquals(25, BrowserPageZoom.usable(Size(800.0, 600.0)).first(), "3200 × 2400")
        assertEquals(25, BrowserPageZoom.usable(Size(960.0, 600.0)).first(), "3840 × 2400: just within it")
        assertEquals(33, BrowserPageZoom.usable(Size(961.0, 600.0)).first(), "3844 × 2400: a column past it")
        assertEquals(33, BrowserPageZoom.usable(Size(1024.0, 900.0)).first(), "4096 × 3600 at 25%")
        assertEquals(67, BrowserPageZoom.usable(Size(2048.0, 1200.0)).first(), "4096 × 2400 at 50%")
        // A phone is far from it: 1608 × 2800 at 25%, 4.5 million.
        assertEquals(25, BrowserPageZoom.usable(phone).first())
    }

    @Test
    fun testTheStepInForceIsTheUsableOneNearestToWhatIsRemembered() {
        assertEquals(100, BrowserPageZoom.inForce(remembered = null, area = phone), "a site not zoomed")
        assertEquals(50, BrowserPageZoom.inForce(remembered = 50, area = phone))
        assertEquals(200, BrowserPageZoom.inForce(remembered = 200, area = phone))
        // The area does not allow what is remembered: the nearest step that it does.
        assertEquals(200, BrowserPageZoom.inForce(remembered = 300, area = phone))
        assertEquals(175, BrowserPageZoom.inForce(remembered = 200, area = Size(375.0, 560.0)))
        assertEquals(33, BrowserPageZoom.inForce(remembered = 25, area = Size(1280.0, 721.0)))
        // A tie goes toward 100%.
        assertEquals(100, BrowserPageZoom.inForce(remembered = 95, area = phone))
        assertEquals(100, BrowserPageZoom.inForce(remembered = 105, area = phone))
        assertEquals(90, BrowserPageZoom.inForce(remembered = 85, area = phone))
        assertEquals(75, BrowserPageZoom.inForce(remembered = 71, area = phone))
        // Before the area is known: what is remembered, as a step.
        assertEquals(150, BrowserPageZoom.inForce(remembered = 150, area = Size.zero))
        assertEquals(100, BrowserPageZoom.inForce(remembered = null, area = Size.zero))
        // Whatever was kept is read without a trap.
        assertEquals(200, BrowserPageZoom.inForce(remembered = Int.MAX_VALUE, area = phone))
        assertEquals(25, BrowserPageZoom.inForce(remembered = Int.MIN_VALUE, area = phone))
    }

    @Test
    fun testZoomingInAndOutGoesToTheNextUsableStep() {
        val site = "github.com"
        assertEquals(110, BrowserPageZoom.stepIn(from = 100, site = site, area = phone))
        assertEquals(90, BrowserPageZoom.stepOut(from = 100, site = site, area = phone))
        assertEquals(200, BrowserPageZoom.stepIn(from = 175, site = site, area = phone))
        assertNull(BrowserPageZoom.stepIn(from = 200, site = site, area = phone), "the end of the phone's range")
        assertNull(BrowserPageZoom.stepOut(from = 25, site = site, area = phone))
        assertEquals(25, BrowserPageZoom.stepOut(from = 33, site = site, area = phone))
        assertNull(BrowserPageZoom.stepIn(from = 175, site = site, area = Size(375.0, 560.0)))
        assertNull(BrowserPageZoom.stepOut(from = 33, site = site, area = Size(1280.0, 721.0)))
        // From a percent that is no step (never in force, but asked for all the same).
        assertEquals(100, BrowserPageZoom.stepIn(from = 95, site = site, area = phone))
        assertEquals(90, BrowserPageZoom.stepOut(from = 95, site = site, area = phone))
        assertNull(BrowserPageZoom.stepIn(from = 100, site = site, area = Size.zero), "no area yet")
        assertNull(BrowserPageZoom.stepOut(from = 100, site = site, area = Size.zero))
    }

    /** A blank tab is never zoomed and never remembered. */
    @Test
    fun testABlankTabHasNoZoom() {
        assertTrue(BrowserPageZoom.isBlank(""))
        assertTrue(BrowserPageZoom.isBlank("  "))
        assertTrue(BrowserPageZoom.isBlank("about:blank"))
        assertTrue(!BrowserPageZoom.isBlank("github.com"))
        assertTrue(!BrowserPageZoom.isBlank("localhost:5173"))
        assertTrue(!BrowserPageZoom.isBlank("~/Projects/x/index.html"))
        // Always at 100%: no step in or out, where a site, a local server or a file has both.
        for (blank in listOf("", "  ", "about:blank")) {
            assertNull(BrowserPageZoom.stepIn(from = 100, site = blank, area = phone), "'$blank'")
            assertNull(BrowserPageZoom.stepOut(from = 100, site = blank, area = phone), "'$blank'")
            assertEquals(100, BrowserPageZoom.inForce(remembered = BrowserZoomMemory().setting(150, forSite = blank).percent(forSite = blank), area = phone), "'$blank'")
        }
        for (site in listOf("github.com", "localhost:5173", "~/Projects/x/index.html")) {
            assertEquals(110, BrowserPageZoom.stepIn(from = 100, site = site, area = phone), site)
            assertEquals(90, BrowserPageZoom.stepOut(from = 100, site = site, area = phone), site)
        }
    }

    /**
     * What takes part of the screen area after the size was set — a keyboard, a note, the zoom row itself — neither
     * shrinks the page nor moves the steps it can use.
     */
    @Test
    fun testThePageKeepsTheAreaItWasSizedFor() {
        // No size set yet: the area, in whole points.
        assertEquals(phone, BrowserPageZoom.sizedArea(now = phone, sent = null))
        assertEquals(Size(393.0, 660.0), BrowserPageZoom.sizedArea(now = Size(393.4, 659.67), sent = null))
        // The zoom row (46 pt), then a keyboard, over the area: as high as the page was sized.
        assertEquals(phone, BrowserPageZoom.sizedArea(now = Size(402.0, 654.0), sent = phone))
        assertEquals(phone, BrowserPageZoom.sizedArea(now = Size(402.0, 364.0), sent = phone))
        assertEquals(phone, BrowserPageZoom.sizedArea(now = Size(401.7, 653.5), sent = phone), "the same width in whole points")
        assertEquals(phone, BrowserPageZoom.sizedArea(now = phone, sent = phone))
        // More height: the page follows.
        assertEquals(Size(402.0, 734.0), BrowserPageZoom.sizedArea(now = Size(402.0, 734.2), sent = phone))
        // Another width (the phone turned): the area as it is now, lower or not.
        val turned = Size(874.0, 320.0)
        assertEquals(turned, BrowserPageZoom.sizedArea(now = turned, sent = phone))
        assertEquals(phone, BrowserPageZoom.sizedArea(now = phone, sent = turned))
        assertEquals(Size(403.0, 654.0), BrowserPageZoom.sizedArea(now = Size(403.0, 654.0), sent = phone))
        // So a keyboard coming up over a page at 200% changes nothing: by the area left above it the page would be 182
        // high, under what the Mac takes — the step in force would fall to 175% and the page be laid out again.
        val typing = Size(402.0, 364.0)
        assertEquals(175, BrowserPageZoom.usable(typing).last(), "what the area left alone would allow")
        val sized = BrowserPageZoom.sizedArea(now = typing, sent = phone)
        assertEquals(BrowserPageZoom.usable(phone), BrowserPageZoom.usable(sized))
        assertEquals(200, BrowserPageZoom.inForce(remembered = 200, area = sized))
        assertEquals(175, BrowserPageZoom.stepOut(from = 200, site = "github.com", area = sized))
        assertEquals(BrowserViewport(width = 201.0, height = 350.0, scale = 4.0, mobile = true), BrowserPageZoom.viewport(area = sized, screenScale = 3.0, percent = 200))
    }

    /**
     * Not every area a page is given is room it has: a page just opened is laid out in passes, the first before its
     * bars are. Only an area that stood counts (the simulator's numbers, iPhone 18 Pro, 2026-10-03).
     */
    @Test
    fun testOnlyAnAreaThatStoodIsRoomThePageHas() {
        assertEquals(300.milliseconds, BrowserPageZoom.settle)
        fun room(before: Size?, areas: List<Pair<Double, Duration>>): Size? =
            areas.fold(before) { acc, a -> BrowserPageZoom.roomiest(acc, after = Size(402.0, a.first), stood = a.second) }
        // Opening: 800 high for 0.06 s (no bars yet), 601 for 0.09 s (the tab bar still there), then its 650.
        val opened = room(null, listOf(800.0 to 60.milliseconds, 601.0 to 90.milliseconds))
        assertNull(opened, "passing areas are no room")
        assertEquals(Size(402.0, 650.0), BrowserPageZoom.sizedArea(now = Size(402.0, 650.0), sent = opened))
        // The zoom row opens a second and a half later: the 650 stood, and is the room from then on — under the row
        // (604.33), the key bar and the keyboard (337.33), a note.
        val stood = room(opened, listOf(650.0 to 1500.milliseconds))
        assertEquals(Size(402.0, 650.0), stood)
        val covered = room(stood, listOf(604.33 to 2.seconds, 650.0 to 1.seconds, 604.33 to 355.milliseconds, 337.33 to 8.seconds, 620.0 to 4.seconds))
        assertEquals(Size(402.0, 650.0), covered, "what takes of the area never lowers it")
        assertEquals(Size(402.0, 650.0), BrowserPageZoom.sizedArea(now = Size(402.0, 337.33), sent = covered))
        // A passing area later on is none either, however tall.
        assertEquals(covered, room(covered, listOf(800.0 to 120.milliseconds)))
        // Just long enough counts; more room that stood is the room.
        assertEquals(null, room(null, listOf(650.0 to 299.milliseconds)))
        assertEquals(Size(402.0, 650.0), room(null, listOf(650.0 to 300.milliseconds)))
        assertEquals(Size(402.0, 700.0), room(covered, listOf(700.4 to 1.seconds)))
        // Another width (the phone turned): that area, lower or not.
        assertEquals(Size(874.0, 320.0), BrowserPageZoom.roomiest(covered, after = Size(874.0, 320.0), stood = 3.seconds))
        // No area yet is none.
        assertNull(BrowserPageZoom.roomiest(null, after = Size.zero, stood = 60.seconds))
        assertEquals(covered, BrowserPageZoom.roomiest(covered, after = Size.zero, stood = 60.seconds))
    }

    // MARK: the stream

    /**
     * One rule at every zoom, as the Mac's (BrowserScreenPolicy.frameScale): what the screen shows a point at times
     * the factor — and a fiftieth more where the stream's bound is the screen's own pixels, so that the bound settles
     * the frame's width.
     */
    @Test
    fun testTheStreamAsksForTheScreensPixelsOfThePageAtItsZoom() {
        assertEquals(3.0, BrowserPageZoom.streamScale(3.0, factor = 1.0))
        assertEquals(2.0, BrowserPageZoom.streamScale(2.0, factor = 1.0))
        // Zoomed out a CSS pixel is less than a point wide: fewer frame pixels of each, the frame no larger for it.
        assertEquals(2.7, BrowserPageZoom.streamScale(3.0, factor = 0.9), 1e-9)
        assertEquals(1.5, BrowserPageZoom.streamScale(3.0, factor = 0.5))
        assertEquals(1.34, BrowserPageZoom.streamScale(2.0, factor = 0.67), 1e-9)
        assertEquals(1.0, BrowserPageZoom.streamScale(2.0, factor = 0.5))
        // Never under 1: the Mac draws the CSS size there, whatever is asked.
        assertEquals(1.0, BrowserPageZoom.streamScale(3.0, factor = 0.33))
        assertEquals(1.0, BrowserPageZoom.streamScale(2.0, factor = 0.25))
        assertEquals(1.0, BrowserPageZoom.streamScale(1.0, factor = 0.9))
        // Zoomed in, the product: at 200% a CSS pixel is two points, six pixels of a 3× screen.
        assertEquals(6.0, BrowserPageZoom.streamScale(3.0, factor = 2.0))
        assertEquals(3.5, BrowserPageZoom.streamScale(2.0, factor = 1.75))
        assertEquals(1.1, BrowserPageZoom.streamScale(1.0, factor = 1.1))
        assertEquals(8.0, BrowserPageZoom.streamScale(3.0, factor = 5.0), "within what the Mac takes")
        assertEquals(3.0, BrowserPageZoom.streamScale(3.0, factor = 0.0), "no zoom at all is 100%")
        assertEquals(8.0, BrowserStreamOptions.maxScale)
        // Where the stream's bound is the screen's own pixels at this scale (the local network, a fast link), a
        // fiftieth more at every zoom but 100%, in and out, for the bound to settle the frame's width.
        assertEquals(6.02, BrowserPageZoom.streamScale(3.0, factor = 2.0, met = true))
        assertEquals(3.32, BrowserPageZoom.streamScale(3.0, factor = 1.1, met = true))
        assertEquals(3.77, BrowserPageZoom.streamScale(3.0, factor = 1.25, met = true))
        assertEquals(2.72, BrowserPageZoom.streamScale(3.0, factor = 0.9, met = true))
        assertEquals(1.52, BrowserPageZoom.streamScale(3.0, factor = 0.5, met = true))
        assertEquals(3.0, BrowserPageZoom.streamScale(3.0, factor = 1.0, met = true), "100%: the page is as wide as the area, to the point")
        assertEquals(1.0, BrowserPageZoom.streamScale(3.0, factor = 0.33, met = true), "the CSS size: nothing to settle")
        assertEquals(1.0, BrowserPageZoom.streamScale(2.0, factor = 0.5, met = true))
        assertEquals(8.0, BrowserPageZoom.streamScale(3.0, factor = 5.0, met = true), "within what the Mac takes")
        assertEquals(8.0, BrowserPageZoom.streamScale(2.0, factor = 3.995, met = true), "the fiftieth too")
        // What is sent is the ask to the hundredth, as it is.
        assertEquals("6.02", options(70, 15, scale = BrowserPageZoom.streamScale(3.0, factor = 2.0, met = true)).query.last().value)
        assertEquals("3.32", options(70, 15, scale = BrowserPageZoom.streamScale(3.0, factor = 1.1, met = true)).query.last().value)
        assertEquals("2.72", options(70, 15, scale = BrowserPageZoom.streamScale(3.0, factor = 0.9, met = true)).query.last().value)
        assertEquals("2.7", options(70, 15, scale = BrowserPageZoom.streamScale(3.0, factor = 0.9)).query.last().value)
        assertEquals("2.01", options(70, 15, scale = BrowserPageZoom.streamScale(3.0, factor = 0.67)).query.last().value)
    }

    @Test
    fun testEveryTierAsksAtTheZoom() {
        val pixels = Size(1206.0, 2622.0)
        fun options(kind: EndpointKind?, mbps: Double?, zoom: Double): BrowserStreamOptions =
            BrowserStreamPolicy.options(kind = kind, mbps = mbps, screenPixels = pixels, screenScale = 3.0, zoom = zoom)
        // The local network and a fast link: the screen's pixels of the zoomed page.
        assertEquals(options(70, 15, 1206, 2622, 6.02), options(EndpointKind.Lan, null, zoom = 2.0))
        assertEquals(options(70, 15, 1206, 2622, 4.52), options(EndpointKind.Tailnet, 40.0, zoom = 1.5))
        // A fair link: at most 2 a point, times the factor — the product itself: it shows fewer pixels than this
        // screen has, so no bound of its own meets a little more.
        assertEquals(options(60, 10, 1206, 2622, 4.0), options(EndpointKind.Tailnet, 12.0, zoom = 2.0))
        // A slow link asks for no scale at 100%; of a page zoomed in it asks for the factor, the same pixels as before.
        assertEquals(options(45, 5, 1206, 2622, 2.0), options(EndpointKind.Tailnet, 3.0, zoom = 2.0))
        assertEquals(options(45, 5, 1206, 2622, 1.1), options(EndpointKind.Tailnet, null, zoom = 1.1))
        // At 100%: what was asked before the zoom.
        assertEquals(options(70, 15, 1206, 2622, 3.0), options(EndpointKind.Lan, null, zoom = 1.0))
        assertEquals(options(60, 10, 1206, 2622, 2.0), options(EndpointKind.Tailnet, 12.0, zoom = 1.0))
        assertEquals(options(45, 5, 1206, 2622), options(EndpointKind.Tailnet, 3.0, zoom = 1.0))
        assertEquals(options(EndpointKind.Lan, null, zoom = 1.0), BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 3.0), "no zoom given: none")
        // Zoomed out, the tier's pixels a point times the factor too, while that is a frame pixel a CSS pixel or more
        // (review, 2026-10-03: asking the tier's own scale there, a page at 50% came at the whole screen's pixels on a
        // fair link, 2.25 times the tier's). The screen's pixels still bound the frame.
        assertEquals(options(70, 15, 1206, 2622, 1.52), options(EndpointKind.Lan, null, zoom = 0.5))
        assertEquals(options(EndpointKind.Lan, null, zoom = 0.5), options(EndpointKind.Tailnet, 40.0, zoom = 0.5), "a fast link as the local network")
        assertEquals("2.72", options(EndpointKind.Lan, null, zoom = 0.9).query.last().value)
        assertEquals("1.8", options(EndpointKind.Tailnet, 12.0, zoom = 0.9).query.last().value)
        assertEquals("1.34", options(EndpointKind.Tailnet, 12.0, zoom = 0.67).query.last().value)
        assertEquals(1206, options(EndpointKind.Tailnet, 12.0, zoom = 0.9).maxWidth)
        assertEquals(options(60, 10, 1206, 2622), options(EndpointKind.Tailnet, 12.0, zoom = 0.5),
            "2 a point at 50%: a frame pixel a CSS pixel, no scale to ask, the screen's bound")
        // Past that (the product under 1) the Mac still draws the CSS size, more pixels than the tier's: there the
        // tier's own pixels bound the frame — the screen's points times the tier's pixels a point — and the
        // screencast makes it that small.
        for (zoom in listOf(0.33, 0.25)) {
            assertEquals(options(70, 15, 1206, 2622), options(EndpointKind.Lan, null, zoom = zoom), "3 a point: the screen's own, $zoom")
            assertEquals(options(70, 15, 1206, 2622), options(EndpointKind.Tailnet, 40.0, zoom = zoom), "$zoom")
            assertEquals(options(60, 10, 804, 1748), options(EndpointKind.Tailnet, 12.0, zoom = zoom), "2 a point of 402 × 874, $zoom")
        }
        for (zoom in listOf(0.9, 0.8, 0.75, 0.67, 0.5, 0.33, 0.25)) {
            assertEquals(options(45, 5, 402, 874), options(EndpointKind.Tailnet, 3.0, zoom = zoom), "1 a point: the screen's points, $zoom")
            assertEquals(options(EndpointKind.Tailnet, 3.0, zoom = zoom), options(EndpointKind.Tailnet, null, zoom = zoom), "not measured: the slow way, $zoom")
        }
        assertEquals(8.0, options(EndpointKind.Lan, null, zoom = 5.0).scale, "never more than the Mac takes")
        // A 2× screen on a fair link is at its own scale: its own pixels bound a page zoomed out past them, and meet
        // the little more it asks of a zoomed page.
        val small = Size(750.0, 1334.0)
        assertEquals(options(60, 10, 750, 1334, 3.02), BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 12.0, screenPixels = small, screenScale = 2.0, zoom = 1.5))
        assertEquals(options(60, 10, 750, 1334), BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 12.0, screenPixels = small, screenScale = 2.0, zoom = 0.25))
        assertEquals(options(45, 5, 375, 667), BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 3.0, screenPixels = small, screenScale = 2.0, zoom = 0.25))
        // A 1× screen asks for no scale and no bound at 100%, as before; for the factor of a page zoomed in; and zoomed
        // out its pixels bound the frame.
        assertEquals(options(70, 15, 1206, 2622, 2.02), BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 1.0, zoom = 2.0))
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 1.0, zoom = 1.0))
        assertEquals(options(70, 15, 1206, 2622), BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 1.0, zoom = 0.5))
        // Without the screen known: as before, whatever the zoom (the slow way's bound is then the pixels it was given).
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, zoom = 2.0))
        assertEquals(BrowserStreamPolicy.local, BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, zoom = 0.25))
        assertEquals(BrowserStreamPolicy.fair, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 12.0, screenPixels = pixels, zoom = 0.25))
        assertEquals(BrowserStreamPolicy.slow, BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 3.0, zoom = 0.5))
        assertEquals(options(45, 5, 1206, 2622), BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 3.0, screenPixels = pixels, zoom = 0.5))
    }

    // MARK: the frames the Mac then sends

    /**
     * The Mac's own arithmetic for one stream (packages/daemon/src/browser/screencast.ts renderScale and viewAt; the
     * view's limits, 4096 a side and 3840 × 2400 in all, are far from a phone): the view is drawn at what the stream
     * asks, as far as its bound holds that many pixels, to a thousandth and never under 1; a view larger than the
     * bound (the CSS size of a page zoomed far out) is made smaller by the screencast.
     */
    private fun frame(page: BrowserViewport, ask: BrowserStreamOptions): Size {
        val bounds = listOfNotNull(ask.maxWidth?.let { it.toDouble() / page.width }, ask.maxHeight?.let { it.toDouble() / page.height })
        val fits = (listOf(ask.scale ?: 1.0) + bounds).min()
        val scale = maxOf(1.0, Math.floor(fits * 1000 + 1e-9) / 1000)
        val view = Size((page.width * scale).roundedHalfAwayForTest(), (page.height * scale).roundedHalfAwayForTest())
        val smaller = (listOf(1.0) + listOfNotNull(ask.maxWidth?.let { it.toDouble() / view.width }, ask.maxHeight?.let { it.toDouble() / view.height })).min()
        return Size((view.width * smaller).roundedHalfAwayForTest(), (view.height * smaller).roundedHalfAwayForTest())
    }

    private fun Double.roundedHalfAwayForTest(): Double = if (this < 0) -Math.floor(-this + 0.5) else Math.floor(this + 0.5)

    /**
     * Why a fiftieth more (review, 2026-10-03): the page's sides are whole CSS pixels, up to half a pixel off the
     * area over the factor, so at the product itself the view could come a pixel or two narrower than the screen
     * (365 at 3.3 is 1204.5: 1205 for 1206) and be stretched across it. Asked a little more, the stream's bound — the
     * screen's own pixels — settles the view: 1206 / 365 is 3.304, the frame 1206. Zoomed out the same: 433 at 2.7
     * (90% on a 390 pt phone) is 1169 for 1170.
     */
    @Test
    fun testAPageZoomedInComesExactlyAsWideAsTheScreen() {
        assertEquals(1169.0, frame(BrowserViewport(width = 433.0, height = 733.0), options(70, 15, 1170, 2532, 2.7)).width, "zoomed out, at the product itself")
        assertEquals(1170.0, frame(BrowserViewport(width = 433.0, height = 733.0), options(70, 15, 1170, 2532, 2.72)).width)
        assertEquals(1205.0, frame(BrowserViewport(width = 365.0, height = 627.0), options(70, 15, 1206, 2622, 3.3)).width, "at the product itself")
        assertEquals(Size(1206.0, 2072.0), frame(BrowserViewport(width = 365.0, height = 627.0), options(70, 15, 1206, 2622, 3.32)))
        // Every iPhone width at 3×, the screen area what the page's bars leave (690 of 874 pt on the 402 pt phone).
        for (screen in listOf(Size(375.0, 812.0), Size(390.0, 844.0), Size(393.0, 852.0), Size(402.0, 874.0), Size(430.0, 932.0), Size(440.0, 956.0))) {
            val pixels = Size(screen.width * 3, screen.height * 3)
            val area = Size(screen.width, screen.height - 184)
            val zoomedIn = BrowserPageZoom.usable(area).filter { it > 100 }
            assertTrue(zoomedIn.size >= 4, "${screen.width}")
            for (percent in zoomedIn) {
                val page = BrowserPageZoom.viewport(area = area, screenScale = 3.0, percent = percent)
                val ask = BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = pixels, screenScale = 3.0, zoom = BrowserPageZoom.factor(percent))
                assertEquals(pixels.width, frame(page, ask).width, "${screen.width.toInt()} pt at $percent%")
            }
        }
    }

    /**
     * What the tiers' own bound is for (review, 2026-10-03): a 402 × 690 pt area at 3× on a fair link got the whole
     * screen's 1206 × 2070 at 50% and under, 2.25 times the tier's pixels; on a slow one up to 9 times.
     */
    @Test
    fun testAPageZoomedOutComesNoLargerThanTheTiersPixels() {
        val pixels = Size(1206.0, 2622.0)
        val area = Size(402.0, 690.0)
        fun sent(kind: EndpointKind, mbps: Double?, percent: Int): Size {
            val page = BrowserPageZoom.viewport(area = area, screenScale = 3.0, percent = percent)
            return frame(page, BrowserStreamPolicy.options(kind = kind, mbps = mbps, screenPixels = pixels, screenScale = 3.0, zoom = BrowserPageZoom.factor(percent)))
        }
        val out = BrowserPageZoom.usable(area).filter { it < 100 }
        assertEquals(listOf(25, 33, 50, 67, 75, 80, 90), out)
        // A fair link: the tier's 804 × 1380 at every one of them, to the page's rounding.
        assertEquals(Size(804.0, 1380.0), sent(EndpointKind.Tailnet, 12.0, 50))
        assertEquals(Size(804.0, 1380.0), sent(EndpointKind.Tailnet, 12.0, 25))
        for (percent in out) {
            assertNear(804.0, sent(EndpointKind.Tailnet, 12.0, percent).width, 1.0, "$percent%")
            assertNear(1380.0, sent(EndpointKind.Tailnet, 12.0, percent).height, 1.0, "$percent%")
            // A slow one: the screen's points.
            assertEquals(402.0, sent(EndpointKind.Tailnet, 3.0, percent).width, "$percent%")
            assertNear(690.0, sent(EndpointKind.Tailnet, 3.0, percent).height, 1.0, "$percent%")
        }
        // The local network: the frames the screen's own scale and bound gave before, at every one.
        for (percent in out + 100) {
            val before = options(70, 15, 1206, 2622, 3.0)
            assertEquals(frame(BrowserPageZoom.viewport(area = area, screenScale = 3.0, percent = percent), before), sent(EndpointKind.Lan, null, percent), "$percent%")
            assertEquals(1206.0, sent(EndpointKind.Lan, null, percent).width, "$percent%")
        }
    }

    /** What the Mac is sent for a page at 67% on a 3× phone: the size on its viewport route, the scale on the stream. */
    @Test
    fun testTheMacIsSentTheZoomedSizeAndAsksItsStreamAtTheZoom() = runTest {
        val tab = """{"tab":{"id":"a1"}}"""
        val transport = FakeTransport({ req, _ -> tab.toByteArray() to httpResponse(req.url) },
            streamHandler = { req, _ -> Triple(httpResponse(req.url, status = 404), listOf("""{"error":"not found"}""".toByteArray()), null) })
        val api = AgentSwitchAPI(endpoints = FixedEndpoint(APIEndpoint(host = "192.168.1.5", port = 4713, kind = EndpointKind.Lan)), transport = transport, token = "tok")
        val page = BrowserPageZoom.viewport(area = phone, screenScale = 3.0, percent = 67)
        api.setBrowserViewport("a1", width = page.width.toInt(), height = page.height.toInt(), scale = page.scale, mobile = page.mobile, screen = "phone-1")
        val sent = assertNotNull(transport.requests.firstOrNull()?.jsonBody)
        assertEquals(KitJson.parseToJsonElement("""{"width":600,"height":1045,"scale":2.01,"mobile":true,"screen":"phone-1"}""") as JsonObject, sent)
        val options = BrowserStreamPolicy.options(kind = EndpointKind.Lan, mbps = null, screenPixels = Size(1206.0, 2622.0), screenScale = 3.0, zoom = 1.5)
        api.browserEvents("a1", options = options).collect { }
        assertEquals("quality=70&fps=15&maxWidth=1206&maxHeight=2622&scale=4.52", transport.requests.last().query)
        // Zoomed out past the tier's pixels on a fair link: no scale, the tier's own bound.
        val far = BrowserStreamPolicy.options(kind = EndpointKind.Tailnet, mbps = 12.0, screenPixels = Size(1206.0, 2622.0), screenScale = 3.0, zoom = 0.25)
        api.browserEvents("a1", options = far).collect { }
        assertEquals("quality=60&fps=10&maxWidth=804&maxHeight=1748", transport.requests.last().query)
    }

    // MARK: the picture and input

    /**
     * The picture of a page this phone sized is the area again at every zoom (across the width exactly, the height to
     * the whole pixels of the page's size), and a touch maps to the frame pixel under the finger.
     */
    @Test
    fun testThePictureFillsTheAreaAndATouchLandsUnderTheFingerAtEveryZoom() {
        for (area in listOf(phone, Size(393.0, 660.0), Size(375.0, 548.0), Size(440.0, 743.0))) {
            for (percent in BrowserPageZoom.usable(area)) {
                val page = BrowserPageZoom.viewport(area = area, screenScale = 3.0, percent = percent)
                // The Mac draws the view at some pixels a CSS pixel: the frame is the page's size times that.
                for (density in listOf(1.0, 1.5, 3.0)) {
                    val frame = Size(page.width * density, page.height * density)
                    val layout = BrowserLayout(frame = frame, area = area, fillWidth = true)
                    assertNear(0.0, layout.picture.minX, 0.001, "$percent%")
                    assertEquals(0.0, layout.picture.minY, "$percent%")
                    assertNear(area.width, layout.picture.width, 0.001, "$percent%")
                    assertNear(area.height, layout.picture.height, area.height * 0.005, "$percent% of $area")
                    // A finger a third across and two thirds down the picture is on that pixel of the frame: the CSS
                    // pixel the Mac divides it down to is the same part of the page.
                    val at = assertNotNull(layout.framePoint(Point(area.width / 3, layout.picture.height * 2 / 3)))
                    assertNear(page.width / 3, at.x / density, 0.001, "$percent%")
                    assertNear(page.height * 2 / 3, at.y / density, 0.001, "$percent%")
                }
            }
        }
    }

    // MARK: remembered by site

    @Test
    fun testTheZoomIsRememberedBySite() {
        val none = BrowserZoomMemory()
        assertNull(none.percent(forSite = "github.com"))
        val one = none.setting(50, forSite = "github.com")
        assertEquals(emptyList(), none.sites, "a new value: the old one is as it was")
        assertEquals(50, one.percent(forSite = "github.com"))
        assertNull(one.percent(forSite = "gist.github.com"), "another host is another site")
        // The site set last comes first; a site is kept once.
        val three = one.setting(150, forSite = "localhost:5173").setting(125, forSite = "~/Projects/x/index.html").setting(67, forSite = "github.com")
        assertEquals(listOf(BrowserZoomMemory.Entry(site = "github.com", percent = 67), BrowserZoomMemory.Entry(site = "~/Projects/x/index.html", percent = 125),
            BrowserZoomMemory.Entry(site = "localhost:5173", percent = 150)), three.sites)
        // 100% forgets the site.
        val back = three.setting(100, forSite = "github.com")
        assertNull(back.percent(forSite = "github.com"))
        assertEquals(listOf("~/Projects/x/index.html", "localhost:5173"), back.sites.map { it.site })
        assertEquals(back, back.setting(100, forSite = "never.example"), "nothing to forget")
        // A blank tab is never kept.
        assertEquals(three, three.setting(150, forSite = ""))
        assertEquals(three, three.setting(150, forSite = "about:blank"))
        assertNull(three.percent(forSite = ""))
        // Nor a percent no screen could use.
        assertEquals(three, three.setting(0, forSite = "x.example"))
        assertEquals(three, three.setting(5000, forSite = "x.example"))
    }

    @Test
    fun testTheMemoryKeepsTheSitesSetLast() {
        val full = (0 until BrowserZoomMemory.limit).fold(BrowserZoomMemory()) { acc, i -> acc.setting(50, forSite = "site$i.example") }
        assertEquals(200, BrowserZoomMemory.limit)
        assertEquals(200, full.sites.size)
        assertEquals("site199.example", full.sites.firstOrNull()?.site)
        // One more: the one set longest ago goes.
        val more = full.setting(125, forSite = "new.example")
        assertEquals(200, more.sites.size)
        assertEquals(BrowserZoomMemory.Entry(site = "new.example", percent = 125), more.sites.firstOrNull())
        assertNull(more.percent(forSite = "site0.example"))
        assertEquals(50, more.percent(forSite = "site1.example"))
        // Setting an old one again keeps it: it is the newest now.
        val again = full.setting(75, forSite = "site0.example").setting(125, forSite = "new.example")
        assertEquals(75, again.percent(forSite = "site0.example"))
        assertNull(again.percent(forSite = "site1.example"))
    }

    @Test
    fun testTheMemoryIsKeptAsJSONAndReadAsItIsKept() {
        val memory = BrowserZoomMemory().setting(50, forSite = "github.com").setting(150, forSite = "localhost:5173")
        val data = KitJson.encodeToString(BrowserZoomMemory.serializer(), memory)
        assertEquals(KitJson.parseToJsonElement("""{"sites":[{"site":"localhost:5173","percent":150},{"site":"github.com","percent":50}]}"""), KitJson.parseToJsonElement(data))
        assertEquals(memory, KitJson.decodeFromString(BrowserZoomMemory.serializer(), data))
        // What this version would not have written is not read: a site twice (its first counts), a blank one, 100%, a
        // percent outside the steps, more than it keeps.
        val odd = """{"sites":[{"site":"a.example","percent":50},{"site":"a.example","percent":75},{"site":"","percent":50},""" +
            """{"site":"b.example","percent":100},{"site":"c.example","percent":-9223372036854775808},{"site":"d.example","percent":200}]}"""
        assertEquals(listOf(BrowserZoomMemory.Entry(site = "a.example", percent = 50), BrowserZoomMemory.Entry(site = "d.example", percent = 200)),
            KitJson.decodeFromString(BrowserZoomMemory.serializer(), odd).sites)
        val over = """{"sites":[""" + (0 until 300).joinToString(",") { """{"site":"s$it.example","percent":50}""" } + "]}"
        val kept = KitJson.decodeFromString(BrowserZoomMemory.serializer(), over)
        assertEquals(200, kept.sites.size)
        assertEquals("s199.example", kept.sites.lastOrNull()?.site, "the first of them: the ones set last")
        // Something else under the key is not read at all (the app then starts with nothing remembered).
        assertFailsWith<SerializationException> { KitJson.decodeFromString(BrowserZoomMemory.serializer(), """{"sites":[{"site":"a.example","percent":"50"}]}""") }
        assertFailsWith<SerializationException> { KitJson.decodeFromString(BrowserZoomMemory.serializer(), "[]") }
    }

    // MARK: the picture's own steps

    /** While the phone only watches a tab the zoom key steps the picture, as two fingers would. */
    @Test
    fun testTheZoomKeyStepsThePictureWhileOnlyWatching() {
        assertEquals(listOf(1.0, 1.25, 1.5, 2.0, 3.0, 4.0), BrowserZoom.steps)
        assertEquals(100, BrowserZoom.none.percent)
        assertEquals(125, BrowserZoom(scale = 1.25).percent)
        assertEquals(237, BrowserZoom(scale = 2.368).percent)
        assertEquals(1.25, BrowserZoom.none.stepIn)
        assertNull(BrowserZoom.none.stepOut)
        assertEquals(3.0, BrowserZoom(scale = 2.0).stepIn)
        assertEquals(1.5, BrowserZoom(scale = 2.0).stepOut)
        assertNull(BrowserZoom(scale = 4.0).stepIn)
        assertEquals(3.0, BrowserZoom(scale = 4.0).stepOut)
        // A pinch stops anywhere between the steps.
        assertEquals(1.5, BrowserZoom(scale = 1.37).stepIn)
        assertEquals(1.25, BrowserZoom(scale = 1.37).stepOut)
        assertEquals(1.5, BrowserZoom(scale = 1.2500004).stepIn, "a step itself, to the rounding")
        assertEquals(1.0, BrowserZoom(scale = 1.2500004).stepOut)
    }

    /**
     * The chip at the picture's top right says the scale to one decimal, wherever two fingers left it; a step of the
     * zoom key that has hundredths is written in full (review, 2026-10-03: to one decimal the 125% step read `1.2×`
     * beside a key and a row saying `125%`; the demo page writes `1.25×`).
     */
    @Test
    fun testTheChipWritesTheScaleAndAKeyStepInFull() {
        assertEquals(listOf("1.0×", "1.25×", "1.5×", "2.0×", "3.0×", "4.0×"), BrowserZoom.steps.map { BrowserZoom(scale = it).times })
        // Stepped to by the key from wherever a pinch stopped.
        assertEquals("1.25×", BrowserZoom(scale = 1.1).stepped(1.25, picture = Rect(0.0, 0.0, 402.0, 251.25), area = phone).times)
        // What a pinch leaves: one decimal, as before.
        assertEquals("1.4×", BrowserZoom(scale = 1.37).times)
        assertEquals("1.2×", BrowserZoom(scale = 1.2).times)
        assertEquals("1.3×", BrowserZoom(scale = 1.27).times)
        assertEquals("2.4×", BrowserZoom(scale = 2.368).times)
        assertEquals("4.0×", BrowserZoom(scale = 3.96).times)
        // A step itself, to the rounding (as the steps in and out take it).
        assertEquals("1.25×", BrowserZoom(scale = 1.2500004).times)
        assertEquals("1.5×", BrowserZoom(scale = 1.5000004).times)
    }

    /**
     * A desktop page watched sits at the top of the area, shorter than it: stepping in, it grows downwards about its
     * middle, its top edge staying where it is.
     */
    @Test
    fun testAPictureShorterThanTheAreaKeepsItsTopEdge() {
        // Where a 1280 × 800 page is drawn in the phone's area (BrowserLayout: fitted to the width, its top at the top).
        val picture = Rect(0.0, 0.0, 402.0, 251.25)
        assertEquals(picture.height, BrowserLayout(frame = Size(1280.0, 800.0), area = phone).picture.height, 0.001)
        val first = BrowserZoom.none.stepped(1.25, picture = picture, area = phone)
        assertEquals(BrowserZoom(scale = 1.25, offset = Point(-50.25, 0.0)), first, "about the middle of the width, the top where it was")
        val second = first.stepped(1.5, picture = picture, area = phone)
        assertEquals(BrowserZoom(scale = 1.5, offset = Point(-100.5, 0.0)), second)
        val third = second.stepped(2.0, picture = picture, area = phone)
        assertEquals(BrowserZoom(scale = 2.0, offset = Point(-201.0, 0.0)), third)
        // And back out the same way, to the whole picture.
        assertEquals(second, third.stepped(1.5, picture = picture, area = phone))
        assertEquals(BrowserZoom.none, first.stepped(1.0, picture = picture, area = phone))
        // A pinch had moved its top out of sight: a step brings it back while there is room under the picture.
        val pinched = BrowserZoom.none.pinched(1.6, around = Point(200.0, 100.0), area = phone)
        assertEquals(-60.0, pinched.offset.y, 0.001)
        assertEquals(0.0, pinched.stepped(2.0, picture = picture, area = phone).offset.y)
    }

    /** Taller than the area, the picture is zoomed about the middle of what is in view and keeps covering the area. */
    @Test
    fun testAPictureTallerThanTheAreaIsSteppedAboutTheMiddleOfWhatIsSeen() {
        val picture = Rect(0.0, 0.0, 402.0, 251.25)
        // 2× is 502.5 high, 3× 753.75: its middle stays, then it is moved to cover the area's height.
        val two = BrowserZoom(scale = 2.0, offset = Point(-201.0, 0.0))
        val three = two.stepped(3.0, picture = picture, area = phone)
        assertEquals(3.0, three.scale)
        assertEquals(-402.0, three.offset.x, 0.001)
        assertEquals(700 - 753.75, three.offset.y, 0.001, "no band left under it while its top is out of sight")
        // In view: the whole area. 4× about its middle.
        val four = three.stepped(4.0, picture = picture, area = phone)
        val middle = Point(201.0, 350.0)
        assertEquals(three.invert(middle).x, four.invert(middle).x, 0.001)
        assertEquals(three.invert(middle).y, four.invert(middle).y, 0.001)
        assertEquals(three.offset.y, four.stepped(3.0, picture = picture, area = phone).offset.y, 0.001)
        assertEquals(4.0, four.stepped(9.0, picture = picture, area = phone).scale, "within the picture's range")
        // A picture as large as the area (a page at the phone's size, pinched): about the middle of the area.
        val whole = Rect(Point.zero, phone)
        val zoomed = BrowserZoom.none.stepped(2.0, picture = whole, area = phone)
        assertEquals(BrowserZoom(scale = 2.0, offset = Point(-201.0, -350.0)), zoomed)
        // The middle of what is seen of the picture is not the middle of the area: a picture 600 high in the 700 of
        // the area, stepped to twice its size (taller than the area then), is zoomed about its own middle, (201, 300)
        // — about the area's, (201, 350), it would sit 50 pt higher (review, 2026-10-03: every other case here has
        // the two middles equal, or is settled by the top edge or the band under the picture).
        val shorter = Rect(0.0, 0.0, 402.0, 600.0)
        assertEquals(BrowserZoom(scale = 2.0, offset = Point(-201.0, -300.0)), BrowserZoom.none.stepped(2.0, picture = shorter, area = phone))
        // Nothing drawn yet: the middle of the area.
        assertEquals(2.0, BrowserZoom.none.stepped(2.0, picture = Rect.zero, area = phone).scale)
    }
}
