import XCTest
@testable import AgentSwitchKit

/// The pixel mark (docs/ui-v0.md §7.3): the same shape as the terminal page's pixel.js and the Mac's PixelArt, and its
/// states.
final class PixelArtTests: XCTestCase {
    func testTheMarkIsTheIconsSwitch() {
        XCTAssertEqual(PixelArt.markRows.count, PixelArt.markHeight)
        XCTAssertTrue(PixelArt.markRows.allSatisfy { $0.count == PixelArt.markWidth })
        // the source, the lit lane and its end are lit; the other two lanes are not
        let lit = PixelArt.markCells.filter(\.lit)
        XCTAssertEqual(lit.count, 9 + 8 + 9)
        XCTAssertEqual(PixelArt.markCells.filter(\.end).count, 9)
        // the busy block runs along lit cells only
        let litPlaces = Set(lit.map { "\($0.x),\($0.y)" })
        XCTAssertTrue(PixelArt.laneA.allSatisfy { litPlaces.contains("\($0.x),\($0.y)") })
    }

    func testHalfLitPixelsSmoothTheDiagonalSteps() {
        let places = PixelArt.markSmoothing.map { "\($0.x),\($0.y)" }
        // both inside corners of each step of the two diagonal lanes (the same cells pixel.js finds)
        XCTAssertEqual(Set(places), ["5,1", "4,2", "6,2", "3,3", "5,3", "3,7", "5,7", "4,8", "6,8", "5,9"])
        XCTAssertEqual(PixelArt.markSmoothing.filter(\.lit).count, 5)
    }

    func testStates() {
        XCTAssertEqual(PixelArt.markState(reachable: true, waiting: 0, busy: false), .idle)
        XCTAssertEqual(PixelArt.markState(reachable: true, waiting: 2, busy: true), .waiting)
        XCTAssertEqual(PixelArt.markState(reachable: true, waiting: 0, busy: true), .busy)
        XCTAssertEqual(PixelArt.markState(reachable: false, waiting: 1, busy: true), .off)
        // off: dithered to half
        let kept = PixelArt.markCells.filter { !PixelArt.dithered($0) }.count
        XCTAssertTrue(kept > 0 && kept < PixelArt.markCells.count)
    }

    func testSprites() {
        XCTAssertEqual(PixelArt.sprite(PixelArt.square).count, 16)
        XCTAssertEqual(PixelArt.sprite(PixelArt.hollow).count, 12)
        XCTAssertEqual(Set(PixelArt.agents.keys), ["claude-code", "codex", "opencode", "pi"])
        XCTAssertTrue(PixelArt.agents.values.allSatisfy { $0.count == 5 && $0.allSatisfy { $0.count == 5 } })
        // the terminals tab is not Codex's >_ (one icon, one meaning)
        XCTAssertNotEqual(PixelArt.terminalWindow, PixelArt.agents["codex"])
    }
}
