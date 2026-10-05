// AgentSwitch's patch "Rows drawn again only when they changed" (PATCHES.md): the screen kept up by drawing only what
// the view sends to be drawn is, pixel for pixel, the screen drawn whole — after every step of many kinds of output.
#if os(macOS)
import AppKit
import XCTest
@testable import SwiftTerm

/// Takes note of what it is asked to draw again instead of asking AppKit.
private final class RecordingTerminalView: TerminalView {
    var dirty: [NSRect] = []

    override func setNeedsDisplay(_ invalidRect: NSRect) {
        dirty.append(invalidRect)
    }

    override var needsDisplay: Bool {
        get { super.needsDisplay }
        set { if newValue { dirty.append(bounds) } }
    }
}

/// A fixed sequence of numbers: the same steps every run.
private struct Steps {
    var state: UInt64

    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state >> 33
    }

    mutating func upTo(_ n: Int) -> Int { Int(next() % UInt64(max(1, n))) }
    mutating func pick<T>(_ items: [T]) -> T { items[upTo(items.count)] }
}

final class RowRedrawPixelTests: XCTestCase {
    private let esc = "\u{1b}"
    private let size = NSSize(width: 560, height: 336)

    private func bitmap() -> NSBitmapImageRep {
        NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4,
                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    }

    /// As AppKit draws a view: the rect it was asked for, and nothing outside it.
    private func draw(_ view: TerminalView, _ rect: NSRect, into rep: NSBitmapImageRep) {
        let context = NSGraphicsContext(bitmapImageRep: rep)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.clip(to: rect)
        view.draw(rect)
        NSGraphicsContext.restoreGraphicsState()
    }

    private func same(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep) -> Bool {
        memcmp(a.bitmapData!, b.bitmapData!, a.bytesPerRow * a.pixelsHigh) == 0
    }

    /// The first row (from the top) where the two differ, for the failure's words.
    private func firstDifferentRow(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep, cell: CGFloat) -> Int {
        for y in 0..<a.pixelsHigh where memcmp(a.bitmapData! + y * a.bytesPerRow, b.bitmapData! + y * b.bytesPerRow, a.bytesPerRow) != 0 {
            return Int(CGFloat(y) / cell)
        }
        return -1
    }

    private func screen() -> (view: RecordingTerminalView, shown: NSBitmapImageRep) {
        let view = RecordingTerminalView(frame: NSRect(origin: .zero, size: size))
        let shown = bitmap()
        view.getTerminal().clearUpdateRange()
        view.dirty = []
        draw(view, view.bounds, into: shown)
        return (view, shown)
    }

    /// One piece of output as the view takes it: into the terminal, the display brought up to date, and only what the
    /// view asked for drawn on the screen.
    private func feed(_ text: String, to view: RecordingTerminalView, shown: NSBitmapImageRep) {
        view.getTerminal().feed(text: text)
        view.updateDisplay(notifyAccessibility: false)
        let asked = view.dirty.reduce(NSRect.null) { $0.union($1) }.intersection(view.bounds)
        view.dirty = []
        if !asked.isEmpty { draw(view, asked, into: shown) }
    }

    private func whole(_ view: TerminalView) -> NSBitmapImageRep {
        let fresh = bitmap()
        draw(view, view.bounds, into: fresh)
        return fresh
    }

    private func words(_ steps: inout Steps) -> String {
        let pieces = ["status", "✻ Computing…", "中文字符", "──────────", "│ > │", "█▓▒░", "abc def", "⏺ Read(file.swift)", "→ 完成", "0123456789", "wide：全角", "Ωµπ"]
        return steps.pick(pieces)
    }

    private func colour(_ steps: inout Steps) -> String {
        switch steps.upTo(6) {
        case 0: return "\(esc)[0m"
        case 1: return "\(esc)[38;2;\(steps.upTo(256));\(steps.upTo(256));\(steps.upTo(256))m"
        case 2: return "\(esc)[48;5;\(steps.upTo(256))m"
        case 3: return "\(esc)[1;3\(steps.upTo(8))m"
        case 4: return "\(esc)[7m"
        default: return "\(esc)[4;9\(steps.upTo(8))m"
        }
    }

    /// One piece of output of some kind a program sends.
    private func piece(_ steps: inout Steps, cols: Int, rows: Int) -> String {
        let at = { (s: inout Steps) in "\(self.esc)[\(s.upTo(rows) + 1);\(s.upTo(cols) + 1)H" }
        switch steps.upTo(22) {
        case 0, 1, 2:   // a status line: home, to its row, a little text, the cursor parked on the last row and put back
            return "\(esc)[?25l\(esc)[H\r\(esc)[\(steps.upTo(rows - 1) + 1)B\(colour(&steps))\(words(&steps))\(esc)[39m\(esc)[\(rows);1H\(at(&steps))\(esc)[?25h"
        case 3, 4: return at(&steps) + colour(&steps) + words(&steps)
        case 5: return at(&steps)                                         // the cursor alone
        case 6: return at(&steps) + "\(esc)[\(steps.upTo(3))K"            // erase in line
        case 7: return at(&steps) + "\(esc)[\(steps.upTo(3))J"            // erase in display
        case 8: return "\(esc)[\(rows);1H\r\n" + words(&steps)            // a new line at the bottom: everything moves up
        case 9: return "\(esc)[H\(esc)M"                                  // reverse index at the top: everything moves down
        case 10: return at(&steps) + "\(esc)[\(steps.upTo(3) + 1)L"       // insert lines
        case 11: return at(&steps) + "\(esc)[\(steps.upTo(3) + 1)M"       // delete lines
        case 12: return at(&steps) + "\(esc)[\(steps.upTo(5) + 1)@"       // insert characters
        case 13: return at(&steps) + "\(esc)[\(steps.upTo(5) + 1)P"       // delete characters
        case 14:                                                          // a scrolling region, scrolled, then the whole screen again
            let top = steps.upTo(rows - 3) + 1
            return "\(esc)[\(top);\(min(rows, top + 2 + steps.upTo(4)))r\(esc)[\(steps.upTo(2) + 1)\(steps.pick(["S", "T"]))\(esc)[r"
        case 15: return steps.upTo(2) == 0 ? "\(esc)[?1049h" + at(&steps) + words(&steps) : "\(esc)[?1049l"   // the other screen and back
        case 16: return "\(esc)]4;\(steps.upTo(16));rgb:\(steps.pick(["ff", "80", "00"]))/\(steps.pick(["ff", "80", "00"]))/40\(esc)\\"   // a palette colour
        case 17: return "\(esc)]1\(steps.upTo(2));rgb:\(steps.pick(["10", "e0"]))/\(steps.pick(["10", "e0"]))/\(steps.pick(["10", "e0"]))\(esc)\\"   // the default colours
        case 18: return "\(esc)[?5\(steps.pick(["h", "l"]))"              // the whole screen reversed
        case 19: return at(&steps) + "\(esc)[\(steps.upTo(4) + 1)X"       // erase characters
        case 20: return at(&steps) + String(repeating: words(&steps) + " ", count: 6)   // a line that wraps
        default: return "\r\n\t" + words(&steps) + "\u{8}\u{8}" + colour(&steps) + "x"
        }
    }

    /// The check itself sees a screen left behind: content changed with nothing drawn is not the screen drawn whole.
    func testAScreenLeftBehindIsSeen() {
        let (view, shown) = screen()
        feed("hello\r\nworld", to: view, shown: shown)
        XCTAssertTrue(same(shown, whole(view)))
        view.getTerminal().feed(text: "\(esc)[Hchanged")
        view.getTerminal().clearUpdateRange()
        XCTAssertFalse(same(shown, whole(view)))
    }

    func testTheScreenDrawnRowByRowIsTheScreenDrawnWhole() {
        for seed in [UInt64(1), 7, 42, 2026] {
            var steps = Steps(state: seed)
            let (view, shown) = screen()
            let terminal = view.getTerminal()
            XCTAssertGreaterThan(terminal.rows, 8)
            var history: [String] = []
            for step in 0..<400 {
                let text = piece(&steps, cols: terminal.cols, rows: terminal.rows)
                history.append(text)
                feed(text, to: view, shown: shown)
                let fresh = whole(view)
                if !same(shown, fresh) {
                    let row = firstDifferentRow(shown, fresh, cell: size.height / CGFloat(terminal.rows))
                    return XCTFail("seed \(seed), step \(step): the screen differs from the row \(row) down after \(text.debugDescription) (before it: \(history.suffix(4).dropLast().map(\.debugDescription).joined(separator: " ")))")
                }
            }
        }
    }

    /// A link under the pointer is underlined by the view, not by the cells: its row is drawn though its text is the same.
    func testARowWhoseLinkHighlightChangedIsSentToBeDrawn() {
        let (view, shown) = screen()
        let terminal = view.getTerminal()
        feed((1...terminal.rows).map { "see https://example.com/\($0)" }.joined(separator: "\r\n"), to: view, shown: shown)
        let cell = size.height / CGFloat(terminal.rows)
        view.invalidateLinkHighlightRow(terminal.displayBuffer.yDisp + 3)
        view.updateDisplay(notifyAccessibility: false)
        let asked = view.dirty.reduce(NSRect.null) { $0.union($1) }
        XCTAssertFalse(asked.isEmpty)
        // The fourth row from the top (the view's origin is at the bottom) is within what was asked for.
        let rowTop = size.height - 3 * cell, rowBottom = size.height - 4 * cell
        XCTAssertLessThanOrEqual(asked.minY, rowBottom + 0.5)
        XCTAssertGreaterThanOrEqual(asked.maxY, rowTop - 0.5)
        XCTAssertLessThanOrEqual(asked.height, cell * 2 + 1)
    }

    /// Claude Code's status line as recorded: one row is sent to be drawn, not the screen.
    func testAStatusLineSendsItsRowToBeDrawn() {
        let (view, shown) = screen()
        let terminal = view.getTerminal()
        feed((1...terminal.rows).map { "line \($0)" }.joined(separator: "\r\n"), to: view, shown: shown)
        terminal.feed(text: "\(esc)[?25l\(esc)[H\r\(esc)[5B\(esc)[38;2;215;119;87m✢\(esc)[3G\(esc)[38;2;233;154;122mComputing…\(esc)[39m\(esc)[\(terminal.rows);1H\(esc)[4;3H\(esc)[?25h")
        view.updateDisplay(notifyAccessibility: false)
        let asked = view.dirty.reduce(NSRect.null) { $0.union($1) }
        let cell = size.height / CGFloat(terminal.rows)
        XCTAssertLessThanOrEqual(asked.height, cell * 2 + 1, "the row and the cell below it")
        XCTAssertFalse(asked.isEmpty)
    }
}
#endif
