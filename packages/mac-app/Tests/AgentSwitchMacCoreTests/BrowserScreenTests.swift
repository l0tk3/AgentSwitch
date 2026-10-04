import CoreGraphics
import XCTest
@testable import AgentSwitchMacCore

/// What the Mac's Browser page asks of a tab and how it draws it (docs/browser-v0.md §1 Mac, §5; 2026-10-03): frames at
/// the display's device pixels, a page of the screen's own size drawn one CSS pixel to a point, your own tab on screen
/// this Mac's (尺寸有主), and the tab list as a side column that resizes, closes and is remembered.
final class BrowserScreenTests: XCTestCase {
    private let codex = BrowserOwner(kind: .terminal, id: "k1", label: "codex · AgentSwitch")

    // MARK: device pixels

    func testTheStreamAsksForTheDisplaysDevicePixels() {
        let retina = BrowserScreenPolicy.stream(backingScale: 2, displayPoints: CGSize(width: 1512, height: 982))
        XCTAssertEqual(retina, BrowserStreamOptions(maxWidth: 3024, maxHeight: 1964, scale: 2))
        XCTAssertEqual(retina.query, "quality=80&fps=15&maxWidth=3024&maxHeight=1964&scale=2")
        let plain = BrowserScreenPolicy.stream(backingScale: 1, displayPoints: CGSize(width: 1920, height: 1080))
        XCTAssertEqual(plain.query, "quality=80&fps=15&maxWidth=1920&maxHeight=1080", "a display without Retina asks for the CSS size, as before")
        XCTAssertEqual(BrowserScreenPolicy.stream(backingScale: 2, displayPoints: nil).query, "quality=80&fps=15&scale=2")
    }

    func testTheScaleGoesInTheQueryWithinWhatTheDaemonTakes() {
        XCTAssertEqual(BrowserStreamOptions(scale: 1.5).query, "quality=80&fps=15&scale=1.5")
        XCTAssertEqual(BrowserStreamOptions(scale: 9).query, "quality=80&fps=15&scale=8", "8 since the page's zoom (a 2x display at 400 %)")
        XCTAssertEqual(BrowserStreamOptions(scale: 5).query, "quality=80&fps=15&scale=5")
        XCTAssertEqual(BrowserStreamOptions(scale: 1).query, "quality=80&fps=15", "1 is the default: not sent")
        XCTAssertEqual(BrowserStreamOptions(scale: 2.004).query, "quality=80&fps=15&scale=2")
    }

    func testAPageOfTheScreensOwnSizeIsDrawnOneCSSPixelToAPoint() {
        // Held at the screen's size (1013.5 points, rounded down to 1013 CSS pixels), its frame at 2: exactly 1013 points.
        let held = BrowserFrameGeometry(width: 2026, height: 1400, scale: 2)
        XCTAssertEqual(BrowserGeometry.fit(held, in: CGSize(width: 1013.5, height: 700.4)), CGRect(x: 0, y: 0, width: 1013, height: 700))
        // The same at 1 (a daemon from before): one CSS pixel to a point too.
        XCTAssertEqual(BrowserGeometry.fit(BrowserFrameGeometry(width: 1013, height: 700), in: CGSize(width: 1013.5, height: 700.4)),
                       CGRect(x: 0, y: 0, width: 1013, height: 700))
        // A window grown more than that (before the size follows): fitted as before.
        XCTAssertEqual(BrowserGeometry.fit(held, in: CGSize(width: 1200, height: 900)).width, 1200)
        // A page larger than the screen: fitted smaller, as before; the frame's pixels map back the same way.
        let desk = BrowserFrameGeometry(width: 2560, height: 1600, scale: 2)
        XCTAssertEqual(BrowserGeometry.fit(desk, in: CGSize(width: 1000, height: 700)), CGRect(x: 0, y: 0, width: 1000, height: 625))
        XCTAssertEqual(BrowserGeometry.framePoint(CGPoint(x: 500, y: 100), frame: desk, in: CGSize(width: 1000, height: 700)), CGPoint(x: 1280, y: 256))
        // The box of an agent's action (CSS pixels) on a frame at 2 drawn one to one.
        XCTAssertEqual(BrowserGeometry.viewRect(BrowserBox(x: 10, y: 20, width: 100, height: 30), frame: held, in: CGSize(width: 1013.5, height: 700.4)),
                       CGRect(x: 10, y: 20, width: 100, height: 30))
    }

    // MARK: 尺寸有主

    func testYourOwnTabOnScreenIsThisMacsWhileNobodyElseHoldsIt() {
        XCTAssertTrue(BrowserScreenPolicy.claims(BrowserTab(id: "a")))
        XCTAssertFalse(BrowserScreenPolicy.claims(BrowserTab(id: "a", heldBy: "phone-1")), "another screen holds it")
        XCTAssertFalse(BrowserScreenPolicy.claims(BrowserTab(id: "a", heldBy: "mac-main")), "already this Mac's")
        XCTAssertFalse(BrowserScreenPolicy.claims(BrowserTab(id: "a", owner: codex)), "an agent's tab only after Take Over")
        XCTAssertTrue(BrowserScreenPolicy.renews(BrowserTab(id: "a", heldBy: "mac-main"), screen: "mac-main"))
        XCTAssertFalse(BrowserScreenPolicy.renews(BrowserTab(id: "a", owner: codex, heldBy: "mac-main"), screen: "mac-main"),
                       "a take-over of an agent's tab ends after two idle minutes, as before")
        XCTAssertFalse(BrowserScreenPolicy.renews(BrowserTab(id: "a", heldBy: "phone-1"), screen: "mac-main"))
        XCTAssertLessThan(BrowserScreenPolicy.renewal, .seconds(120))
    }

    func testTheFooterSaysNoTakeOverForYourOwnTabOnThisScreen() {
        XCTAssertNil(BrowserScreenPolicy.footerHolder(BrowserTab(id: "a", heldBy: "mac-main"), screen: "mac-main"))
        XCTAssertEqual(BrowserScreenPolicy.footerHolder(BrowserTab(id: "a", owner: codex, heldBy: "mac-main"), screen: "mac-main"), .thisMac)
        XCTAssertEqual(BrowserScreenPolicy.footerHolder(BrowserTab(id: "a", heldBy: "phone-1"), screen: "mac-main"), .elsewhere("phone-1"))
        XCTAssertNil(BrowserScreenPolicy.holdEnded(BrowserTab(id: "a"), reason: .idle, heldBy: nil), "taken again while shown")
        XCTAssertEqual(BrowserScreenPolicy.holdEnded(BrowserTab(id: "a", owner: codex), reason: .idle, heldBy: nil), BrowserTabText.idleHandBack)
        XCTAssertEqual(BrowserScreenPolicy.holdEnded(BrowserTab(id: "a"), reason: .take, heldBy: "phone-1"), "此标签已由其他屏幕接手。")
        XCTAssertNil(BrowserScreenPolicy.holdEnded(BrowserTab(id: "a"), reason: .handBack, heldBy: nil))
    }

    // MARK: the tab list's column

    func testTheListsWidthStaysWithinItsBoundsAndLeavesThePageItsRoom() {
        XCTAssertEqual(BrowserSide.standard.shown(pageWidth: 1280), 290)
        XCTAssertEqual(BrowserSide(width: 100).shown(pageWidth: 1280), 220)
        XCTAssertEqual(BrowserSide(width: 900).shown(pageWidth: 1280), 560)
        XCTAssertEqual(BrowserSide(width: 500).shown(pageWidth: 800), 380, "the page keeps 420")
        XCTAssertEqual(BrowserSide(width: 500).shown(pageWidth: 500), 220, "the least wins on a page too narrow for both")
        XCTAssertEqual(BrowserSide(width: 300.4).shown(pageWidth: 1280), 300)
        XCTAssertEqual(BrowserSide(width: 300, closed: true).shown(pageWidth: 1280), 0, "closed: nothing left")
    }

    func testDraggingTheEdgeResizesAndPastTheLeftCloses() {
        let side = BrowserSide(width: 330)
        XCTAssertEqual(side.dragged(to: 400, pageWidth: 1280), BrowserSide(width: 400))
        XCTAssertEqual(side.dragged(to: 150, pageWidth: 1280), BrowserSide(width: 220), "narrower than the least: the least")
        XCTAssertEqual(side.dragged(to: 119, pageWidth: 1280), BrowserSide(width: 330, closed: true), "let go left of 120: closed, its width kept")
        XCTAssertEqual(side.dragged(to: 1000, pageWidth: 1280), BrowserSide(width: 560))
        XCTAssertEqual(side.dragged(to: 1000, pageWidth: 900), BrowserSide(width: 480))
    }

    func testTheButtonTogglesAndADoubleClickResets() {
        let closed = BrowserSide(width: 400).toggled()
        XCTAssertEqual(closed, BrowserSide(width: 400, closed: true))
        XCTAssertEqual(closed.toggled(), BrowserSide(width: 400), "opens at the width it had")
        XCTAssertEqual(BrowserSide(width: 400).reset(), BrowserSide.standard)
        XCTAssertEqual(closed.reset(), closed, "closed: no edge to double-click")
    }

    func testTheColumnIsRememberedAsTheTerminalPagesIs() throws {
        let side = BrowserSide(width: 333, closed: true)
        XCTAssertEqual(BrowserSide.restored(side.stored), side)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(side.stored.utf8)) as? [String: Any])
        XCTAssertEqual(object["width"] as? Double, 333)
        XCTAssertEqual(object["closed"] as? Bool, true)
        XCTAssertEqual(BrowserSide.restored(nil), .standard)
        XCTAssertEqual(BrowserSide.restored("not json"), .standard)
        XCTAssertEqual(BrowserSide.restored("{\"closed\": true}"), BrowserSide(width: 290, closed: true))
        XCTAssertEqual(BrowserSide.restored("{\"width\": 410}"), BrowserSide(width: 410))
        XCTAssertEqual(BrowserSide.storeKey, "browser.side")
    }
}
