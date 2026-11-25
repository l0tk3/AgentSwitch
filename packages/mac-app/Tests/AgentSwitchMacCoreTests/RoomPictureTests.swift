import XCTest
@testable import AgentSwitchMacCore

/// A room's picture is its members' as bubbles (user #412, #422).
final class RoomPictureTests: XCTestCase {
    func testTheBubblesStayInTheBoxAndApartAndGetSmaller() {
        XCTAssertEqual(RoomPictureLayout.spots(0), [])
        XCTAssertEqual(RoomPictureLayout.spots(9).count, 4)
        for n in 1...4 {
            let spots = RoomPictureLayout.spots(n)
            XCTAssertEqual(spots.count, n)
            XCTAssertEqual(spots.map(\.side), spots.map(\.side).sorted(by: >), "the first member's is the biggest")
            for s in spots { XCTAssertTrue(s.x >= 0 && s.y >= 0 && s.x + s.side <= 1.0001 && s.y + s.side <= 1.0001) }
            for (i, a) in spots.enumerated() {
                for b in spots[(i + 1)...] {
                    // As squares (the pixel look): apart on one axis at least.
                    XCTAssertTrue(a.x + a.side <= b.x + 0.0001 || b.x + b.side <= a.x + 0.0001 || a.y + a.side <= b.y + 0.0001 || b.y + b.side <= a.y + 0.0001, "\(n): \(a) over \(b)")
                }
            }
        }
    }
}
