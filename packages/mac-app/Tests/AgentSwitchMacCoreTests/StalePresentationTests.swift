import XCTest
@testable import AgentSwitchMacCore

/// Only full screen asks the system to hide the menu bar while AgentSwitch is in front (AppKit does it for a window
/// that is full screen). A request that still stands when no window is full screen is left over and is taken back
/// (2026-10-05: the menu bar hid whenever the app came to the front, in an ordinary window, until the app was restarted).
final class StalePresentationTests: XCTestCase {
    func testARequestWithoutAFullScreenWindowIsLeftOver() {
        XCTAssertFalse(StalePresentation.isStale(options: 0, anyWindowFullScreen: false))
        XCTAssertFalse(StalePresentation.isStale(options: 0, anyWindowFullScreen: true))
        // Full screen's own: full screen, the menu bar and the Dock hiding themselves.
        XCTAssertFalse(StalePresentation.isStale(options: 1029, anyWindowFullScreen: true))
        XCTAssertTrue(StalePresentation.isStale(options: 1029, anyWindowFullScreen: false))
        XCTAssertTrue(StalePresentation.isStale(options: 5, anyWindowFullScreen: false))
    }

    func testItIsTakenBackOnlyWhenSeenTwiceRunning() {
        // Entering and leaving full screen pass through such a moment: once is not enough.
        var watch = StalePresentation.Watch()
        XCTAssertFalse(watch.shouldReset(options: 1029, anyWindowFullScreen: false))
        XCTAssertTrue(watch.shouldReset(options: 1029, anyWindowFullScreen: false))
        // Taken back: the count starts again.
        XCTAssertFalse(watch.shouldReset(options: 5, anyWindowFullScreen: false))
        XCTAssertFalse(watch.shouldReset(options: 1029, anyWindowFullScreen: true))
        XCTAssertFalse(watch.shouldReset(options: 5, anyWindowFullScreen: false))
        XCTAssertFalse(watch.shouldReset(options: 0, anyWindowFullScreen: false))
        XCTAssertFalse(watch.shouldReset(options: 5, anyWindowFullScreen: false))
        XCTAssertTrue(watch.shouldReset(options: 5, anyWindowFullScreen: false))
    }
}
