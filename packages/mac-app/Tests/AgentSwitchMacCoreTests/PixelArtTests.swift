import XCTest
@testable import AgentSwitchMacCore

/// The pixel mark (docs/ui-v0.md §7.3): the same shape as the terminal page's pixel.js, and its states.
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
        XCTAssertEqual(PixelArt.markState(.ok), .idle)
        XCTAssertEqual(PixelArt.markState(.ok, waiting: 2), .waiting)
        XCTAssertEqual(PixelArt.markState(.busy), .busy)
        XCTAssertEqual(PixelArt.markState(.warning), .waiting)
        XCTAssertEqual(PixelArt.markState(.error), .error)
        XCTAssertEqual(PixelArt.markState(.off), .off)
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

    /// The menu bar's one-colour mark (docs/ui-v0.md §10): three windows, the front one's title bar where a state shows.
    func testTheMenuBarsMarkIsTheStack() {
        XCTAssertEqual(PixelArt.stackRows.count, PixelArt.markHeight)
        XCTAssertTrue(PixelArt.stackRows.allSatisfy { $0.count == PixelArt.markWidth })
        let cells = PixelArt.stackCells
        XCTAssertEqual(cells.count, PixelArt.stackRows.joined().filter { $0 != "." }.count, "every character is a part")
        let title = cells.filter { $0.part == .title }
        XCTAssertEqual(title.count, 18)
        XCTAssertTrue(title.allSatisfy { $0.y == 4 || $0.y == 5 })
        XCTAssertTrue(PixelArt.stackBlock.allSatisfy { at in title.contains { $0.x == at.x && $0.y == at.y } }, "the block sits on the title bar")
        let full = { (state: PixelArt.MarkState) in cells.filter { PixelArt.stackShows($0, in: state) == true } }
        // Idle: the front window in full. Busy: its frame and the block. Waiting or an error: its title bar alone.
        XCTAssertEqual(full(.idle).count, cells.filter { $0.part != .behind }.count)
        XCTAssertEqual(full(.busy).count, cells.filter { $0.part == .frame }.count + PixelArt.stackBlock.count)
        XCTAssertEqual(full(.waiting), title)
        XCTAssertEqual(full(.error), title)
        // Nothing is gone but when off, and then every other cell.
        for state in [PixelArt.MarkState.idle, .busy, .waiting, .error] { XCTAssertFalse(cells.contains { PixelArt.stackShows($0, in: state) == nil }) }
        let gone = cells.filter { PixelArt.stackShows($0, in: .off) == nil }
        XCTAssertTrue(!gone.isEmpty && gone.count < cells.count)
        XCTAssertTrue(gone.allSatisfy { ($0.x + $0.y) % 2 == 1 })
    }
}
