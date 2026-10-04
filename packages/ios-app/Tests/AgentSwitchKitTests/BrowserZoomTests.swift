import XCTest
@testable import AgentSwitchKit

/// The page's own zoom on the phone (docs/browser-v0.md §1, 2026-10-03 页面缩放): the steps a screen can use, the size it
/// sets at one, what the stream asks for, what the phone remembers by site — and the picture's own steps, for the same
/// key while the phone only watches a tab.
final class BrowserZoomTests: XCTestCase {
    /// An iPhone's screen area in points, at 3 pixels a point.
    private let phone = CGSize(width: 402, height: 700)

    // MARK: the page's size

    func testThePageIsTheAreaOverTheFactorAtThePixelRatioTimesIt() {
        XCTAssertEqual(BrowserPageZoom.steps, [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500])
        XCTAssertEqual(BrowserPageZoom.factor(67), 0.67)
        // 100%: as before the zoom — the area in points, the screen's pixel ratio, a phone's layout.
        XCTAssertEqual(BrowserPageZoom.viewport(area: phone, screenScale: 3, percent: 100), BrowserViewport(width: 402, height: 700, scale: 3, mobile: true))
        // 50%: the page sees an 804 px window (room for a page made for a desktop), drawn at half the pixels a CSS pixel.
        XCTAssertEqual(BrowserPageZoom.viewport(area: phone, screenScale: 3, percent: 50), BrowserViewport(width: 804, height: 1400, scale: 1.5, mobile: true))
        XCTAssertEqual(BrowserPageZoom.viewport(area: phone, screenScale: 3, percent: 67), BrowserViewport(width: 600, height: 1045, scale: 2.01, mobile: true))
        // The pixel ratio stays within what the Mac takes (0.5–4).
        XCTAssertEqual(BrowserPageZoom.viewport(area: phone, screenScale: 3, percent: 150), BrowserViewport(width: 268, height: 467, scale: 4, mobile: true))
        XCTAssertEqual(BrowserPageZoom.viewport(area: phone, screenScale: 1, percent: 25), BrowserViewport(width: 1608, height: 2800, scale: 0.5, mobile: true))
        // A screen area is not always whole points: the page is whole pixels.
        XCTAssertEqual(BrowserPageZoom.viewport(area: CGSize(width: 393, height: 659.67), screenScale: 3, percent: 80),
                       BrowserViewport(width: 491, height: 825, scale: 2.4, mobile: true))
        XCTAssertEqual(BrowserPageZoom.viewport(area: CGSize(width: 990, height: 721), screenScale: 2, percent: 100, mobile: false),
                       BrowserViewport(width: 990, height: 721, scale: 2))
        // Never a size that cannot be sent: a percent that is none counts as 100.
        XCTAssertEqual(BrowserPageZoom.viewport(area: phone, screenScale: 3, percent: 0).width, 402)
        XCTAssertEqual(BrowserPageZoom.viewport(area: CGSize(width: Double.nan, height: 700), screenScale: 3, percent: 100).width, 0)
    }

    func testAScreenUsesTheStepsThatKeepThePageWithinWhatTheMacTakes() {
        // The viewport route takes 200–4096 a side: a phone about 25% to 200%.
        XCTAssertEqual(BrowserPageZoom.usable(in: phone), [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200])
        // 375 wide: at 200% the page would be 188 wide.
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 375, height: 560)).last, 175)
        // A Mac's window, for the same rule: 1280 at 25% is 5120 wide, 721 at 400% is 180 high.
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 1280, height: 721)), [33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300])
        XCTAssertEqual(BrowserPageZoom.usable(in: .zero), [], "no area yet")
    }

    /// The page stays within what the Mac draws of a view in all (3840 × 2400, §5): zoomed out it is drawn at its CSS
    /// size whatever that is, so a step whose sides both fit can still be too much (review, 2026-10-03; the Mac's
    /// BrowserPageZoom.pagePixels is the same rule).
    func testAScreenUsesNoStepThatMakesThePageMoreThanTheMacDraws() {
        XCTAssertEqual(BrowserPageZoom.pagePixels, 3840 * 2400)
        // The Mac's main window: 25% would be 3780 × 2904 — each side within 4096, 11 million pixels in all.
        let window = CGSize(width: 945, height: 726)
        let sides = BrowserPageZoom.viewport(area: window, screenScale: 2, percent: 25, mobile: false)
        XCTAssertEqual(CGSize(width: sides.width, height: sides.height), CGSize(width: 3780, height: 2904))
        XCTAssertTrue(BrowserPageZoom.sides.contains(3780) && BrowserPageZoom.sides.contains(2904), "the sides fit")
        XCTAssertEqual(BrowserPageZoom.usable(in: window), [33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300])
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 25, area: window), 33)
        XCTAssertNil(BrowserPageZoom.stepOut(from: 33, site: "github.com", area: window))
        // The bound itself: as many pixels as the Mac draws are still a step, one column more is not.
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 800, height: 600)).first, 25, "3200 × 2400")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 960, height: 600)).first, 25, "3840 × 2400: just within it")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 961, height: 600)).first, 33, "3844 × 2400: a column past it")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 1024, height: 900)).first, 33, "4096 × 3600 at 25%")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 2048, height: 1200)).first, 67, "4096 × 2400 at 50%")
        // A phone is far from it: 1608 × 2800 at 25%, 4.5 million.
        XCTAssertEqual(BrowserPageZoom.usable(in: phone).first, 25)
    }

    func testTheStepInForceIsTheUsableOneNearestToWhatIsRemembered() {
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: nil, area: phone), 100, "a site not zoomed")
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 50, area: phone), 50)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 200, area: phone), 200)
        // The area does not allow what is remembered: the nearest step that it does.
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 300, area: phone), 200)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 200, area: CGSize(width: 375, height: 560)), 175)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 25, area: CGSize(width: 1280, height: 721)), 33)
        // A tie goes toward 100%.
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 95, area: phone), 100)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 105, area: phone), 100)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 85, area: phone), 90)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 71, area: phone), 75)
        // Before the area is known: what is remembered, as a step.
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 150, area: .zero), 150)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: nil, area: .zero), 100)
        // Whatever was kept is read without a trap.
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: .max, area: phone), 200)
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: .min, area: phone), 25)
    }

    func testZoomingInAndOutGoesToTheNextUsableStep() {
        let site = "github.com"
        XCTAssertEqual(BrowserPageZoom.stepIn(from: 100, site: site, area: phone), 110)
        XCTAssertEqual(BrowserPageZoom.stepOut(from: 100, site: site, area: phone), 90)
        XCTAssertEqual(BrowserPageZoom.stepIn(from: 175, site: site, area: phone), 200)
        XCTAssertNil(BrowserPageZoom.stepIn(from: 200, site: site, area: phone), "the end of the phone's range")
        XCTAssertNil(BrowserPageZoom.stepOut(from: 25, site: site, area: phone))
        XCTAssertEqual(BrowserPageZoom.stepOut(from: 33, site: site, area: phone), 25)
        XCTAssertNil(BrowserPageZoom.stepIn(from: 175, site: site, area: CGSize(width: 375, height: 560)))
        XCTAssertNil(BrowserPageZoom.stepOut(from: 33, site: site, area: CGSize(width: 1280, height: 721)))
        // From a percent that is no step (never in force, but asked for all the same).
        XCTAssertEqual(BrowserPageZoom.stepIn(from: 95, site: site, area: phone), 100)
        XCTAssertEqual(BrowserPageZoom.stepOut(from: 95, site: site, area: phone), 90)
        XCTAssertNil(BrowserPageZoom.stepIn(from: 100, site: site, area: .zero), "no area yet")
        XCTAssertNil(BrowserPageZoom.stepOut(from: 100, site: site, area: .zero))
    }

    /// A blank tab is never zoomed and never remembered.
    func testABlankTabHasNoZoom() {
        XCTAssertTrue(BrowserPageZoom.isBlank(""))
        XCTAssertTrue(BrowserPageZoom.isBlank("  "))
        XCTAssertTrue(BrowserPageZoom.isBlank("about:blank"))
        XCTAssertFalse(BrowserPageZoom.isBlank("github.com"))
        XCTAssertFalse(BrowserPageZoom.isBlank("localhost:5173"))
        XCTAssertFalse(BrowserPageZoom.isBlank("~/Projects/x/index.html"))
        // Always at 100%: no step in or out, where a site, a local server or a file has both.
        for blank in ["", "  ", "about:blank"] {
            XCTAssertNil(BrowserPageZoom.stepIn(from: 100, site: blank, area: phone), "'\(blank)'")
            XCTAssertNil(BrowserPageZoom.stepOut(from: 100, site: blank, area: phone), "'\(blank)'")
            XCTAssertEqual(BrowserPageZoom.inForce(remembered: BrowserZoomMemory().setting(150, for: blank).percent(for: blank), area: phone), 100, "'\(blank)'")
        }
        for site in ["github.com", "localhost:5173", "~/Projects/x/index.html"] {
            XCTAssertEqual(BrowserPageZoom.stepIn(from: 100, site: site, area: phone), 110, site)
            XCTAssertEqual(BrowserPageZoom.stepOut(from: 100, site: site, area: phone), 90, site)
        }
    }

    /// What takes part of the screen area after the size was set — a keyboard, a note, the zoom row itself — neither
    /// shrinks the page nor moves the steps it can use.
    func testThePageKeepsTheAreaItWasSizedFor() {
        // No size set yet: the area, in whole points.
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: phone, sent: nil), phone)
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 393.4, height: 659.67), sent: nil), CGSize(width: 393, height: 660))
        // The zoom row (46 pt), then a keyboard, over the area: as high as the page was sized.
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 402, height: 654), sent: phone), phone)
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 402, height: 364), sent: phone), phone)
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 401.7, height: 653.5), sent: phone), phone, "the same width in whole points")
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: phone, sent: phone), phone)
        // More height: the page follows.
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 402, height: 734.2), sent: phone), CGSize(width: 402, height: 734))
        // Another width (the phone turned): the area as it is now, lower or not.
        let turned = CGSize(width: 874, height: 320)
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: turned, sent: phone), turned)
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: phone, sent: turned), phone)
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 403, height: 654), sent: phone), CGSize(width: 403, height: 654))
        // So a keyboard coming up over a page at 200% changes nothing: by the area left above it the page would be 182
        // high, under what the Mac takes — the step in force would fall to 175% and the page be laid out again.
        let typing = CGSize(width: 402, height: 364)
        XCTAssertEqual(BrowserPageZoom.usable(in: typing).last, 175, "what the area left alone would allow")
        let sized = BrowserPageZoom.sizedArea(now: typing, sent: phone)
        XCTAssertEqual(BrowserPageZoom.usable(in: sized), BrowserPageZoom.usable(in: phone))
        XCTAssertEqual(BrowserPageZoom.inForce(remembered: 200, area: sized), 200)
        XCTAssertEqual(BrowserPageZoom.stepOut(from: 200, site: "github.com", area: sized), 175)
        XCTAssertEqual(BrowserPageZoom.viewport(area: sized, screenScale: 3, percent: 200), BrowserViewport(width: 201, height: 350, scale: 4, mobile: true))
    }

    /// Not every area a page is given is room it has: a page just opened is laid out in passes, the first before its
    /// bars are. Only an area that stood counts (the simulator's numbers, iPhone 18 Pro, 2026-10-03).
    func testOnlyAnAreaThatStoodIsRoomThePageHas() {
        XCTAssertEqual(BrowserPageZoom.settle, .milliseconds(300))
        func room(_ before: CGSize?, _ areas: [(height: Double, stood: Duration)]) -> CGSize? {
            areas.reduce(before) { BrowserPageZoom.roomiest($0, after: CGSize(width: 402, height: $1.height), stood: $1.stood) }
        }
        // Opening: 800 high for 0.06 s (no bars yet), 601 for 0.09 s (the tab bar still there), then its 650.
        let opened = room(nil, [(800, .milliseconds(60)), (601, .milliseconds(90))])
        XCTAssertNil(opened, "passing areas are no room")
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 402, height: 650), sent: opened), CGSize(width: 402, height: 650))
        // The zoom row opens a second and a half later: the 650 stood, and is the room from then on — under the row
        // (604.33), the key bar and the keyboard (337.33), a note.
        let stood = room(opened, [(650, .milliseconds(1500))])
        XCTAssertEqual(stood, CGSize(width: 402, height: 650))
        let covered = room(stood, [(604.33, .seconds(2)), (650, .seconds(1)), (604.33, .milliseconds(355)), (337.33, .seconds(8)), (620, .seconds(4))])
        XCTAssertEqual(covered, CGSize(width: 402, height: 650), "what takes of the area never lowers it")
        XCTAssertEqual(BrowserPageZoom.sizedArea(now: CGSize(width: 402, height: 337.33), sent: covered), CGSize(width: 402, height: 650))
        // A passing area later on is none either, however tall.
        XCTAssertEqual(room(covered, [(800, .milliseconds(120))]), covered)
        // Just long enough counts; more room that stood is the room.
        XCTAssertEqual(room(nil, [(650, .milliseconds(299))]), nil)
        XCTAssertEqual(room(nil, [(650, .milliseconds(300))]), CGSize(width: 402, height: 650))
        XCTAssertEqual(room(covered, [(700.4, .seconds(1))]), CGSize(width: 402, height: 700))
        // Another width (the phone turned): that area, lower or not.
        XCTAssertEqual(BrowserPageZoom.roomiest(covered, after: CGSize(width: 874, height: 320), stood: .seconds(3)), CGSize(width: 874, height: 320))
        // No area yet is none.
        XCTAssertNil(BrowserPageZoom.roomiest(nil, after: .zero, stood: .seconds(60)))
        XCTAssertEqual(BrowserPageZoom.roomiest(covered, after: .zero, stood: .seconds(60)), covered)
    }

    // MARK: the stream

    /// One rule at every zoom, as the Mac's (BrowserScreenPolicy.frameScale): what the screen shows a point at times
    /// the factor — and a fiftieth more where the stream's bound is the screen's own pixels, so that the bound settles
    /// the frame's width.
    func testTheStreamAsksForTheScreensPixelsOfThePageAtItsZoom() {
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 1), 3)
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 1), 2)
        // Zoomed out a CSS pixel is less than a point wide: fewer frame pixels of each, the frame no larger for it.
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0.9), 2.7, accuracy: 1e-9)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0.5), 1.5)
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 0.67), 1.34, accuracy: 1e-9)
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 0.5), 1)
        // Never under 1: the Mac draws the CSS size there, whatever is asked.
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0.33), 1)
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 0.25), 1)
        XCTAssertEqual(BrowserPageZoom.streamScale(1, factor: 0.9), 1)
        // Zoomed in, the product: at 200% a CSS pixel is two points, six pixels of a 3× screen.
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 2), 6)
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 1.75), 3.5)
        XCTAssertEqual(BrowserPageZoom.streamScale(1, factor: 1.1), 1.1)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 5), 8, "within what the Mac takes")
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0), 3, "no zoom at all is 100%")
        XCTAssertEqual(BrowserStreamOptions.maxScale, 8)
        // Where the stream's bound is the screen's own pixels at this scale (the local network, a fast link), a
        // fiftieth more at every zoom but 100%, in and out, for the bound to settle the frame's width.
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 2, met: true), 6.02)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 1.1, met: true), 3.32)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 1.25, met: true), 3.77)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0.9, met: true), 2.72)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0.5, met: true), 1.52)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 1, met: true), 3, "100%: the page is as wide as the area, to the point")
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 0.33, met: true), 1, "the CSS size: nothing to settle")
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 0.5, met: true), 1)
        XCTAssertEqual(BrowserPageZoom.streamScale(3, factor: 5, met: true), 8, "within what the Mac takes")
        XCTAssertEqual(BrowserPageZoom.streamScale(2, factor: 3.995, met: true), 8, "the fiftieth too")
        // What is sent is the ask to the hundredth, as it is.
        XCTAssertEqual(BrowserStreamOptions(quality: 70, fps: 15, scale: BrowserPageZoom.streamScale(3, factor: 2, met: true)).query.last?.value, "6.02")
        XCTAssertEqual(BrowserStreamOptions(quality: 70, fps: 15, scale: BrowserPageZoom.streamScale(3, factor: 1.1, met: true)).query.last?.value, "3.32")
        XCTAssertEqual(BrowserStreamOptions(quality: 70, fps: 15, scale: BrowserPageZoom.streamScale(3, factor: 0.9, met: true)).query.last?.value, "2.72")
        XCTAssertEqual(BrowserStreamOptions(quality: 70, fps: 15, scale: BrowserPageZoom.streamScale(3, factor: 0.9)).query.last?.value, "2.7")
        XCTAssertEqual(BrowserStreamOptions(quality: 70, fps: 15, scale: BrowserPageZoom.streamScale(3, factor: 0.67)).query.last?.value, "2.01")
    }

    func testEveryTierAsksAtTheZoom() {
        let pixels = CGSize(width: 1206, height: 2622)
        func options(_ kind: EndpointKind?, _ mbps: Double?, zoom: Double) -> BrowserStreamOptions {
            BrowserStreamPolicy.options(kind: kind, mbps: mbps, screenPixels: pixels, screenScale: 3, zoom: zoom)
        }
        // The local network and a fast link: the screen's pixels of the zoomed page.
        XCTAssertEqual(options(.lan, nil, zoom: 2), BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 6.02))
        XCTAssertEqual(options(.tailnet, 40, zoom: 1.5), BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 4.52))
        // A fair link: at most 2 a point, times the factor — the product itself: it shows fewer pixels than this
        // screen has, so no bound of its own meets a little more.
        XCTAssertEqual(options(.tailnet, 12, zoom: 2), BrowserStreamOptions(quality: 60, fps: 10, maxWidth: 1206, maxHeight: 2622, scale: 4))
        // A slow link asks for no scale at 100%; of a page zoomed in it asks for the factor, the same pixels as before.
        XCTAssertEqual(options(.tailnet, 3, zoom: 2), BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 1206, maxHeight: 2622, scale: 2))
        XCTAssertEqual(options(.tailnet, nil, zoom: 1.1), BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 1206, maxHeight: 2622, scale: 1.1))
        // At 100%: what was asked before the zoom.
        XCTAssertEqual(options(.lan, nil, zoom: 1), BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 3))
        XCTAssertEqual(options(.tailnet, 12, zoom: 1), BrowserStreamOptions(quality: 60, fps: 10, maxWidth: 1206, maxHeight: 2622, scale: 2))
        XCTAssertEqual(options(.tailnet, 3, zoom: 1), BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 1206, maxHeight: 2622))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, mbps: nil, screenPixels: pixels, screenScale: 3), options(.lan, nil, zoom: 1), "no zoom given: none")
        // Zoomed out, the tier's pixels a point times the factor too, while that is a frame pixel a CSS pixel or more
        // (review, 2026-10-03: asking the tier's own scale there, a page at 50% came at the whole screen's pixels on a
        // fair link, 2.25 times the tier's). The screen's pixels still bound the frame.
        XCTAssertEqual(options(.lan, nil, zoom: 0.5), BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 1.52))
        XCTAssertEqual(options(.tailnet, 40, zoom: 0.5), options(.lan, nil, zoom: 0.5), "a fast link as the local network")
        XCTAssertEqual(options(.lan, nil, zoom: 0.9).query.last?.value, "2.72")
        XCTAssertEqual(options(.tailnet, 12, zoom: 0.9).query.last?.value, "1.8")
        XCTAssertEqual(options(.tailnet, 12, zoom: 0.67).query.last?.value, "1.34")
        XCTAssertEqual(options(.tailnet, 12, zoom: 0.9).maxWidth, 1206)
        XCTAssertEqual(options(.tailnet, 12, zoom: 0.5), BrowserStreamOptions(quality: 60, fps: 10, maxWidth: 1206, maxHeight: 2622),
                       "2 a point at 50%: a frame pixel a CSS pixel, no scale to ask, the screen's bound")
        // Past that (the product under 1) the Mac still draws the CSS size, more pixels than the tier's: there the
        // tier's own pixels bound the frame — the screen's points times the tier's pixels a point — and the
        // screencast makes it that small.
        for zoom in [0.33, 0.25] {
            XCTAssertEqual(options(.lan, nil, zoom: zoom), BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622), "3 a point: the screen's own, \(zoom)")
            XCTAssertEqual(options(.tailnet, 40, zoom: zoom), BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622), "\(zoom)")
            XCTAssertEqual(options(.tailnet, 12, zoom: zoom), BrowserStreamOptions(quality: 60, fps: 10, maxWidth: 804, maxHeight: 1748), "2 a point of 402 × 874, \(zoom)")
        }
        for zoom in [0.9, 0.8, 0.75, 0.67, 0.5, 0.33, 0.25] {
            XCTAssertEqual(options(.tailnet, 3, zoom: zoom), BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 402, maxHeight: 874), "1 a point: the screen's points, \(zoom)")
            XCTAssertEqual(options(.tailnet, nil, zoom: zoom), options(.tailnet, 3, zoom: zoom), "not measured: the slow way, \(zoom)")
        }
        XCTAssertEqual(options(.lan, nil, zoom: 5).scale, 8, "never more than the Mac takes")
        // A 2× screen on a fair link is at its own scale: its own pixels bound a page zoomed out past them, and meet
        // the little more it asks of a zoomed page.
        let small = CGSize(width: 750, height: 1334)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, mbps: 12, screenPixels: small, screenScale: 2, zoom: 1.5),
                       BrowserStreamOptions(quality: 60, fps: 10, maxWidth: 750, maxHeight: 1334, scale: 3.02))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, mbps: 12, screenPixels: small, screenScale: 2, zoom: 0.25),
                       BrowserStreamOptions(quality: 60, fps: 10, maxWidth: 750, maxHeight: 1334))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, mbps: 3, screenPixels: small, screenScale: 2, zoom: 0.25),
                       BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 375, maxHeight: 667))
        // A 1× screen asks for no scale and no bound at 100%, as before; for the factor of a page zoomed in; and zoomed
        // out its pixels bound the frame.
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, mbps: nil, screenPixels: pixels, screenScale: 1, zoom: 2),
                       BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 2.02))
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, mbps: nil, screenPixels: pixels, screenScale: 1, zoom: 1), BrowserStreamPolicy.local)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, mbps: nil, screenPixels: pixels, screenScale: 1, zoom: 0.5),
                       BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622))
        // Without the screen known: as before, whatever the zoom (the slow way's bound is then the pixels it was given).
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, mbps: nil, zoom: 2), BrowserStreamPolicy.local)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .lan, mbps: nil, zoom: 0.25), BrowserStreamPolicy.local)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, mbps: 12, screenPixels: pixels, zoom: 0.25), BrowserStreamPolicy.fair)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, mbps: 3, zoom: 0.5), BrowserStreamPolicy.slow)
        XCTAssertEqual(BrowserStreamPolicy.options(kind: .tailnet, mbps: 3, screenPixels: pixels, zoom: 0.5),
                       BrowserStreamOptions(quality: 45, fps: 5, maxWidth: 1206, maxHeight: 2622))
    }

    // MARK: the frames the Mac then sends

    /// The Mac's own arithmetic for one stream (packages/daemon/src/browser/screencast.ts renderScale and viewAt; the
    /// view's limits, 4096 a side and 3840 × 2400 in all, are far from a phone): the view is drawn at what the stream
    /// asks, as far as its bound holds that many pixels, to a thousandth and never under 1; a view larger than the
    /// bound (the CSS size of a page zoomed far out) is made smaller by the screencast.
    private func frame(of page: BrowserViewport, for ask: BrowserStreamOptions) -> CGSize {
        let bounds = [ask.maxWidth.map { Double($0) / page.width }, ask.maxHeight.map { Double($0) / page.height }].compactMap { $0 }
        let fits = ([ask.scale ?? 1] + bounds).min() ?? 1
        let scale = max(1, (fits * 1000 + 1e-9).rounded(.down) / 1000)
        let view = CGSize(width: (page.width * scale).rounded(), height: (page.height * scale).rounded())
        let smaller = ([1] + [ask.maxWidth.map { Double($0) / view.width }, ask.maxHeight.map { Double($0) / view.height }].compactMap { $0 }).min() ?? 1
        return CGSize(width: (view.width * smaller).rounded(), height: (view.height * smaller).rounded())
    }

    /// Why a fiftieth more (review, 2026-10-03): the page's sides are whole CSS pixels, up to half a pixel off the
    /// area over the factor, so at the product itself the view could come a pixel or two narrower than the screen
    /// (365 at 3.3 is 1204.5: 1205 for 1206) and be stretched across it. Asked a little more, the stream's bound — the
    /// screen's own pixels — settles the view: 1206 / 365 is 3.304, the frame 1206. Zoomed out the same: 433 at 2.7
    /// (90% on a 390 pt phone) is 1169 for 1170.
    func testAPageZoomedInComesExactlyAsWideAsTheScreen() {
        XCTAssertEqual(frame(of: BrowserViewport(width: 433, height: 733), for: BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1170, maxHeight: 2532, scale: 2.7)).width, 1169,
                       "zoomed out, at the product itself")
        XCTAssertEqual(frame(of: BrowserViewport(width: 433, height: 733), for: BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1170, maxHeight: 2532, scale: 2.72)).width, 1170)
        XCTAssertEqual(frame(of: BrowserViewport(width: 365, height: 627), for: BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 3.3)).width, 1205,
                       "at the product itself")
        XCTAssertEqual(frame(of: BrowserViewport(width: 365, height: 627), for: BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 3.32)),
                       CGSize(width: 1206, height: 2072))
        // Every iPhone width at 3×, the screen area what the page's bars leave (690 of 874 pt on the 402 pt phone).
        for screen in [CGSize(width: 375, height: 812), CGSize(width: 390, height: 844), CGSize(width: 393, height: 852), CGSize(width: 402, height: 874),
                       CGSize(width: 430, height: 932), CGSize(width: 440, height: 956)] {
            let pixels = CGSize(width: screen.width * 3, height: screen.height * 3)
            let area = CGSize(width: screen.width, height: screen.height - 184)
            let zoomedIn = BrowserPageZoom.usable(in: area).filter { $0 > 100 }
            XCTAssertGreaterThanOrEqual(zoomedIn.count, 4, "\(screen.width)")
            for percent in zoomedIn {
                let page = BrowserPageZoom.viewport(area: area, screenScale: 3, percent: percent)
                let ask = BrowserStreamPolicy.options(kind: .lan, mbps: nil, screenPixels: pixels, screenScale: 3, zoom: BrowserPageZoom.factor(percent))
                XCTAssertEqual(frame(of: page, for: ask).width, pixels.width, "\(Int(screen.width)) pt at \(percent)%")
            }
        }
    }

    /// What the tiers' own bound is for (review, 2026-10-03): a 402 × 690 pt area at 3× on a fair link got the whole
    /// screen's 1206 × 2070 at 50% and under, 2.25 times the tier's pixels; on a slow one up to 9 times.
    func testAPageZoomedOutComesNoLargerThanTheTiersPixels() {
        let pixels = CGSize(width: 1206, height: 2622), area = CGSize(width: 402, height: 690)
        func sent(_ kind: EndpointKind, _ mbps: Double?, _ percent: Int) -> CGSize {
            let page = BrowserPageZoom.viewport(area: area, screenScale: 3, percent: percent)
            return frame(of: page, for: BrowserStreamPolicy.options(kind: kind, mbps: mbps, screenPixels: pixels, screenScale: 3, zoom: BrowserPageZoom.factor(percent)))
        }
        let out = BrowserPageZoom.usable(in: area).filter { $0 < 100 }
        XCTAssertEqual(out, [25, 33, 50, 67, 75, 80, 90])
        // A fair link: the tier's 804 × 1380 at every one of them, to the page's rounding.
        XCTAssertEqual(sent(.tailnet, 12, 50), CGSize(width: 804, height: 1380))
        XCTAssertEqual(sent(.tailnet, 12, 25), CGSize(width: 804, height: 1380))
        for percent in out {
            XCTAssertEqual(sent(.tailnet, 12, percent).width, 804, accuracy: 1, "\(percent)%")
            XCTAssertEqual(sent(.tailnet, 12, percent).height, 1380, accuracy: 1, "\(percent)%")
            // A slow one: the screen's points.
            XCTAssertEqual(sent(.tailnet, 3, percent).width, 402, "\(percent)%")
            XCTAssertEqual(sent(.tailnet, 3, percent).height, 690, accuracy: 1, "\(percent)%")
        }
        // The local network: the frames the screen's own scale and bound gave before, at every one.
        for percent in out + [100] {
            let before = BrowserStreamOptions(quality: 70, fps: 15, maxWidth: 1206, maxHeight: 2622, scale: 3)
            XCTAssertEqual(sent(.lan, nil, percent), frame(of: BrowserPageZoom.viewport(area: area, screenScale: 3, percent: percent), for: before), "\(percent)%")
            XCTAssertEqual(sent(.lan, nil, percent).width, 1206, "\(percent)%")
        }
    }

    /// What the Mac is sent for a page at 67% on a 3× phone: the size on its viewport route, the scale on the stream.
    func testTheMacIsSentTheZoomedSizeAndAsksItsStreamAtTheZoom() async throws {
        let tab = #"{"tab":{"id":"a1"}}"#
        let transport = FakeTransport(stream: { req, _ in (httpResponse(req.url, status: 404), [Data(#"{"error":"not found"}"#.utf8)], nil) },
                                      handler: { req, _ in (Data(tab.utf8), httpResponse(req.url)) })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)), transport: transport, token: "tok")
        let page = BrowserPageZoom.viewport(area: phone, screenScale: 3, percent: 67)
        _ = try await api.setBrowserViewport("a1", width: Int(page.width), height: Int(page.height), scale: page.scale, mobile: page.mobile, screen: "phone-1")
        let sent = try XCTUnwrap(transport.requests.first?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? NSDictionary })
        XCTAssertEqual(sent, ["width": 600, "height": 1045, "scale": 2.01, "mobile": true, "screen": "phone-1"])
        let options = BrowserStreamPolicy.options(kind: .lan, mbps: nil, screenPixels: CGSize(width: 1206, height: 2622), screenScale: 3, zoom: 1.5)
        for try await _ in api.browserEvents("a1", options: options) {}
        XCTAssertEqual(transport.requests.last?.url?.query, "quality=70&fps=15&maxWidth=1206&maxHeight=2622&scale=4.52")
        // Zoomed out past the tier's pixels on a fair link: no scale, the tier's own bound.
        let far = BrowserStreamPolicy.options(kind: .tailnet, mbps: 12, screenPixels: CGSize(width: 1206, height: 2622), screenScale: 3, zoom: 0.25)
        for try await _ in api.browserEvents("a1", options: far) {}
        XCTAssertEqual(transport.requests.last?.url?.query, "quality=60&fps=10&maxWidth=804&maxHeight=1748")
    }

    // MARK: the picture and input

    /// The picture of a page this phone sized is the area again at every zoom (across the width exactly, the height to
    /// the whole pixels of the page's size), and a touch maps to the frame pixel under the finger.
    func testThePictureFillsTheAreaAndATouchLandsUnderTheFingerAtEveryZoom() throws {
        for area in [phone, CGSize(width: 393, height: 660), CGSize(width: 375, height: 548), CGSize(width: 440, height: 743)] {
            for percent in BrowserPageZoom.usable(in: area) {
                let page = BrowserPageZoom.viewport(area: area, screenScale: 3, percent: percent)
                // The Mac draws the view at some pixels a CSS pixel: the frame is the page's size times that.
                for density in [1.0, 1.5, 3] {
                    let frame = CGSize(width: page.width * density, height: page.height * density)
                    let layout = BrowserLayout(frame: frame, area: area, fillWidth: true)
                    XCTAssertEqual(layout.picture.minX, 0, accuracy: 0.001, "\(percent)%")
                    XCTAssertEqual(layout.picture.minY, 0, "\(percent)%")
                    XCTAssertEqual(layout.picture.width, area.width, accuracy: 0.001, "\(percent)%")
                    XCTAssertEqual(layout.picture.height, area.height, accuracy: area.height * 0.005, "\(percent)% of \(area)")
                    // A finger a third across and two thirds down the picture is on that pixel of the frame: the CSS
                    // pixel the Mac divides it down to is the same part of the page.
                    let at = try XCTUnwrap(layout.framePoint(at: CGPoint(x: area.width / 3, y: layout.picture.height * 2 / 3)))
                    XCTAssertEqual(at.x / density, page.width / 3, accuracy: 0.001, "\(percent)%")
                    XCTAssertEqual(at.y / density, page.height * 2 / 3, accuracy: 0.001, "\(percent)%")
                }
            }
        }
    }

    // MARK: remembered by site

    func testTheZoomIsRememberedBySite() {
        let none = BrowserZoomMemory()
        XCTAssertNil(none.percent(for: "github.com"))
        let one = none.setting(50, for: "github.com")
        XCTAssertEqual(none.sites, [], "a new value: the old one is as it was")
        XCTAssertEqual(one.percent(for: "github.com"), 50)
        XCTAssertNil(one.percent(for: "gist.github.com"), "another host is another site")
        // The site set last comes first; a site is kept once.
        let three = one.setting(150, for: "localhost:5173").setting(125, for: "~/Projects/x/index.html").setting(67, for: "github.com")
        XCTAssertEqual(three.sites, [.init(site: "github.com", percent: 67), .init(site: "~/Projects/x/index.html", percent: 125),
                                     .init(site: "localhost:5173", percent: 150)])
        // 100% forgets the site.
        let back = three.setting(100, for: "github.com")
        XCTAssertNil(back.percent(for: "github.com"))
        XCTAssertEqual(back.sites.map(\.site), ["~/Projects/x/index.html", "localhost:5173"])
        XCTAssertEqual(back.setting(100, for: "never.example"), back, "nothing to forget")
        // A blank tab is never kept.
        XCTAssertEqual(three.setting(150, for: ""), three)
        XCTAssertEqual(three.setting(150, for: "about:blank"), three)
        XCTAssertNil(three.percent(for: ""))
        // Nor a percent no screen could use.
        XCTAssertEqual(three.setting(0, for: "x.example"), three)
        XCTAssertEqual(three.setting(5000, for: "x.example"), three)
    }

    func testTheMemoryKeepsTheSitesSetLast() {
        let full = (0..<BrowserZoomMemory.limit).reduce(BrowserZoomMemory()) { $0.setting(50, for: "site\($1).example") }
        XCTAssertEqual(BrowserZoomMemory.limit, 200)
        XCTAssertEqual(full.sites.count, 200)
        XCTAssertEqual(full.sites.first?.site, "site199.example")
        // One more: the one set longest ago goes.
        let more = full.setting(125, for: "new.example")
        XCTAssertEqual(more.sites.count, 200)
        XCTAssertEqual(more.sites.first, .init(site: "new.example", percent: 125))
        XCTAssertNil(more.percent(for: "site0.example"))
        XCTAssertEqual(more.percent(for: "site1.example"), 50)
        // Setting an old one again keeps it: it is the newest now.
        let again = full.setting(75, for: "site0.example").setting(125, for: "new.example")
        XCTAssertEqual(again.percent(for: "site0.example"), 75)
        XCTAssertNil(again.percent(for: "site1.example"))
    }

    func testTheMemoryIsKeptAsJSONAndReadAsItIsKept() throws {
        let memory = BrowserZoomMemory().setting(50, for: "github.com").setting(150, for: "localhost:5173")
        let data = try JSONEncoder().encode(memory)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? NSDictionary,
                       ["sites": [["site": "localhost:5173", "percent": 150], ["site": "github.com", "percent": 50]]])
        XCTAssertEqual(try JSONDecoder().decode(BrowserZoomMemory.self, from: data), memory)
        // What this version would not have written is not read: a site twice (its first counts), a blank one, 100%, a
        // percent outside the steps, more than it keeps.
        let odd = #"{"sites":[{"site":"a.example","percent":50},{"site":"a.example","percent":75},{"site":"","percent":50},"#
            + #"{"site":"b.example","percent":100},{"site":"c.example","percent":-9223372036854775808},{"site":"d.example","percent":200}]}"#
        XCTAssertEqual(try JSONDecoder().decode(BrowserZoomMemory.self, from: Data(odd.utf8)).sites,
                       [.init(site: "a.example", percent: 50), .init(site: "d.example", percent: 200)])
        let over = #"{"sites":["# + (0..<300).map { #"{"site":"s\#($0).example","percent":50}"# }.joined(separator: ",") + "]}"
        let kept = try JSONDecoder().decode(BrowserZoomMemory.self, from: Data(over.utf8))
        XCTAssertEqual(kept.sites.count, 200)
        XCTAssertEqual(kept.sites.last?.site, "s199.example", "the first of them: the ones set last")
        // Something else under the key is not read at all (the app then starts with nothing remembered).
        XCTAssertThrowsError(try JSONDecoder().decode(BrowserZoomMemory.self, from: Data(#"{"sites":[{"site":"a.example","percent":"50"}]}"#.utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(BrowserZoomMemory.self, from: Data("[]".utf8)))
    }

    // MARK: the picture's own steps

    /// While the phone only watches a tab the zoom key steps the picture, as two fingers would.
    func testTheZoomKeyStepsThePictureWhileOnlyWatching() {
        XCTAssertEqual(BrowserZoom.steps, [1, 1.25, 1.5, 2, 3, 4])
        XCTAssertEqual(BrowserZoom.none.percent, 100)
        XCTAssertEqual(BrowserZoom(scale: 1.25).percent, 125)
        XCTAssertEqual(BrowserZoom(scale: 2.368).percent, 237)
        XCTAssertEqual(BrowserZoom.none.stepIn, 1.25)
        XCTAssertNil(BrowserZoom.none.stepOut)
        XCTAssertEqual(BrowserZoom(scale: 2).stepIn, 3)
        XCTAssertEqual(BrowserZoom(scale: 2).stepOut, 1.5)
        XCTAssertNil(BrowserZoom(scale: 4).stepIn)
        XCTAssertEqual(BrowserZoom(scale: 4).stepOut, 3)
        // A pinch stops anywhere between the steps.
        XCTAssertEqual(BrowserZoom(scale: 1.37).stepIn, 1.5)
        XCTAssertEqual(BrowserZoom(scale: 1.37).stepOut, 1.25)
        XCTAssertEqual(BrowserZoom(scale: 1.2500004).stepIn, 1.5, "a step itself, to the rounding")
        XCTAssertEqual(BrowserZoom(scale: 1.2500004).stepOut, 1)
    }

    /// The chip at the picture's top right says the scale to one decimal, wherever two fingers left it; a step of the
    /// zoom key that has hundredths is written in full (review, 2026-10-03: to one decimal the 125% step read `1.2×`
    /// beside a key and a row saying `125%`; the demo page writes `1.25×`).
    func testTheChipWritesTheScaleAndAKeyStepInFull() {
        XCTAssertEqual(BrowserZoom.steps.map { BrowserZoom(scale: $0).times }, ["1.0×", "1.25×", "1.5×", "2.0×", "3.0×", "4.0×"])
        // Stepped to by the key from wherever a pinch stopped.
        XCTAssertEqual(BrowserZoom(scale: 1.1).stepped(to: 1.25, picture: CGRect(x: 0, y: 0, width: 402, height: 251.25), area: phone).times, "1.25×")
        // What a pinch leaves: one decimal, as before.
        XCTAssertEqual(BrowserZoom(scale: 1.37).times, "1.4×")
        XCTAssertEqual(BrowserZoom(scale: 1.2).times, "1.2×")
        XCTAssertEqual(BrowserZoom(scale: 1.27).times, "1.3×")
        XCTAssertEqual(BrowserZoom(scale: 2.368).times, "2.4×")
        XCTAssertEqual(BrowserZoom(scale: 3.96).times, "4.0×")
        // A step itself, to the rounding (as the steps in and out take it).
        XCTAssertEqual(BrowserZoom(scale: 1.2500004).times, "1.25×")
        XCTAssertEqual(BrowserZoom(scale: 1.5000004).times, "1.5×")
    }

    /// A desktop page watched sits at the top of the area, shorter than it: stepping in, it grows downwards about its
    /// middle, its top edge staying where it is.
    func testAPictureShorterThanTheAreaKeepsItsTopEdge() {
        // Where a 1280 × 800 page is drawn in the phone's area (BrowserLayout: fitted to the width, its top at the top).
        let picture = CGRect(x: 0, y: 0, width: 402, height: 251.25)
        XCTAssertEqual(BrowserLayout(frame: CGSize(width: 1280, height: 800), area: phone).picture.height, picture.height, accuracy: 0.001)
        let first = BrowserZoom.none.stepped(to: 1.25, picture: picture, area: phone)
        XCTAssertEqual(first, BrowserZoom(scale: 1.25, offset: CGPoint(x: -50.25, y: 0)), "about the middle of the width, the top where it was")
        let second = first.stepped(to: 1.5, picture: picture, area: phone)
        XCTAssertEqual(second, BrowserZoom(scale: 1.5, offset: CGPoint(x: -100.5, y: 0)))
        let third = second.stepped(to: 2, picture: picture, area: phone)
        XCTAssertEqual(third, BrowserZoom(scale: 2, offset: CGPoint(x: -201, y: 0)))
        // And back out the same way, to the whole picture.
        XCTAssertEqual(third.stepped(to: 1.5, picture: picture, area: phone), second)
        XCTAssertEqual(first.stepped(to: 1, picture: picture, area: phone), BrowserZoom.none)
        // A pinch had moved its top out of sight: a step brings it back while there is room under the picture.
        let pinched = BrowserZoom.none.pinched(to: 1.6, around: CGPoint(x: 200, y: 100), area: phone)
        XCTAssertEqual(pinched.offset.y, -60, accuracy: 0.001)
        XCTAssertEqual(pinched.stepped(to: 2, picture: picture, area: phone).offset.y, 0)
    }

    /// Taller than the area, the picture is zoomed about the middle of what is in view and keeps covering the area.
    func testAPictureTallerThanTheAreaIsSteppedAboutTheMiddleOfWhatIsSeen() {
        let picture = CGRect(x: 0, y: 0, width: 402, height: 251.25)
        // 2× is 502.5 high, 3× 753.75: its middle stays, then it is moved to cover the area's height.
        let two = BrowserZoom(scale: 2, offset: CGPoint(x: -201, y: 0))
        let three = two.stepped(to: 3, picture: picture, area: phone)
        XCTAssertEqual(three.scale, 3)
        XCTAssertEqual(three.offset.x, -402, accuracy: 0.001)
        XCTAssertEqual(three.offset.y, 700 - 753.75, accuracy: 0.001, "no band left under it while its top is out of sight")
        // In view: the whole area. 4× about its middle.
        let four = three.stepped(to: 4, picture: picture, area: phone)
        let middle = CGPoint(x: 201, y: 350)
        XCTAssertEqual(four.invert(middle).x, three.invert(middle).x, accuracy: 0.001)
        XCTAssertEqual(four.invert(middle).y, three.invert(middle).y, accuracy: 0.001)
        XCTAssertEqual(four.stepped(to: 3, picture: picture, area: phone).offset.y, three.offset.y, accuracy: 0.001)
        XCTAssertEqual(four.stepped(to: 9, picture: picture, area: phone).scale, 4, "within the picture's range")
        // A picture as large as the area (a page at the phone's size, pinched): about the middle of the area.
        let whole = CGRect(origin: .zero, size: phone)
        let zoomed = BrowserZoom.none.stepped(to: 2, picture: whole, area: phone)
        XCTAssertEqual(zoomed, BrowserZoom(scale: 2, offset: CGPoint(x: -201, y: -350)))
        // The middle of what is seen of the picture is not the middle of the area: a picture 600 high in the 700 of
        // the area, stepped to twice its size (taller than the area then), is zoomed about its own middle, (201, 300)
        // — about the area's, (201, 350), it would sit 50 pt higher (review, 2026-10-03: every other case here has
        // the two middles equal, or is settled by the top edge or the band under the picture).
        let shorter = CGRect(x: 0, y: 0, width: 402, height: 600)
        XCTAssertEqual(BrowserZoom.none.stepped(to: 2, picture: shorter, area: phone), BrowserZoom(scale: 2, offset: CGPoint(x: -201, y: -300)))
        // Nothing drawn yet: the middle of the area.
        XCTAssertEqual(BrowserZoom.none.stepped(to: 2, picture: .zero, area: phone).scale, 2)
    }
}
