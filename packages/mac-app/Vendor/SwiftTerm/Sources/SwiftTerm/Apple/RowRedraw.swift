//
// RowRedraw.swift: AgentSwitch's patch (PATCHES.md, "Rows drawn again only when they changed").
//
import Foundation

/// Which rows of the terminal's update range are sent to be drawn again.
///
/// The update range is one span, from the first row touched to the last, and moving the cursor touches a row. A program
/// that homes the cursor, writes one cell and parks the cursor on the last row (Claude Code's status line, eleven times
/// a second) so marks the whole screen though one row changed. Each row's line keeps a counter of its changes
/// (`BufferLine.generation`: cells, wrapping, render mode, images). A row is drawn again when its line is another one or
/// has changed since the row was last sent to be drawn, or when it was asked for outright (`Terminal.refresh`,
/// `Terminal.updateFullScreen`: colours, a link under the pointer — what changed is not in the cells).
struct RowRedraw {
    private struct Mark {
        /// Held, not compared by address alone: a line freed and another made at its address would pass for it.
        let line: BufferLine
        let generation: UInt64
    }

    /// By screen row: the line sent to be drawn there last, and its counter then.
    private var marks: [Mark?] = []

    /// Nothing is known of what is on screen (scrolled back, another renderer drew it).
    mutating func reset() {
        marks.removeAll(keepingCapacity: true)
    }

    /// The runs of rows within `range` to draw again, top down; they are taken as drawn from here on. `rows`: the
    /// screen's (another count: nothing is known of it). `line`: the line shown on a screen row now.
    mutating func runs(in range: ClosedRange<Int>, forced: ClosedRange<Int>?, rows: Int, line: (Int) -> BufferLine?) -> [ClosedRange<Int>] {
        if marks.count != rows { marks = Array(repeating: nil, count: max(0, rows)) }
        let first = max(0, range.lowerBound)
        let last = min(rows - 1, range.upperBound)
        guard first <= last else { return [] }
        var runs: [ClosedRange<Int>] = []
        var start: Int?
        for row in first...last {
            let now = line(row).map { Mark(line: $0, generation: $0.generation) }
            let was = marks[row]
            marks[row] = now
            let same = now.flatMap { now in was.map { $0.line === now.line && $0.generation == now.generation } } ?? false
            if !same || (forced?.contains(row) ?? false) {
                if start == nil { start = row }
            } else if let from = start {
                runs.append(from...(row - 1))
                start = nil
            }
        }
        if let from = start { runs.append(from...last) }
        return runs
    }
}
