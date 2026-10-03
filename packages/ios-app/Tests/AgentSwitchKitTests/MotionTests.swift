import XCTest
@testable import AgentSwitchKit

/// What moves on screen moves only with something to show, every mark on one beat (docs/ui-v0.md §7.4, 2026-10-03).
final class MotionTests: XCTestCase {
    func testStepsCountFromOneEpochSoMarksStepTogether() {
        let at = Motion.epoch.addingTimeInterval(Motion.spinner * 1_000_003)
        XCTAssertEqual(Motion.step(at: at, every: Motion.spinner), 1_000_003, "a step's own moment is that step")
        XCTAssertEqual(Motion.step(at: at.addingTimeInterval(-0.001), every: Motion.spinner), 1_000_002)
        XCTAssertEqual(Motion.step(at: at.addingTimeInterval(Motion.spinner - 0.001), every: Motion.spinner), 1_000_003)
        // The blink and the caret: two steps a cycle.
        let blink = Motion.epoch.addingTimeInterval(Motion.blink * 40)
        XCTAssertEqual(Motion.step(at: blink, every: Motion.blink) % 2, 0)
        XCTAssertEqual(Motion.step(at: blink.addingTimeInterval(0.6), every: Motion.blink) % 2, 1)
        XCTAssertEqual([Motion.spinner, Motion.blink, Motion.run, Motion.caret], [0.09, 0.55, 0.14, 0.5])
    }

    func testOnlyBusyAndWaitingMarksMove() {
        XCTAssertEqual(PixelArt.MarkState.busy.motionInterval, Motion.run)
        XCTAssertEqual(PixelArt.MarkState.waiting.motionInterval, Motion.blink)
        XCTAssertNil(PixelArt.MarkState.idle.motionInterval)
        XCTAssertNil(PixelArt.MarkState.error.motionInterval)
        XCTAssertNil(PixelArt.MarkState.off.motionInterval)
    }
}
