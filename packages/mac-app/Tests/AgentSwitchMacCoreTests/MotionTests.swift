import XCTest
@testable import AgentSwitchMacCore

/// What moves on screen moves only while seen and only with something to show (docs/ui-v0.md §7.4, 2026-10-03).
final class MotionTests: XCTestCase {
    private let shown = Motion.Place(inWindow: true, windowVisible: true, occluded: false, miniaturized: false, hidden: false)

    func testSeenOnlyOnScreenAndNotHidden() {
        XCTAssertTrue(shown.seen)
        var p = shown
        p.inWindow = false
        XCTAssertFalse(p.seen, "not in a window yet, or its window closing")
        p = shown
        p.windowVisible = false
        XCTAssertFalse(p.seen, "the window closed (ordered out), the menu panel shut")
        p = shown
        p.occluded = true
        XCTAssertFalse(p.seen, "covered by other windows, the app hidden, another Space")
        p = shown
        p.miniaturized = true
        XCTAssertFalse(p.seen, "minimised")
        p = shown
        p.hidden = true
        XCTAssertFalse(p.seen, "another page of the main window")
    }

    func testStepsCountFromOneEpochSoMarksStepTogether() {
        // The same step at the same moment wherever a mark was created; a step's own moment is that step.
        let at = Motion.epoch.addingTimeInterval(Motion.spinner * 1_000_003)
        XCTAssertEqual(Motion.step(at: at, every: Motion.spinner), 1_000_003)
        XCTAssertEqual(Motion.step(at: at.addingTimeInterval(-0.001), every: Motion.spinner), 1_000_002)
        XCTAssertEqual(Motion.step(at: at.addingTimeInterval(Motion.spinner - 0.001), every: Motion.spinner), 1_000_003)
        // The blink: two steps over 1.1 s.
        let blink = Motion.epoch.addingTimeInterval(Motion.blink * 40)
        XCTAssertEqual(Motion.step(at: blink, every: Motion.blink) % 2, 0)
        XCTAssertEqual(Motion.step(at: blink.addingTimeInterval(0.6), every: Motion.blink) % 2, 1)
        XCTAssertEqual([Motion.spinner, Motion.blink, Motion.run], [0.09, 0.55, 0.14])
    }

    func testOnlyBusyAndWaitingMarksMove() {
        XCTAssertEqual(PixelArt.MarkState.busy.motionInterval, 0.14)
        XCTAssertEqual(PixelArt.MarkState.waiting.motionInterval, 0.55)
        XCTAssertNil(PixelArt.MarkState.idle.motionInterval)
        XCTAssertNil(PixelArt.MarkState.error.motionInterval)
        XCTAssertNil(PixelArt.MarkState.off.motionInterval)
    }

    func testClocksTurnAtTheirOwnSeconds() throws {
        let a = Date(timeIntervalSince1970: 1_790_000_000.25)
        let b = Date(timeIntervalSince1970: 1_790_000_000.70)
        let now = Date(timeIntervalSince1970: 1_790_000_010.50)
        // The next turn of either clock, a hair after its second.
        let next = try XCTUnwrap(ClockTicks.next(after: now, origins: [a, b]))
        XCTAssertEqual(next.timeIntervalSince1970, 1_790_000_010.70 + ClockTicks.lead, accuracy: 1e-6)
        // Read at that moment, the clock already shows the new second (0:10 → 0:11 for b).
        XCTAssertEqual(Int(next.timeIntervalSince(b)), 10)
        XCTAssertEqual(Int(next.addingTimeInterval(-0.002).timeIntervalSince(b)), 9)
        XCTAssertNil(ClockTicks.next(after: now, origins: []))
    }

    func testATurnIsNeverRepeated() throws {
        let origin = Date(timeIntervalSince1970: 1_790_000_000.123)
        var at = Date(timeIntervalSince1970: 1_790_000_000.5)
        var seen: [Date] = []
        for _ in 0..<50 {
            let next = try XCTUnwrap(ClockTicks.next(after: at, origins: [origin]))
            XCTAssertGreaterThan(next, at)
            XCTAssertEqual(next.timeIntervalSince(at), seen.isEmpty ? next.timeIntervalSince(at) : 1, accuracy: 1e-6)
            seen.append(next)
            at = next
        }
    }

    func testACountdownStopsOnceItSaysExpired() {
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        let expires = start.addingTimeInterval(3.4)
        let moments = Array(ClockTicks.moments(from: start, origins: [expires], until: expires))
        // Drawn at once, then as 4 → 3 → 2 → 1 → 0 (Expired), then nothing.
        XCTAssertEqual(moments.count, 5)
        XCTAssertEqual(moments.first, start)
        XCTAssertEqual(moments.last!.timeIntervalSince(expires), ClockTicks.lead, accuracy: 1e-6)
        let shown = moments.map { Int(max(0, expires.timeIntervalSince($0)).rounded(.up)) }
        XCTAssertEqual(shown, [4, 3, 2, 1, 0])
    }

    func testAClockWithoutAnEndGoesOn() {
        let start = Date(timeIntervalSince1970: 1_790_000_000.9)
        let iterator = ClockTicks.moments(from: start, origins: [Date(timeIntervalSince1970: 1_790_000_000)])
        let first = Array((0..<100).compactMap { _ in iterator.next() })
        XCTAssertEqual(first.count, 100)
        XCTAssertEqual(first[1].timeIntervalSince1970, 1_790_000_001 + ClockTicks.lead, accuracy: 1e-6)
    }
}
