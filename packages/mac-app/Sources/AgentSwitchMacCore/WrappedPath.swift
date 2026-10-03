import Foundation

/// A path an agent's own screen broke over lines (docs/terminal-v0.md §1 链接; 2026-10-02, user: 折成两行的长路径
/// ⌘-点不开). Claude Code and Codex hard-wrap a long path at their own width and indent what follows, so the terminal
/// sees two words and neither is a file:
///
///     ⏺ Wrote /private/tmp/claude-501/-Users-me-Desktop-WorkSpace-Projects-AgentSwitch/0e3e5e94-d0e2-4f5b-b869-85d
///            7a3bb725b/scratchpad/standalone/out/agentswitch-browser.html
///
/// From the word clicked, the candidates are it joined with the words it may continue: down, the next line's first word
/// when the clicked word ends its line and the next line is indented; up, the previous line's last word when the
/// clicked word starts its indented line; each again from the word joined while that word is all its line holds, up to
/// `reach` lines each way. A line broken there was filled to the agent's width, so it reaches at least as far right as
/// the line it continues into. The caller checks them on disk, longest first (`LinkPolicy.target`).
public enum WrappedPath {
    /// Lines a path may run on over, each way.
    public static let reach = 3

    /// The second cell of a wide character (CJK takes two), in a row given cell by cell: part of the word it is in,
    /// no character of its own.
    public static let wideTail: Character = "\u{FFFF}"

    /// `rows`: the screen's rows around the click, a character a cell (`wideTail` for a wide character's second cell,
    /// NUL or a space for an empty one); `row`, `column`: the cell clicked. The clicked word and every join, longest first,
    /// with the quotes or brackets around it and a sentence's punctuation after it taken off; none when the click is on
    /// a blank.
    public static func candidates(rows: [[Character]], row: Int, column: Int) -> [String] {
        joins(rows: rows, row: row, column: column).map(\.text)
    }

    /// The same over rows given as text (no wide characters: a character a cell).
    public static func candidates(lines: [String], row: Int, column: Int) -> [String] {
        candidates(rows: lines.map { Array($0) }, row: row, column: column)
    }

    /// One candidate and whether it takes in a line above the clicked one.
    public struct Join: Sendable, Equatable {
        public let text: String
        /// It starts on a line above: the clicked word is its end, so cut back from its end it is the line above's
        /// path, not the clicked one (`LinkPolicy.target` never cuts it back).
        public let reachesUp: Bool

        public init(_ text: String, reachesUp: Bool = false) {
            self.text = text
            self.reachesUp = reachesUp
        }
    }

    /// `candidates`, each with the way it was joined; a text made both ways counts as not reaching up.
    public static func joins(rows: [[Character]], row: Int, column: Int) -> [Join] {
        guard rows.indices.contains(row), let clicked = word(in: rows[row], at: column) else { return [] }
        let up = words(from: clicked, row: row, in: rows, step: -1)
        let down = words(from: clicked, row: row, in: rows, step: 1)
        let middle = text(rows[row][clicked])
        var seen = Set<String>()
        var out: [Join] = []
        for u in 0...up.count {
            for d in 0...down.count {
                let joined = trim(up.prefix(u).reversed().joined() + middle + down.prefix(d).joined())
                if !joined.isEmpty, seen.insert(joined).inserted { out.append(Join(joined, reachesUp: u > 0)) }
            }
        }
        // Longest first; among equals, the one joining fewer lines (the order they were made in).
        return out.enumerated().sorted { a, b in
            a.element.text.count != b.element.text.count ? a.element.text.count > b.element.text.count : a.offset < b.offset
        }.map(\.element)
    }

    public static func joins(lines: [String], row: Int, column: Int) -> [Join] {
        joins(rows: lines.map { Array($0) }, row: row, column: column)
    }

    /// The words a path broken at `start` may continue in, nearest first: each the neighbouring line's word on the side
    /// it continues, while the word before it sits at that end of its line.
    private static func words(from start: Range<Int>, row: Int, in rows: [[Character]], step: Int) -> [String] {
        var out: [String] = []
        var current = start
        var r = row
        while out.count < reach {
            let next = r + step
            guard rows.indices.contains(next) else { break }
            let (upper, lower) = step > 0 ? (rows[r], rows[next]) : (rows[next], rows[r])
            // The upper line was filled to the break; the lower one is indented and no longer than it.
            guard end(of: upper) >= end(of: lower), indent(of: lower) > 0, indent(of: lower) < lower.count else { break }
            let found: Range<Int>?
            if step > 0 {
                // Down: the word ends its line; the next line's first word.
                guard current.upperBound == end(of: upper) else { break }
                found = word(in: lower, at: indent(of: lower))
            } else {
                // Up: the word starts its line; the previous line's last word.
                guard current.lowerBound == indent(of: lower), end(of: upper) > 0 else { break }
                found = word(in: upper, at: end(of: upper) - 1)
            }
            guard let found else { break }
            out.append(text(rows[next][found]))
            current = found
            r = next
        }
        return out
    }

    /// The run of non-blank cells at `column`.
    private static func word(in line: [Character], at column: Int) -> Range<Int>? {
        guard line.indices.contains(column), !blank(line[column]) else { return nil }
        var lower = column, upper = column + 1
        while lower > 0, !blank(line[lower - 1]) { lower -= 1 }
        while upper < line.count, !blank(line[upper]) { upper += 1 }
        return lower..<upper
    }

    private static func text(_ cells: ArraySlice<Character>) -> String { String(cells.filter { $0 != wideTail }) }

    /// Blank cells before the line's first word (the whole line when it is blank).
    private static func indent(of line: [Character]) -> Int { line.firstIndex { !blank($0) } ?? line.count }

    /// Where the line's last word ends (0: a blank line).
    private static func end(of line: [Character]) -> Int { (line.lastIndex { !blank($0) } ?? -1) + 1 }

    /// A space, a tab, or a cell nothing was written to (the terminal's NUL).
    private static func blank(_ c: Character) -> Bool { c != wideTail && (c.isWhitespace || c == "\u{0}") }

    private static let opening: Set<Character> = ["(", "[", "{", "<", "\"", "'", "`", "“", "‘", "「", "『", "（", "【", "《"]
    private static let closing: Set<Character> = [")", "]", "}", ">", "\"", "'", "`", "”", "’", "」", "』", "）", "】", "》",
                                                  ",", ";", ":", ".", "!", "?", "，", "。", "；", "：", "、", "！", "？"]

    /// The path inside the word: what quotes or brackets it, and a sentence's punctuation after it, taken off its ends
    /// (`:12:5` after a path ends in a digit and stays: where in the file, LinkPolicy's).
    static func trim(_ text: String) -> String {
        var s = Substring(text)
        while let c = s.first, opening.contains(c) { s = s.dropFirst() }
        while let c = s.last, closing.contains(c) { s = s.dropLast() }
        return String(s)
    }
}
