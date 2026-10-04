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

    /// The menu bar's one-colour mark (docs/ui-v0.md §10): the front window as a solid panel, its prompt cut out, the
    /// edge of a window behind it.
    func testTheMenuBarsMarkIsTheStack() {
        XCTAssertEqual(PixelArt.stackRows.count, PixelArt.markHeight)
        XCTAssertTrue(PixelArt.stackRows.allSatisfy { $0.count == PixelArt.markWidth })
        let cells = PixelArt.stackCells
        XCTAssertEqual(cells.count, PixelArt.stackRows.joined().filter { $0 != "." }.count, "every character is a part")
        let panel = cells.filter { $0.part == .panel }, prompt = cells.filter { $0.part == .prompt }, behind = cells.filter { $0.part == .behind }
        // The panel with its prompt is the pixel app icon's front window: 12 × 9, the corners clipped; the prompt is a
        // `>` of five rows, two cells wide, and a cursor of four cells on its last row.
        XCTAssertEqual(panel.count + prompt.count, 12 * 9 - 4)
        XCTAssertEqual(prompt.count, 14)
        XCTAssertEqual(Set(prompt.map(\.y)), [4, 5, 6, 7, 8])
        XCTAssertTrue(behind.allSatisfy { $0.y == 0 || $0.x == 13 }, "the window behind is an edge above and to the right")
        let shown = { (state: PixelArt.MarkState, full: Bool?) in cells.filter { PixelArt.stackShows($0, in: state) == full } }
        // Idle: the panel in full, the prompt a hole, the window behind faint.
        XCTAssertEqual(shown(.idle, true), panel)
        XCTAssertEqual(shown(.idle, nil), prompt)
        XCTAssertEqual(shown(.idle, false), behind)
        // Busy: the window behind in full too.
        XCTAssertEqual(Set(shown(.busy, true).map { "\($0.x),\($0.y)" }), Set((panel + behind).map { "\($0.x),\($0.y)" }))
        XCTAssertEqual(shown(.busy, nil), prompt)
        // Waiting or an error: the prompt lit, everything else faint.
        for state in [PixelArt.MarkState.waiting, .error] {
            XCTAssertEqual(shown(state, true), prompt)
            XCTAssertTrue(shown(state, nil).isEmpty)
        }
        // A part shows as its cells do, the dither aside: what the classic look's smooth drawing goes by.
        for state in [PixelArt.MarkState.idle, .busy, .waiting, .error] {
            for cell in cells { XCTAssertEqual(PixelArt.stackShows(cell.part, in: state), PixelArt.stackShows(cell, in: state)) }
        }
        XCTAssertEqual(PixelArt.stackShows(.panel, in: .off), true)
        XCTAssertEqual(PixelArt.stackShows(.behind, in: .off), false)
        XCTAssertNil(PixelArt.stackShows(.prompt, in: .off))
        // Off: the idle picture with every other cell gone.
        let kept = cells.filter { PixelArt.stackShows($0, in: .off) != nil }
        XCTAssertTrue(!kept.isEmpty && kept.allSatisfy { $0.part != .prompt && ($0.x + $0.y) % 2 == 0 })
        XCTAssertTrue(kept.allSatisfy { PixelArt.stackShows($0, in: .off) == ($0.part == .panel) })
    }
}
