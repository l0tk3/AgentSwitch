import CoreGraphics
import XCTest
@testable import AgentSwitchMacCore

/// Page zoom on the Mac's Browser page (docs/browser-v0.md §1 页面缩放, 2026-10-03, user: 然后我发现agentswitch的浏览器页
/// 没有放大缩小的选项，加上 用来调节大小): the steps a screen can use and the one in force, what is remembered of a site, who
/// may zoom a tab, the size and the stream this Mac asks for at a zoom, and how the picture is drawn and input mapped.
final class BrowserZoomTests: XCTestCase {
    private let codex = BrowserOwner(kind: .terminal, id: "k1", label: "codex · AgentSwitch")
    /// The browser area of the main window at its first size (1280 × 820, the tab list open) and of a large one.
    private let area = CGSize(width: 945, height: 722)
    private let large = CGSize(width: 2560, height: 1400)

    // MARK: steps

    func testTheStepsAreChromes() {
        XCTAssertEqual(BrowserPageZoom.steps, [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500])
        XCTAssertEqual(BrowserPageZoom.standard, 100)
        XCTAssertEqual(BrowserPageZoom.factor(125), 1.25)
        XCTAssertEqual(BrowserPageZoom.factor(33), 0.33)
        XCTAssertEqual(BrowserPageZoom.steps, BrowserPageZoom.steps.sorted(), "in order: `+` goes up, `−` down")
    }

    func testAScreenUsesTheStepsThatKeepTheTabWithinWhatTheDaemonTakes() {
        // 945 × 722: 2864 × 2188 at 33 %, 315 × 241 at 300 %; at 400 % the height would be 181. At 25 % both sides would
        // fit (3780 × 2888) but the page would be 10.9 million pixels, more than the daemon draws of a view in all.
        XCTAssertEqual(BrowserPageZoom.usable(in: area), [33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300])
        XCTAssertEqual(BrowserPageZoom.pagePixels, 3840 * 2400)
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 800, height: 600)).first, 25, "3200 × 2400: within it")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 960, height: 600)).first, 25, "3840 × 2400: just within it")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 961, height: 600)).first, 33, "3844 × 2400: a column past it")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 1024, height: 900)).first, 33, "4096 × 3600 at 25 %: the sides fit, the page does not")
        // 2560 × 1400: 5120 wide at 50 %, 3821 × 2090 at 67 %; 512 × 280 at 500 %.
        XCTAssertEqual(BrowserPageZoom.usable(in: large), [67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500])
        // The sides are to the nearest CSS pixel, as the size asked for is: 499 ÷ 2.5 is 200, 498.7 ÷ 2.5 is 199.
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 499, height: 600)).last, 250)
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 498.7, height: 600)).last, 200)
        XCTAssertEqual(BrowserPageZoom.side(722, factor: 1.25), 578)
        XCTAssertEqual(BrowserPageZoom.side(990, factor: 1.1), 900)
        XCTAssertEqual(BrowserPageZoom.usable(in: .zero), [], "no area yet: no step")
        XCTAssertEqual(BrowserPageZoom.usable(in: CGSize(width: 9000, height: 100)), [], "no step fits both sides")
    }

    func testTheStepInForceIsTheUsableOneNearestToWhatIsRemembered() {
        XCTAssertEqual(BrowserPageZoom(remembered: nil, area: area), BrowserPageZoom(percent: 100, larger: 110, smaller: 90),
                       "nothing remembered: 100 %")
        XCTAssertEqual(BrowserPageZoom(remembered: 125, area: area), BrowserPageZoom(percent: 125, larger: 150, smaller: 110))
        XCTAssertEqual(BrowserPageZoom(remembered: 125, area: area).factor, 1.25)
        XCTAssertFalse(BrowserPageZoom(remembered: 125, area: area).isStandard)
        XCTAssertTrue(BrowserPageZoom(remembered: nil, area: area).isStandard)
        // The area changed since it was set: the nearest step it can use.
        XCTAssertEqual(BrowserPageZoom(remembered: 500, area: area), BrowserPageZoom(percent: 300, larger: nil, smaller: 250))
        XCTAssertEqual(BrowserPageZoom(remembered: 25, area: large), BrowserPageZoom(percent: 67, larger: 75, smaller: nil))
        // A percent that is no step (another version's): the nearest, a tie going toward 100 %.
        XCTAssertEqual(BrowserPageZoom(remembered: 120, area: area).percent, 125)
        XCTAssertEqual(BrowserPageZoom(remembered: 105, area: area).percent, 100)
        XCTAssertEqual(BrowserPageZoom(remembered: 95, area: area).percent, 100)
        XCTAssertEqual(BrowserPageZoom(remembered: 150, area: .zero), .fixed, "no step to use: 100 %, nowhere to go")
    }

    func testZoomInAndOutGoToTheNextUsableStepAndStopAtTheEnds() {
        XCTAssertEqual(BrowserPageZoom(remembered: 250, area: area).larger, 300)
        XCTAssertNil(BrowserPageZoom(remembered: 300, area: area).larger, "400 % does not fit this area")
        XCTAssertEqual(BrowserPageZoom(remembered: 50, area: area).smaller, 33)
        XCTAssertNil(BrowserPageZoom(remembered: 33, area: area).smaller, "25 % would be more pixels than the daemon draws")
        XCTAssertEqual(BrowserPageZoom(remembered: 25, area: area).percent, 33, "remembered on a smaller area: the nearest this one can use")
        XCTAssertEqual(BrowserPageZoom(remembered: 33, area: CGSize(width: 800, height: 600)).smaller, 25)
        XCTAssertEqual(BrowserPageZoom(remembered: 400, area: large).larger, 500)
        XCTAssertNil(BrowserPageZoom(remembered: 500, area: large).larger)
        // 100 % itself out of reach (a browser area under 200 points wide): the steps beside it are still there.
        XCTAssertEqual(BrowserPageZoom(remembered: nil, area: CGSize(width: 180, height: 300)), BrowserPageZoom(percent: 100, larger: nil, smaller: 90))
        XCTAssertEqual(BrowserPageZoom.fixed, BrowserPageZoom(percent: 100, larger: nil, smaller: nil))
    }

    // MARK: remembered per site

    func testASitesZoomIsRememberedAndOneHundredForgetsIt() {
        let memory = BrowserZoomMemory().setting(125, for: "github.com").setting(50, for: "localhost:5173")
        XCTAssertEqual(memory.percent(for: "github.com"), 125)
        XCTAssertEqual(memory.percent(for: "localhost:5173"), 50)
        XCTAssertNil(memory.percent(for: "example.com"), "never set: 100 %")
        XCTAssertEqual(memory.sites.map(\.site), ["localhost:5173", "github.com"], "the one set last first")
        let again = memory.setting(150, for: "github.com")
        XCTAssertEqual(again.sites, [BrowserZoomMemory.Entry(site: "github.com", percent: 150), BrowserZoomMemory.Entry(site: "localhost:5173", percent: 50)])
        XCTAssertEqual(again.setting(100, for: "github.com").sites.map(\.site), ["localhost:5173"], "100 % is not kept")
        XCTAssertEqual(memory.percent(for: "github.com"), 125, "a new value each time: the one before is as it was")
        XCTAssertEqual(BrowserZoomMemory().setting(100, for: "github.com"), .empty)
        XCTAssertEqual(memory.setting(9, for: "github.com"), memory, "no zoom a page can have: nothing changes")
    }

    func testAtMostTwoHundredSitesTheLeastRecentlySetDroppedFirst() {
        var memory = BrowserZoomMemory()
        for n in 0..<205 { memory = memory.setting(110, for: "site\(n).example") }
        XCTAssertEqual(memory.sites.count, BrowserZoomMemory.limit)
        XCTAssertEqual(BrowserZoomMemory.limit, 200)
        XCTAssertNil(memory.percent(for: "site4.example"), "the five set first are gone")
        XCTAssertEqual(memory.percent(for: "site5.example"), 110)
        // Set again, a site is the newest: the next one in drops another.
        memory = memory.setting(125, for: "site5.example").setting(110, for: "one-more.example")
        XCTAssertEqual(memory.sites.count, 200)
        XCTAssertEqual(memory.percent(for: "site5.example"), 125)
        XCTAssertNil(memory.percent(for: "site6.example"))
    }

    func testABlankTabIsNeverRemembered() {
        XCTAssertNil(BrowserZoomMemory.site(of: BrowserTab(id: "a", url: "about:blank", kind: .blank)))
        XCTAssertNil(BrowserZoomMemory.site(of: BrowserTab(id: "a", site: "")))
        XCTAssertNil(BrowserZoomMemory.site(of: BrowserTab(id: "a", site: "about:blank")))
        XCTAssertNil(BrowserZoomMemory.site(of: BrowserTab(id: "a", site: "leftover.example", kind: .blank)), "blank whatever its site says")
        XCTAssertEqual(BrowserZoomMemory.site(of: BrowserTab(id: "a", site: "github.com")), "github.com")
        XCTAssertEqual(BrowserZoomMemory.site(of: BrowserTab(id: "a", site: "localhost:5173", kind: .local)), "localhost:5173")
        XCTAssertEqual(BrowserZoomMemory.site(of: BrowserTab(id: "a", site: "~/x/mesh.html", kind: .file)), "~/x/mesh.html", "a file by its path")
        XCTAssertEqual(BrowserZoomMemory().setting(150, for: ""), .empty)
        XCTAssertEqual(BrowserZoomMemory().setting(150, for: "about:blank"), .empty)
        XCTAssertNil(BrowserZoomMemory().percent(for: ""))
    }

    func testTheMemoryIsKeptAsJSONAndWhatIsUnreadableIsNothing() throws {
        let memory = BrowserZoomMemory().setting(125, for: "github.com").setting(50, for: "localhost:5173")
        XCTAssertEqual(BrowserZoomMemory.restored(memory.stored), memory)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(memory.stored.utf8)) as? [String: Any])
        let sites = try XCTUnwrap(object["sites"] as? [[String: Any]])
        XCTAssertEqual(sites.map { $0["site"] as? String }, ["localhost:5173", "github.com"])
        XCTAssertEqual(sites.map { $0["percent"] as? Int }, [50, 125])
        XCTAssertEqual(BrowserZoomMemory.restored(nil), .empty)
        XCTAssertEqual(BrowserZoomMemory.restored("not json"), .empty)
        XCTAssertEqual(BrowserZoomMemory.restored("{}"), .empty)
        // What cannot be a site's zoom is left out, the rest kept: 100 %, a percent out of the steps' range, no site, a
        // site twice (the newer one, first, stays), an entry of another shape.
        let stored = #"{"sites":[{"site":"a.example","percent":150},{"site":"b.example","percent":100},{"site":"c.example","percent":900},"#
            + #"{"site":"","percent":125},{"site":"a.example","percent":50},{"site":"d.example"},{"site":"e.example","percent":67}]}"#
        XCTAssertEqual(BrowserZoomMemory.restored(stored).sites,
                       [BrowserZoomMemory.Entry(site: "a.example", percent: 150), BrowserZoomMemory.Entry(site: "e.example", percent: 67)])
        let many = BrowserZoomMemory(sites: (0..<300).map { BrowserZoomMemory.Entry(site: "s\($0).example", percent: 110) })
        XCTAssertEqual(many.sites.count, 200)
        XCTAssertEqual(many.sites.first?.site, "s0.example", "the newest are the ones kept")
        XCTAssertEqual(BrowserZoomMemory.storeKey, "browser.zoom")
    }

    // MARK: who zooms a tab

    func testOnlyTheScreenThatSizesATabZoomsItsPage() {
        let memory = BrowserZoomMemory().setting(125, for: "github.com")
        func zoom(_ tab: BrowserTab) -> BrowserPageZoom {
            BrowserScreenPolicy.zoom(of: tab, screen: "mac-main", memory: memory, usable: BrowserPageZoom.usable(in: area))
        }
        let here = BrowserTab(id: "a", site: "github.com", heldBy: "mac-main")
        XCTAssertTrue(BrowserScreenPolicy.sizes(here, screen: "mac-main"))
        XCTAssertEqual(zoom(here), BrowserPageZoom(percent: 125, larger: 150, smaller: 110), "your own tab on this screen: its site's zoom")
        // Not taken yet (it is, as soon as it is shown): already this Mac's to zoom.
        XCTAssertTrue(BrowserScreenPolicy.sizes(BrowserTab(id: "a", site: "github.com"), screen: "mac-main"))
        XCTAssertEqual(zoom(BrowserTab(id: "a", site: "github.com")).percent, 125)
        // On the phone: the phone sizes it, with its own zoom.
        let away = BrowserTab(id: "a", site: "github.com", heldBy: "phone-1")
        XCTAssertFalse(BrowserScreenPolicy.sizes(away, screen: "mac-main"))
        XCTAssertEqual(zoom(away), .fixed)
        // An agent's tab only after Take Over.
        XCTAssertFalse(BrowserScreenPolicy.sizes(BrowserTab(id: "a", owner: codex, site: "github.com"), screen: "mac-main"))
        XCTAssertEqual(zoom(BrowserTab(id: "a", owner: codex, site: "github.com")), .fixed)
        XCTAssertTrue(BrowserScreenPolicy.sizes(BrowserTab(id: "a", owner: codex, site: "github.com", heldBy: "mac-main"), screen: "mac-main"))
        XCTAssertEqual(zoom(BrowserTab(id: "a", owner: codex, site: "github.com", heldBy: "mac-main")).percent, 125, "the same site, the same zoom")
        XCTAssertEqual(zoom(BrowserTab(id: "a", site: "example.com", heldBy: "mac-main")), BrowserPageZoom(percent: 100, larger: 110, smaller: 90),
                       "another site: its own")
        XCTAssertEqual(zoom(BrowserTab(id: "a", url: "about:blank", kind: .blank, heldBy: "mac-main")), .fixed, "a blank tab is always 100 %")
    }

    // MARK: the size and the stream asked for

    func testTheSizeAskedForIsTheAreaDividedByTheZoom() {
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 1.25), BrowserViewportRequest(width: 756, height: 578, scale: 2.5))
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 0.5), BrowserViewportRequest(width: 1890, height: 1444, scale: 1),
                       "50 %: laid out for a window twice as large")
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 3), BrowserViewportRequest(width: 315, height: 241, scale: 4),
                       "the pixel ratio within what the daemon takes")
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 1, zoom: 0.25).scale, 0.5)
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2), BrowserViewportRequest(width: 945, height: 722, scale: 2), "100 %: as before")
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 0), BrowserGeometry.viewport(for: area, backingScale: 2), "no zoom at all is 100 %")
        // A step the area cannot use is never in force; asked for anyway, the sides stay within the daemon's bounds.
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 5), BrowserViewportRequest(width: 200, height: 200, scale: 4))
        // The same each time: the daemon takes the same size as a renewal of the hold.
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 1.1), BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 1.1))
        XCTAssertEqual(BrowserGeometry.viewport(for: area, backingScale: 2, zoom: 1.1), BrowserViewportRequest(width: 859, height: 656, scale: 2.2))
    }

    func testTheStreamAsksForThePixelsOfAZoomedPage() {
        let display = CGSize(width: 1512, height: 982)
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 1.25).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964&scale=2.5")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 1.1).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964&scale=2.2")
        // Under 100 % fewer: a CSS pixel is less than a point wide, and the whole display's pixels would bound the frame
        // well past what the area shows.
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 0.9).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964&scale=1.8")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 0.5).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964", "50 % on a 2x display: a frame pixel a CSS pixel")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 0.25).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964", "never under the CSS size: the display's pixels bound the rest")
        // Zoomed out past a frame pixel a CSS pixel, the daemon still draws the CSS size: the browser area's own pixels
        // bound the frame there, not the whole display's (up to twice the area's a side, minified on screen).
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 0.33, area: area).query,
                       "quality=80&fps=15&maxWidth=1890&maxHeight=1444")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 1, displayPoints: CGSize(width: 1920, height: 1080), zoom: 0.9, area: area).query,
                       "quality=80&fps=15&maxWidth=945&maxHeight=722", "a 1x display under 100 %")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 1, displayPoints: display, zoom: 0.9, area: CGSize(width: 1013.5, height: 700.5)).query,
                       "quality=80&fps=15&maxWidth=1014&maxHeight=701", "whole pixels, none short")
        // From a frame pixel a CSS pixel up, and where this Mac does not size the tab, the display's as before.
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 0.5, area: area).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 1.25, area: area).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964&scale=2.5")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, area: area), BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display))
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 0.33, area: .zero).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964", "no area yet: the display's")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: display, zoom: 5).query,
                       "quality=80&fps=15&maxWidth=3024&maxHeight=1964&scale=8", "at most what the daemon takes")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 1, displayPoints: nil, zoom: 1.5).query, "quality=80&fps=15&scale=1.5")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 1, displayPoints: nil, zoom: 0.75).query, "quality=80&fps=15")
        // What decides whether the stream is asked again after another step.
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 1.25), 2.5)
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 0.9), 1.8, accuracy: 1e-9)
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 0.5), 1)
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 0.33), BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 0.25), "both at the CSS size")
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 0), 2, "no zoom at all is 100 %")
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 4), BrowserScreenPolicy.frameScale(backingScale: 2, zoom: 5), "both at the limit")
        XCTAssertEqual(BrowserScreenPolicy.frameScale(backingScale: 2), 2)
    }

    // MARK: the picture and the input

    func testAPageThisMacSizedIsDrawnAcrossTheAreaAtItsZoom() {
        // 125 % on a Retina display: 756 × 578 CSS pixels at 2.5 frame pixels each, half a point a frame pixel.
        let frame = BrowserFrameGeometry(seq: 7, width: 1890, height: 1445, scale: 2.5)
        XCTAssertEqual(BrowserGeometry.fit(frame, in: area, zoom: 1.25), CGRect(x: 0, y: 0, width: 945, height: 722.5),
                       "a frame pixel to a pixel of the display; the half point past the foot is cut")
        XCTAssertEqual(BrowserGeometry.fit(frame, in: area), CGRect(x: 0, y: 0, width: 944, height: 722), "not knowing the zoom, it would be fitted and resampled")
        // The pointer in the middle of the area is in the middle of the page (378, 288.8 in CSS pixels).
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 472.5, y: 361), frame: frame, in: area, zoom: 1.25), CGPoint(x: 945, y: 722))
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 0, y: 0), frame: frame, in: area, zoom: 1.25), CGPoint(x: 0, y: 0))
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 944.5, y: 721.5), frame: frame, in: area, zoom: 1.25), CGPoint(x: 1889, y: 1443))
        XCTAssertEqual(BrowserGeometry.frameDistance(10, frame: frame, in: area, zoom: 1.25), 20, "a scroll moves the page as far as the fingers: 8 CSS pixels, 10 points")
        XCTAssertEqual(BrowserGeometry.viewRect(BrowserBox(x: 100, y: 40, width: 80, height: 20), frame: frame, in: area, zoom: 1.25),
                       CGRect(x: 125, y: 50, width: 100, height: 25))
    }

    func testEveryStepFillsTheAreaWithinItsRounding() {
        // 50 %: 1890 × 1444 CSS pixels in a frame of more pixels than the area has (1.25 each: another screen's stream
        // asks for more, or a daemon bounded by the display alone): across the area all the same.
        let half = BrowserFrameGeometry(width: 2363, height: 1805, scale: 1.25)
        XCTAssertEqual(BrowserGeometry.fit(half, in: area, zoom: 0.5), CGRect(x: 0, y: 0, width: 945.2, height: 722))
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 472.6, y: 361), frame: half, in: area, zoom: 0.5), CGPoint(x: 1181.5, y: 902.5))
        // 300 % in an area a point wider: 315 CSS pixels are 945 points, a point short across; 241 are 723, a point past.
        let wide = CGSize(width: 946, height: 722)
        XCTAssertEqual(BrowserGeometry.viewport(for: wide, backingScale: 2, zoom: 3), BrowserViewportRequest(width: 315, height: 241, scale: 4))
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1890, height: 1446, scale: 6), in: wide, zoom: 3),
                       CGRect(x: 0, y: 0, width: 945, height: 723), "from the left edge, as a page; the point it is short is at the right")
        // Short by more than its rounding (the window grew, the size has not followed yet): centred, as before.
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1890, height: 1446, scale: 6), in: CGSize(width: 955, height: 730), zoom: 3),
                       CGRect(x: 5, y: 0, width: 945, height: 723))
        // 200 % from a daemon whose limit is 3 frame pixels: drawn larger than its pixels, across the area all the same.
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1419, height: 1083, scale: 3), in: area, zoom: 2),
                       CGRect(x: 0, y: 0, width: 946, height: 722))
        // 110 % from a daemon that draws in quarter steps (as it did until 2026-10-03: 2 for the 2.2 asked): across the
        // area too, larger than its pixels.
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1718, height: 1312, scale: 2), in: area, zoom: 1.1),
                       CGRect(x: 0, y: 0, width: 944.9, height: 721.6))
        // Every usable step of both areas, at the size asked for and the display's pixels: within half a CSS pixel and
        // half a frame pixel of the area, never fitted (resampled) instead.
        for size in [area, large, CGSize(width: 1013.5, height: 700.5)] {
            for step in BrowserPageZoom.usable(in: size) {
                let factor = BrowserPageZoom.factor(step)
                let asked = BrowserGeometry.viewport(for: size, backingScale: 2, zoom: factor)
                let scale = BrowserScreenPolicy.frameScale(backingScale: 2, zoom: factor)
                let frame = BrowserFrameGeometry(width: (Double(asked.width) * scale).rounded(), height: (Double(asked.height) * scale).rounded(), scale: scale)
                let drawn = BrowserGeometry.fit(frame, in: size, zoom: factor)
                let slack = (factor + factor / scale) / 2 + 0.01
                XCTAssertEqual(Double(drawn.width), frame.width * factor / scale, accuracy: 0.01, "\(step) % in \(size): exact across")
                XCTAssertEqual(Double(drawn.height), frame.height * factor / scale, accuracy: 0.01, "\(step) % in \(size): exact down")
                XCTAssertLessThanOrEqual(abs(Double(drawn.width) - Double(size.width)), slack, "\(step) % in \(size): across the area")
                XCTAssertLessThanOrEqual(abs(Double(drawn.height) - Double(size.height)), slack, "\(step) % in \(size): down the area")
                XCTAssertGreaterThanOrEqual(drawn.minX, 0)
            }
        }
    }

    func testATabThisMacDidNotSizeIsFittedAsBefore() {
        // An agent's tab at the default size, and the picture of a zoom that is no longer the one in force (the frames of
        // the new size are on their way): fitted, whatever the zoom.
        let desk = BrowserFrameGeometry(width: 2560, height: 1600, scale: 2)
        XCTAssertEqual(BrowserGeometry.fit(desk, in: area), CGRect(x: 0, y: 0, width: 945, height: 591))
        XCTAssertEqual(BrowserGeometry.fit(desk, in: area, zoom: 1.25), CGRect(x: 0, y: 0, width: 945, height: 591))
        let before = BrowserFrameGeometry(width: 1890, height: 1444, scale: 2)
        XCTAssertEqual(BrowserGeometry.fit(before, in: area, zoom: 1.25), CGRect(x: 0, y: 0, width: 945, height: 722))
        XCTAssertEqual(BrowserGeometry.fit(before, in: area, zoom: 1), CGRect(x: 0, y: 0, width: 945, height: 722))
        // Past the area by more than the rounding of a page of its size (half a CSS pixel and half a frame pixel): a
        // whole CSS pixel wider at 100 %, a point and a half at 125 %. Fitted, not drawn exact and cut at the right.
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1892, height: 1444, scale: 2), in: area), CGRect(x: 0, y: 0, width: 945, height: 721))
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1893, height: 1445, scale: 2.5), in: area, zoom: 1.25),
                       CGRect(x: 0, y: 0, width: 945, height: 721))
    }

    func testAStepThatKeepsTheFramesPixelsStillMovesTheActionsBox() {
        // A 946 × 722 area at 200 % (473 × 361 CSS pixels, 4 frame pixels each) and back at 100 % (946 × 722, 2 each):
        // 1892 × 1444 pixels both times.
        let even = CGSize(width: 946, height: 722)
        XCTAssertEqual(BrowserGeometry.viewport(for: even, backingScale: 2, zoom: 2), BrowserViewportRequest(width: 473, height: 361, scale: 4))
        let zoomed = BrowserFrameGeometry(seq: 8, width: 1892, height: 1444, scale: 4)
        let actual = BrowserFrameGeometry(seq: 9, width: 1892, height: 1444, scale: 2)
        // Back at 100 %, the frames of the new size on their way: the last one fitted, then the new one in its place.
        XCTAssertEqual(BrowserGeometry.fit(zoomed, in: even), CGRect(x: 0, y: 0, width: 946, height: 722))
        XCTAssertEqual(BrowserGeometry.fit(actual, in: even), CGRect(x: 0, y: 0, width: 946, height: 722), "the picture is where it was")
        let box = BrowserBox(x: 48, y: 100, width: 172, height: 36)
        XCTAssertEqual(BrowserGeometry.viewRect(box, frame: zoomed, in: even), CGRect(x: 96, y: 200, width: 344, height: 72))
        XCTAssertEqual(BrowserGeometry.viewRect(box, frame: actual, in: even), CGRect(x: 48, y: 100, width: 172, height: 36), "the action's box is not")
        XCTAssertFalse(actual.sits(as: zoomed), "so the screen places it again")
        // Between two steps above 100 % too: 1000 × 700 at 100 % and at 125 % are 2000 × 1400 pixels. And where the
        // area does not divide evenly: 945 × 726 at 110 % is 859 × 660 CSS pixels at 2.2, to the pixel the 1890 × 1452
        // of 100 %.
        XCTAssertFalse(BrowserFrameGeometry(width: 2000, height: 1400, scale: 2.5).sits(as: BrowserFrameGeometry(width: 2000, height: 1400, scale: 2)))
        XCTAssertEqual(BrowserGeometry.viewport(for: CGSize(width: 945, height: 726), backingScale: 2, zoom: 1.1), BrowserViewportRequest(width: 859, height: 660, scale: 2.2))
        XCTAssertFalse(BrowserFrameGeometry(width: 1890, height: 1452, scale: 2.2).sits(as: BrowserFrameGeometry(width: 1890, height: 1452, scale: 2)))
        // The next frame of the same page: nothing to place again, whatever its number.
        XCTAssertTrue(BrowserFrameGeometry(seq: 10, width: 1892, height: 1444, scale: 2).sits(as: actual))
        XCTAssertFalse(BrowserFrameGeometry(width: 1890, height: 1444, scale: 2).sits(as: actual), "other pixels: placed again, as before")
        XCTAssertFalse(BrowserFrameGeometry(width: 1892, height: 1445, scale: 2).sits(as: actual))
    }

    // MARK: words

    func testTheStatusBarsWords() {
        XCTAssertEqual(BrowserZoomText.percent(BrowserPageZoom(remembered: 125, area: area)), "125%")
        XCTAssertEqual(BrowserZoomText.percent(.fixed), "100%")
        XCTAssertEqual(BrowserZoomText.zoomOut, "−", "the minus sign, not a hyphen")
        XCTAssertEqual(BrowserZoomText.zoomIn, "+")
        XCTAssertEqual(BrowserZoomText.widest.count, 4)
        XCTAssertTrue(BrowserPageZoom.steps.allSatisfy { "\($0)%".count <= BrowserZoomText.widest.count }, "the percent keeps one width: `+` stays where it is")
        XCTAssertEqual(BrowserZoomText.zoomOutHelp, "Zoom Out ⌘−")
        XCTAssertEqual(BrowserZoomText.resetHelp, "Actual Size")
        XCTAssertEqual(BrowserZoomText.zoomInHelp, "Zoom In ⌘+")
        XCTAssertEqual(BrowserZoomText.notSized, "接手后才能缩放。")
    }
}
