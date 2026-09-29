import XCTest
@testable import AgentSwitchMacCore

/// The Mac window's wheel (docs/terminal-v0.md): what a click, a spin and a swipe become.
final class WheelNotchesTests: XCTestCase {
    func testAWheelClickIsAlwaysANotch() {
        var w = WheelNotches()
        // macOS reports a slow click as a tenth of a line: still one notch, each
        XCTAssertEqual((0..<5).map { _ in w.add(deltaY: 0.1, precise: false, began: false, lineHeight: 18) }, [1, 1, 1, 1, 1])
        XCTAssertEqual(w.add(deltaY: -0.1, precise: false, began: false, lineHeight: 18), -1)
        // a fast spin (macOS speeds it up to ~9 lines an event): a notch per three lines, at most five an event
        XCTAssertEqual(w.add(deltaY: 3.6, precise: false, began: false, lineHeight: 18), 1)
        XCTAssertEqual(w.add(deltaY: -8.99, precise: false, began: false, lineHeight: 18), -3)
        XCTAssertEqual(w.add(deltaY: 40, precise: false, began: false, lineHeight: 18), 5)
    }

    func testASwipeIsANotchAtOnceThenOnePerThreeLines() {
        var w = WheelNotches()
        XCTAssertEqual(w.add(deltaY: 4, precise: true, began: true, lineHeight: 18), 1)
        // 216 points more: four notches of 54
        let rest = (0..<36).map { _ in w.add(deltaY: 6, precise: true, began: false, lineHeight: 18) }
        XCTAssertEqual(rest.reduce(0, +), 4)
        // momentum goes on the same way; turning round starts afresh
        XCTAssertEqual(w.add(deltaY: 60, precise: true, began: false, lineHeight: 18), 1)
        XCTAssertEqual(w.add(deltaY: -30, precise: true, began: false, lineHeight: 18), 0)
        XCTAssertEqual(w.add(deltaY: -30, precise: true, began: false, lineHeight: 18), -1)
        XCTAssertEqual(w.add(deltaY: 0, precise: true, began: false, lineHeight: 18), 0)
    }

    func testToolbarIconsAreWholeCellSprites() {
        XCTAssertTrue(PixelArt.toolbarList.allSatisfy { $0.count == 18 })
        XCTAssertEqual(PixelArt.toolbarList.count, 14)
        XCTAssertTrue(PixelArt.toolbarNew.allSatisfy { $0.count == 13 })
        XCTAssertEqual(PixelArt.toolbarNew.count, 13)
    }
}
