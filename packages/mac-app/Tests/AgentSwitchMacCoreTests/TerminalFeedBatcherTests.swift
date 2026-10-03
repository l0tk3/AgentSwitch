import XCTest
@testable import AgentSwitchMacCore

/// The terminal screen's output on its way in (docs/app-v0.md §4, 2026-10-03): as it comes while the screen is seen,
/// held and fed together while it is not, never dropped or reordered.
final class TerminalFeedBatcherTests: XCTestCase {
    private let t0 = ContinuousClock.now

    func testSeenGoesInAsItComes() {
        var b = TerminalFeedBatcher()
        XCTAssertEqual(b.receive("a", seen: true, at: t0), .feed("a"))
        XCTAssertEqual(b.receive("b", seen: true, at: t0), .feed("b"))
        XCTAssertFalse(b.holding)
        XCTAssertNil(b.flush())
    }

    func testNotSeenWaitsAQuarterOfASecondAtMost() {
        var b = TerminalFeedBatcher()
        XCTAssertEqual(b.receive("a", seen: false, at: t0), .wait(until: t0.advanced(by: .milliseconds(250))))
        XCTAssertEqual(b.receive("b", seen: false, at: t0.advanced(by: .milliseconds(10))), .waiting, "the first piece's flush is due")
        XCTAssertEqual(b.receive("c", seen: false, at: t0.advanced(by: .milliseconds(20))), .waiting)
        XCTAssertTrue(b.holding)
        XCTAssertEqual(b.flush(), "abc", "in order, together")
        XCTAssertFalse(b.holding)
        // The next piece starts a new wait.
        XCTAssertEqual(b.receive("d", seen: false, at: t0.advanced(by: .seconds(1))), .wait(until: t0.advanced(by: .milliseconds(1250))))
    }

    func testSeenAgainTakesWhatWaitedFirst() {
        var b = TerminalFeedBatcher()
        _ = b.receive("\u{1b}[2J", seen: false, at: t0)
        _ = b.receive("hello", seen: false, at: t0)
        XCTAssertEqual(b.receive(" world", seen: true, at: t0), .feed("\u{1b}[2Jhello world"))
        XCTAssertFalse(b.holding)
    }

    func testALotWaitingGoesInAtOnce() {
        var b = TerminalFeedBatcher()
        let chunk = String(repeating: "x", count: 16 * 1024)
        XCTAssertEqual(b.receive(chunk, seen: false, at: t0), .wait(until: t0.advanced(by: TerminalFeedBatcher.holdFor)))
        XCTAssertEqual(b.receive(chunk, seen: false, at: t0), .waiting)
        XCTAssertEqual(b.receive(chunk, seen: false, at: t0), .waiting)
        XCTAssertEqual(b.receive(chunk, seen: false, at: t0), .feed(String(repeating: "x", count: 64 * 1024)))
        XCTAssertFalse(b.holding)
    }

    func testBytesNotCharactersCount() {
        var b = TerminalFeedBatcher()
        // 3 bytes a character: 64 KiB of UTF-8 is reached with a third as many characters.
        let wide = String(repeating: "中", count: 21 * 1024)          // 64 512 bytes: waits
        let more = String(repeating: "中", count: 512)                // 1 536 bytes more: over 64 KiB
        XCTAssertEqual(b.receive(wide, seen: false, at: t0), .wait(until: t0.advanced(by: TerminalFeedBatcher.holdFor)))
        XCTAssertEqual(b.receive(more, seen: false, at: t0), .feed(wide + more))
    }

    func testDropForgetsWhatWaited() {
        var b = TerminalFeedBatcher()
        _ = b.receive("old screen", seen: false, at: t0)
        b.drop()
        XCTAssertFalse(b.holding)
        XCTAssertNil(b.flush())
        XCTAssertEqual(b.receive("new", seen: false, at: t0), .wait(until: t0.advanced(by: TerminalFeedBatcher.holdFor)))
    }
}
