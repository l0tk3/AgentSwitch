// AgentSwitch's patch "Rows drawn again only when they changed" (PATCHES.md): which rows of the terminal's update
// range the Mac view sends to be drawn.
import XCTest
@testable import SwiftTerm

final class RowRedrawTests: XCTestCase {
    private final class Quiet: TerminalDelegate {
        func send(source: Terminal, data: ArraySlice<UInt8>) {}
    }

    private let quiet = Quiet()
    private let esc = "\u{1b}"

    private func terminal(cols: Int = 40, rows: Int = 10) -> Terminal {
        let terminal = Terminal(delegate: quiet, options: TerminalOptions(cols: cols, rows: rows))
        terminal.feed(text: (1...rows).map { "line \($0)" }.joined(separator: "\r\n"))
        return terminal
    }

    /// What the view does with a piece of output: the terminal's range, cut to the rows to draw again.
    private func redrawn(_ terminal: Terminal, _ redraw: inout RowRedraw) -> [ClosedRange<Int>] {
        guard let (start, end) = terminal.getUpdateRange() else { return [] }
        let forced = terminal.getForcedUpdateRange().map { $0.startY...$0.endY }
        terminal.clearUpdateRange()
        return redraw.runs(in: start...end, forced: forced, rows: terminal.rows) { terminal.getLine(row: $0) }
    }

    /// Claude Code's status line, eleven times a second (recorded 2026-10-05): home, down to its row, one glyph, the
    /// cursor parked on the last row. The terminal's range is the whole screen; one row changed.
    func testACursorThatCrossesTheScreenToChangeOneCellRedrawsThatRow() {
        let terminal = terminal()
        var redraw = RowRedraw()
        XCTAssertEqual(redrawn(terminal, &redraw), [0...9], "the first picture is all of it")
        terminal.feed(text: "\(esc)[?25l\(esc)[H\r\(esc)[5B*\(esc)[10;1H\(esc)[7;3H\(esc)[?25h")
        let range = terminal.getUpdateRange()
        XCTAssertEqual(range?.startY, 0)
        XCTAssertEqual(range?.endY, 9, "the cursor's way marks the screen from top to bottom")
        XCTAssertEqual(redrawn(terminal, &redraw), [5...5])
        // The cursor alone: nothing to draw (the caret is a view of its own).
        terminal.feed(text: "\(esc)[H\(esc)[10;1H")
        XCTAssertEqual(redrawn(terminal, &redraw), [])
    }

    func testRowsChangedApartAreRunsOfTheirOwn() {
        let terminal = terminal()
        var redraw = RowRedraw()
        _ = redrawn(terminal, &redraw)
        terminal.feed(text: "\(esc)[3;1Ha\(esc)[4;1Hb\(esc)[8;1Hc")
        XCTAssertEqual(redrawn(terminal, &redraw), [2...3, 7...7])
    }

    /// A row written again is drawn again even with the same text: the line's counter says written, not different.
    func testARowWrittenAgainIsDrawnAgain() {
        let terminal = terminal()
        var redraw = RowRedraw()
        _ = redrawn(terminal, &redraw)
        terminal.feed(text: "\(esc)[6;1Hline 6")
        XCTAssertEqual(redrawn(terminal, &redraw), [5...5])
    }

    /// Asked for outright — colours, a link under the pointer, the selection: what changed is not in the cells.
    func testRowsAskedForOutrightAreDrawnThoughNothingInThemChanged() {
        let terminal = terminal()
        var redraw = RowRedraw()
        _ = redrawn(terminal, &redraw)
        terminal.refresh(startRow: 2, endRow: 3)
        XCTAssertEqual(redrawn(terminal, &redraw), [2...3])
        terminal.updateFullScreen()
        XCTAssertEqual(redrawn(terminal, &redraw), [0...9])
        // Asked once: not again with the next output.
        terminal.feed(text: "\(esc)[H\(esc)[2;1Hx\(esc)[10;1H")
        XCTAssertNil(terminal.getForcedUpdateRange())
        XCTAssertEqual(redrawn(terminal, &redraw), [1...1])
    }

    func testScrollingDrawsEveryRowAgain() {
        let terminal = terminal()
        var redraw = RowRedraw()
        _ = redrawn(terminal, &redraw)
        terminal.feed(text: "\(esc)[10;1H\r\nline 11")
        XCTAssertEqual(redrawn(terminal, &redraw), [0...9])
    }

    func testNothingKnownOfTheScreenDrawsTheWholeRange() {
        let terminal = terminal()
        var redraw = RowRedraw()
        _ = redrawn(terminal, &redraw)
        redraw.reset()
        terminal.feed(text: "\(esc)[H\(esc)[5;1Hx\(esc)[10;1H")
        XCTAssertEqual(redrawn(terminal, &redraw), [0...9])
        // Another size: the same.
        terminal.resize(cols: 40, rows: 8)
        terminal.clearUpdateRange()
        terminal.feed(text: "\(esc)[H\(esc)[5;1Hy\(esc)[8;1H")
        XCTAssertEqual(redrawn(terminal, &redraw), [0...7])
        terminal.feed(text: "\(esc)[H\(esc)[5;1Hz\(esc)[8;1H")
        XCTAssertEqual(redrawn(terminal, &redraw), [4...4])
    }

    /// A range that reaches past the screen (`updateFullScreen` ends at `rows`) is cut to it.
    func testARangePastTheScreenIsCutToIt() {
        let terminal = terminal()
        var redraw = RowRedraw()
        XCTAssertEqual(redraw.runs(in: -2...10, forced: 0...10, rows: 10) { terminal.getLine(row: $0) }, [0...9])
        XCTAssertEqual(redraw.runs(in: 12...14, forced: nil, rows: 10) { terminal.getLine(row: $0) }, [])
    }
}
