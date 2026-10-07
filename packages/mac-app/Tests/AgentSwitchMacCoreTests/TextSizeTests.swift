import XCTest
@testable import AgentSwitchMacCore

/// The conversation's text size as it is set (2026-10-07, user: 设置里加上字体调节).
final class TextSizeTests: XCTestCase {
    func testAStepIsAPointAroundTheLooksOwnSize() {
        XCTAssertEqual(TextSize.size(14, step: 0), 14)
        XCTAssertEqual(TextSize.size(14, step: 2), 16)
        XCTAssertEqual(TextSize.size(12, step: -2), 10)
        XCTAssertEqual(TextSize.size(13.5, step: 1), 14.5)
        // No further than the setting goes, whatever is kept.
        XCTAssertEqual(TextSize.size(14, step: 40), 18)
        XCTAssertEqual(TextSize.size(14, step: -40), 12)
        XCTAssertEqual(TextSize.clamp(9), 4)
        XCTAssertEqual(TextSize.clamp(-9), -2)
        // Never too small to read.
        XCTAssertEqual(TextSize.size(10, step: -2), 9)
    }

    func testTheSettingNamesAStepByTheSizeOfAnAnswer() {
        XCTAssertEqual(TextSize.label(prose: 14, step: 0), "14 pt")
        XCTAssertEqual(TextSize.label(prose: 14, step: -1), "13 pt")
        XCTAssertEqual(TextSize.label(prose: 13.5, step: 0), "13.5 pt")
        XCTAssertEqual(TextSize.label(prose: 13.5, step: 4), "17.5 pt")
    }
}
