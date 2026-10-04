import Foundation

// The links on a terminal's screen (docs/terminal-v0.md §1 iPhone 链接, 2026-10-03): found in the rows as the screen
// holds them, cell by cell, so a touch can be matched to one. Three kinds are read: an OSC 8 link (the agents' status
// lines), a web address written out, and a path of the Mac's. An address or a path that runs over a line's end is one
// link: the terminal's own wrap, and the break an agent makes itself (Claude Code and Codex wrap by words and cut a word
// only when it is longer than a whole line, so the line it was cut on is filled to the width and the rest starts the
// next, indented), and for a path the wrap of a column of its own (Claude Code's row for a file on a narrow screen: the
// mark, the path and the size each wrapped in its column, so the path's rest starts under its first cell, whatever else
// the row holds). A touch need not be exact: the nearest link within a finger's slop takes it.

/// A link on the screen and the cells it covers.
public struct ScreenLink: Equatable, Sendable {
    /// Cells of one row: its index among the rows given, and the columns.
    public struct Span: Equatable, Sendable {
        public let row: Int
        public let columns: Range<Int>

        public init(row: Int, columns: Range<Int>) {
            self.row = row
            self.columns = columns
        }
    }

    public let link: TappedLink
    public let spans: [Span]
    /// For a path that may or may not go on over the next line: the other readings, longest first. The phone cannot
    /// look on the Mac's disk; the Mac says which one is there (`404` for one that is not).
    public let alternates: [TappedLink]

    public init(link: TappedLink, spans: [Span], alternates: [TappedLink] = []) {
        self.link = link
        self.spans = spans
        self.alternates = alternates
    }
}

public enum TerminalLinks {
    /// The second cell of a wide character (CJK takes two), in a row given cell by cell.
    public static let wideTail: Character = "\u{FFFF}"
    /// Lines a link may run on over.
    public static let reach = 4

    /// An OSC 8 link's cells on one row, with the address it carries.
    public struct Explicit: Equatable, Sendable {
        public let row: Int
        public let columns: Range<Int>
        public let address: String

        public init(row: Int, columns: Range<Int>, address: String) {
            self.row = row
            self.columns = columns
            self.address = address
        }
    }

    /// The address in an OSC 8 payload as the terminal keeps it (`params;address`).
    public static func address(payload: String) -> String? {
        guard let cut = payload.firstIndex(of: ";") else { return nil }
        let address = String(payload[payload.index(after: cut)...])
        return address.isEmpty ? nil : address
    }

    /// The links in `rows` (a character a cell; `wideTail` for a wide character's second cell, NUL or a space for an
    /// empty one). `wrapped`: the rows the terminal itself continued from the row above. `explicit`: the OSC 8 links'
    /// cells. `workdir`: the folder the agent works in, for relative paths.
    public static func find(rows: [[Character]], wrapped: Set<Int> = [], explicit: [Explicit] = [], workdir: String? = nil) -> [ScreenLink] {
        var out: [ScreenLink] = []
        // OSC 8: cells carrying one address, on one row or on rows one after another, are one link.
        var covered: [Int: [Range<Int>]] = [:]
        var open: [(address: String, spans: [ScreenLink.Span])] = []
        for e in explicit.sorted(by: { ($0.row, $0.columns.lowerBound) < ($1.row, $1.columns.lowerBound) }) where !e.columns.isEmpty {
            covered[e.row, default: []].append(e.columns)
            let span = ScreenLink.Span(row: e.row, columns: e.columns)
            if let i = open.lastIndex(where: { $0.address == e.address && e.row - ($0.spans.last?.row ?? e.row) <= 1 }) {
                open[i].spans.append(span)
            } else {
                open.append((e.address, [span]))
            }
        }
        for o in open { if let link = TappedLink(address: o.address) { out.append(ScreenLink(link: link, spans: o.spans)) } }

        var used: [Int: [Range<Int>]] = [:]   // cells taken as a link's continuation, by row
        for (r, line) in rows.enumerated() {
            for word in words(in: line) {
                if used[r]?.contains(where: { $0.overlaps(word) }) == true || covered[r]?.contains(where: { $0.overlaps(word) }) == true { continue }
                let cells = Self.cells(line, word, row: r)
                let free = { (pieces: [Piece]) in Array(pieces.prefix { p in covered[p.row]?.contains(where: { $0.overlaps(p.word) }) != true }) }
                let pieces = free(chain(from: word, row: r, rows: rows, wrapped: wrapped))
                // A path that does not go on at its row's end may go on down its own column.
                let found = address(in: cells, pieces: pieces, rows: rows)
                    ?? path(in: cells, pieces: pieces.isEmpty ? free(column(from: word, row: r, rows: rows, wrapped: wrapped)) : pieces, rows: rows, workdir: workdir)
                guard let found else { continue }
                for p in found.used { used[p.row, default: []].append(p.word) }
                out.append(found.link)
            }
        }
        return out
    }

    /// The link a touch at (`column`, `row`) — in cells, fractions and all — lands on: the nearest one no further than
    /// `slop` points away (`cell`: a cell's size in points); a touch inside a link is on it. Lines of text on a phone
    /// are about a third of a fingertip high.
    public static func hit(_ links: [ScreenLink], column: Double, row: Double, cell: (width: Double, height: Double), slop: Double) -> ScreenLink? {
        var best: (link: ScreenLink, distance: Double)?
        for link in links {
            for span in link.spans {
                let left = Double(span.columns.lowerBound), right = Double(span.columns.upperBound), top = Double(span.row), bottom = Double(span.row + 1)
                let dx = (column < left ? left - column : column > right ? column - right : 0) * cell.width
                let dy = (row < top ? top - row : row > bottom ? row - bottom : 0) * cell.height
                let distance = (dx * dx + dy * dy).squareRoot()
                if distance <= slop, distance < (best?.distance ?? .infinity) { best = (link, distance) }
            }
        }
        return best?.link
    }

    // MARK: - an address, a path

    private struct Cell {
        let char: Character
        let row: Int
        let column: Int
        /// 2 for a wide character.
        let width: Int
    }

    private struct Piece {
        let row: Int
        let word: Range<Int>
        /// Surely a continuation: the terminal's own wrap, or a line the agent filled to the width.
        let sure: Bool
        /// The room a whole line has for a word (the width less the indent): a word cut over lines is longer.
        let room: Int
        /// The rest of a word wrapped in a column of its own (`column`): its place alone does not say it is one word
        /// with what is above it — a list reads the same —, the joined path does (`path`).
        var boxed = false
    }

    private typealias Found = (link: ScreenLink, used: [Piece])

    /// A web address in the word, going on over the pieces it surely continues in while they hold only address
    /// characters.
    private static func address(in cells: [Cell], pieces: [Piece], rows: [[Character]]) -> Found? {
        let chars = cells.map(\.char)
        guard let start = LinkText.schemeStart(in: chars) else { return nil }
        var taken = Array(cells[start...].prefix(while: { LinkText.inAddress($0.char) }))
        var used: [Piece] = []
        if start + taken.count == cells.count {
            // It reaches the word's end: it may go on in the next line's first word.
            var more: [(Piece, [Cell])] = []
            for piece in pieces {
                let next = Self.cells(rows[piece.row], piece.word, row: piece.row)
                let part = Array(next.prefix(while: { LinkText.inAddress($0.char) }))
                guard piece.sure, !part.isEmpty, LinkText.schemeStart(in: part.map(\.char)) == nil else { break }
                more.append((piece, part))
                if part.count < next.count { break }
            }
            // A word is cut only when it does not fit a line of its own.
            if let first = more.first, soft(first.0) || taken.count + more.reduce(0, { $0 + $1.1.count }) > first.0.room {
                for (piece, part) in more { taken += part; used.append(piece) }
            }
        }
        let text = String(taken.map(\.char))
        let kept = LinkText.trimmed(Substring(text))
        guard let link = TappedLink(address: String(kept)) else { return nil }
        return (ScreenLink(link: link, spans: spans(Array(taken.prefix(kept.count)))), used)
    }

    /// A path of the Mac's in the word. It may go on over the next lines (`pieces`): the reading taken is the longest
    /// that is surely one word; the others are kept as alternates for the Mac to tell apart.
    private static func path(in cells: [Cell], pieces: [Piece], rows: [[Character]], workdir: String?) -> Found? {
        guard cells.contains(where: { $0.char == "/" }) else { return nil }
        var readings: [(link: TappedLink, cells: [Cell], pieces: [Piece], sure: Bool)] = []
        var joined = cells
        var sure = true
        var boxed = false
        var taken: [Piece] = []
        for k in 0...pieces.count {
            if k > 0 {
                let piece = pieces[k - 1]
                let part = Self.cells(rows[piece.row], piece.word, row: piece.row)
                boxed = boxed || piece.boxed
                sure = sure && piece.sure && (soft(piece) || joined.count + part.count > piece.room)
                joined += part
                taken.append(piece)
            }
            let kept = stripped(joined)
            // `Read(src/a.ts)`, `--out=build/a.html`: the path is what follows the bracket or the equals sign.
            let inner = kept.lastIndex(where: { $0.char == "(" || $0.char == "=" }).map { Array(kept[(($0) + 1)...]) } ?? []
            guard let read = [inner, kept].lazy.compactMap({ cells -> (String, [Cell])? in
                guard !cells.isEmpty, let path = LinkText.macPath(String(cells.map(\.char)), workdir: workdir) else { return nil }
                return (path, cells)
            }).first else { continue }
            // Down a column the join is surely one path when it names a file and the first row alone does not: a file
            // listed with its name whole does not go on in the row under it.
            let whole = !boxed ? sure : k > 0 && named(read.0) && readings.first.map { $0.pieces.isEmpty && named($0.link.text) } != true
            readings.append((.file(read.0), read.1, taken, whole))
        }
        guard !readings.isEmpty else { return nil }
        // The longest sure reading; with none sure but the word itself, that.
        let primary = readings.last(where: \.sure) ?? readings[0]
        let others = readings.reversed().map(\.link).filter { $0 != primary.link }
        return (ScreenLink(link: primary.link, spans: spans(primary.cells), alternates: others), primary.pieces)
    }

    private static let opening: Set<Character> = ["(", "[", "{", "<", "\"", "'", "`", "“", "‘", "「", "『", "（", "【", "《"]
    private static let closing: Set<Character> = [")", "]", "}", ">", "\"", "'", "`", "”", "’", "」", "』", "）", "】", "》",
                                                  ",", ";", ":", ".", "!", "?", "，", "。", "；", "：", "、", "！", "？"]

    /// The word without the quotes or brackets around it and the sentence's punctuation after it.
    private static func stripped(_ cells: [Cell]) -> [Cell] {
        var lower = 0, upper = cells.count
        while lower < upper, opening.contains(cells[lower].char) { lower += 1 }
        while upper > lower, closing.contains(cells[upper - 1].char) { upper -= 1 }
        return Array(cells[lower..<upper])
    }

    private static func soft(_ piece: Piece) -> Bool { piece.room == Int.max }

    /// The path ends in a file's name with an extension (`a.png`, `terminal.js`).
    private static func named(_ path: String) -> Bool {
        let name = path.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? ""
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return false }
        let tail = name[name.index(after: dot)...]
        return (1...8).contains(tail.count) && tail.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    /// Where a word wrapped in a column of its own goes on (Claude Code's row for a file on a narrow screen: the mark,
    /// the path and the size, each wrapped in its column): under its first cell on the next row, from there to the next
    /// blank cell — whatever the row holds before it, be it another column's word right against it (`[image]-rest.png`),
    /// though not the middle of a word — and no longer than the first row's part, which is the column's width; on to a
    /// third row only when the second fills the column. Not a row the terminal wrapped itself (that goes on at the row's
    /// first cell), nor the start of another path.
    private static func column(from word: Range<Int>, row: Int, rows: [[Character]], wrapped: Set<Int>) -> [Piece] {
        var out: [Piece] = []
        let start = word.lowerBound, width = word.count
        guard start > 0 else { return [] }
        var next = row + 1
        while out.count < reach, rows.indices.contains(next), !wrapped.contains(next) {
            let line = rows[next]
            guard start < line.count, !blank(line[start]), line[start] != wideTail else { break }
            let before = line[start - 1]
            guard blank(before) || !(before == wideTail || before.isLetter || before.isNumber) else { break }
            var upper = start + 1
            while upper < line.count, !blank(line[upper]) { upper += 1 }
            let piece = start..<upper
            let text = String(Self.cells(line, piece, row: next).map(\.char))
            guard piece.count <= width, !["~/", "./", "../"].contains(where: text.hasPrefix) else { break }
            out.append(Piece(row: next, word: piece, sure: false, room: width, boxed: true))
            guard piece.count == width else { break }
            next += 1
        }
        return out
    }

    // MARK: - rows and words

    /// The words a link broken at the end of `word`'s row may go on in, nearest first: each the next row's first word,
    /// while the word before it ends its row. The terminal's own wrap goes on at the row's first cell. An agent's own
    /// break goes on in an indented row no longer than the one it left; it is `sure` when that row was filled as far as
    /// any row of its paragraph (a line cut inside a word is filled to the width).
    private static func chain(from word: Range<Int>, row: Int, rows: [[Character]], wrapped: Set<Int>) -> [Piece] {
        var out: [Piece] = []
        var current = word
        var r = row
        while out.count < reach {
            let next = r + 1
            guard rows.indices.contains(next) else { break }
            let upper = rows[r], lower = rows[next]
            let dent = indent(of: lower)
            guard current.upperBound == end(of: upper), dent < lower.count, let first = Self.word(in: lower, at: dent) else { break }
            if wrapped.contains(next) {
                guard dent == 0 else { break }
                out.append(Piece(row: next, word: first, sure: true, room: Int.max))
            } else {
                guard dent > 0, end(of: upper) >= end(of: lower) else { break }
                out.append(Piece(row: next, word: first, sure: end(of: upper) >= widest(around: r, in: rows), room: end(of: upper) - dent))
            }
            current = first
            r = next
        }
        return out
    }

    /// How far the text rows of the paragraph around `row` reach: the rows up and down to the first blank one, but for
    /// those a frame ends (a box's side is not text).
    private static func widest(around row: Int, in rows: [[Character]]) -> Int {
        var top = row, bottom = row
        while top > 0, row - top < 12, end(of: rows[top - 1]) > 0 { top -= 1 }
        while bottom + 1 < rows.count, bottom - row < 12, end(of: rows[bottom + 1]) > 0 { bottom += 1 }
        return (top...bottom).filter { !framed(rows[$0]) }.map { end(of: rows[$0]) }.max() ?? 0
    }

    /// The row ends in a box-drawing character.
    private static func framed(_ line: [Character]) -> Bool {
        guard let last = line.last(where: { !blank($0) && $0 != wideTail }), let scalar = last.unicodeScalars.first else { return false }
        return (0x2500...0x259F).contains(scalar.value)
    }

    private static func cells(_ line: [Character], _ word: Range<Int>, row: Int) -> [Cell] {
        var out: [Cell] = []
        for column in word where line[column] != wideTail {
            out.append(Cell(char: line[column], row: row, column: column, width: column + 1 < line.count && line[column + 1] == wideTail ? 2 : 1))
        }
        return out
    }

    private static func spans(_ cells: [Cell]) -> [ScreenLink.Span] {
        var out: [ScreenLink.Span] = []
        for cell in cells {
            if let last = out.last, last.row == cell.row, last.columns.upperBound == cell.column {
                out[out.count - 1] = ScreenLink.Span(row: cell.row, columns: last.columns.lowerBound..<(cell.column + cell.width))
            } else {
                out.append(ScreenLink.Span(row: cell.row, columns: cell.column..<(cell.column + cell.width)))
            }
        }
        return out
    }

    /// The runs of non-blank cells in a row.
    private static func words(in line: [Character]) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var column = 0
        while column < line.count {
            if let found = word(in: line, at: column) { out.append(found); column = found.upperBound } else { column += 1 }
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

    /// Blank cells before the row's first word (the whole row when it is blank).
    private static func indent(of line: [Character]) -> Int { line.firstIndex { !blank($0) } ?? line.count }

    /// Where the row's last word ends (0: a blank row).
    private static func end(of line: [Character]) -> Int { (line.lastIndex { !blank($0) } ?? -1) + 1 }

    /// A space, a tab, or a cell nothing was written to (the terminal's NUL).
    private static func blank(_ c: Character) -> Bool { c != wideTail && (c.isWhitespace || c == "\u{0}") }
}
