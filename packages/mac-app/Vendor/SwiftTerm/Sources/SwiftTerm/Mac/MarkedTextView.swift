//
//  MarkedTextView.swift
//
//  AgentSwitch patch (Vendor/SwiftTerm/PATCHES.md): an input method's marked text — Pinyin's "zhong" before it
//  becomes 中, a Kana reading before its Kanji — drawn as the terminal draws its own text: inline on the cell grid at the
//  cursor, a wide character over two cells, covering the cells beneath it, underlined (the clause being converted
//  thicker), with a thin caret where the input method's insertion point is. Upstream floats a padded text field with a
//  translucent rounded background beside a block caret that stays on screen.
//
#if os(macOS)
import AppKit
import CoreText

final class MarkedTextView: NSView {
    /// The marked text as the input method gave it (its underline attributes say which clause is being converted).
    var text = NSAttributedString()
    /// The input method's selection inside the marked text (UTF-16 offsets); a zero length is where the caret goes.
    var selection = NSRange(location: NSNotFound, length: 0)
    var font: NSFont = .monospacedSystemFont(ofSize: 13, weight: .regular)
    var foreground: NSColor = .textColor
    var background: NSColor = .textBackgroundColor
    var caretColor: NSColor = .textColor
    var cellWidth: CGFloat = 8
    /// Where the terminal's rows put the baseline, from the bottom of the cell.
    var baseline: CGFloat = 3

    override var isOpaque: Bool { true }
    override var isFlipped: Bool { false }

    /// Each character of `string` (a grapheme), how many UTF-16 units it has and how many columns it takes, as the
    /// terminal counts columns.
    static func cells(_ string: String) -> [(units: Int, columns: Int)] {
        string.map { character in
            let width = character.unicodeScalars.first.map { UnicodeUtil.columnWidth(rune: $0) } ?? 1
            return (character.utf16.count, min(2, max(1, width)))
        }
    }

    /// Columns before the UTF-16 offset `units` of `string`.
    static func columns(of string: String, before units: Int) -> Int {
        var seen = 0, columns = 0
        for cell in cells(string) {
            if seen >= units { break }
            seen += cell.units
            columns += cell.columns
        }
        return columns
    }

    /// The width the text takes on the grid, with room for the caret after its last character.
    var fittingWidth: CGFloat {
        CGFloat(Self.cells(text.string).reduce(0) { $0 + $1.columns }) * cellWidth + 2
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        background.setFill()
        bounds.fill()
        let string = text.string as NSString
        var units = 0, column = 0
        context.textMatrix = .identity
        for cell in Self.cells(text.string) {
            let piece = string.substring(with: NSRange(location: units, length: cell.units))
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: piece, attributes: [.font: font, .foregroundColor: foreground]))
            let advance = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
            let slot = CGFloat(cell.columns) * cellWidth
            // A wide glyph centred in its two cells, as the terminal places them.
            context.textPosition = CGPoint(x: CGFloat(column) * cellWidth + max(0, (slot - advance) / 2), y: baseline)
            CTLineDraw(line, context)
            units += cell.units
            column += cell.columns
        }
        // The underline: thin under all of it, thick under the clause the input method is converting.
        let width = CGFloat(column) * cellWidth
        foreground.withAlphaComponent(0.85).setFill()
        NSRect(x: 0, y: 1, width: width, height: 1).fill()
        text.enumerateAttribute(.underlineStyle, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let style = value as? Int, style & NSUnderlineStyle.thick.rawValue != 0 else { return }
            let from = CGFloat(Self.columns(of: text.string, before: range.location)) * cellWidth
            let to = CGFloat(Self.columns(of: text.string, before: range.location + range.length)) * cellWidth
            NSRect(x: from, y: 0, width: to - from, height: 2).fill()
        }
        // The insertion point inside the marked text: a thin bar.
        if selection.location != NSNotFound, selection.length == 0 {
            caretColor.setFill()
            let x = CGFloat(Self.columns(of: text.string, before: selection.location)) * cellWidth
            NSRect(x: min(x, bounds.width - 2), y: 2, width: 2, height: bounds.height - 3).fill()
        }
    }
}
#endif
