import Foundation

// Model output as Markdown blocks, ported from the iPhone Kit (Feed/Markdown.swift): results and answers on the Dispatch
// page are laid out as Markdown (docs/dispatch-v0.md §2).

/// One block of model output. Executors and the router write Markdown; the page shows it by blocks, with Foundation's
/// inline parser (bold, italics, code, links) inside each. Images are never loaded: only their alt text.
public enum DispatchMarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    /// Single line breaks are kept: model output uses them on purpose.
    case paragraph(String)
    case listItem(depth: Int, ordinal: Int?, text: String)
    case quote(String)
    case code(language: String?, text: String)
    case table(header: [String], rows: [[String]])
    case rule
}

public enum DispatchMarkdown {
    /// The blocks of `source`: line based, the subset models write (ATX headings, `-`/`*`/`+` and `1.`/`1)` lists
    /// nested by indentation, fenced code, `>` quotes, pipe tables with a separator row, rules, paragraphs).
    public static func blocks(_ source: String) -> [DispatchMarkdownBlock] {
        var parser = DispatchBlockParser(lines: source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n"))
        return parser.parse()
    }

    /// Blocks of a stored text as the page shows it: the sealer's legend cut off, ciphertexts as locks.
    public static func readableBlocks(_ source: String) -> [DispatchMarkdownBlock] {
        blocks(DispatchMessageDisplay.readable(source))
    }

    /// Inline Markdown of one block; the text as is when it does not parse. Only http(s) links stay links: a model
    /// could otherwise put this app's own `agentswitch://pair` link (or any other scheme) behind friendly text.
    public static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                              failurePolicy: .returnPartiallyParsedIfPossible)
        let source = cjkEmphasis(text)
        var out = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(text)
        for run in out.runs {
            if let link = run.link, !isWebLink(link) { out[run.range].link = nil }
        }
        if source != text {
            while let space = out.range(of: zeroWidthSpace) { out.removeSubrange(space) }
        }
        return out
    }

    private static let zeroWidthSpace = "\u{200B}"
    /// `**未解决阻塞。**本次`: CommonMark does not close a `**` that follows punctuation and precedes a letter (or open
    /// one the other way round), which Chinese text does all the time. A zero-width space between the punctuation and
    /// the `**` makes it count (it is neither space nor punctuation); inline() takes it out again.
    private static let closingAfterPunctuation = try! NSRegularExpression(pattern: #"(\p{P})(\*\*)(?=[^\s\p{P}*])"#)
    private static let openingBeforePunctuation = try! NSRegularExpression(pattern: #"(?<=[^\s\p{P}*])(\*\*)(\p{P})"#)

    static func cjkEmphasis(_ text: String) -> String {
        guard text.contains("**") else { return text }
        var out = text
        for (regex, template) in [(closingAfterPunctuation, "$1\u{200B}$2"), (openingBeforePunctuation, "$1\u{200B}$2")] {
            out = regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out
    }

    public static func isWebLink(_ url: URL) -> Bool {
        ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    }

    /// One attributed text for a preview or an event line (a `Text` with a line limit): list markers, bold headings,
    /// monospaced code, table rows joined with " · ".
    public static func flattened(_ source: String) -> AttributedString {
        var out = AttributedString()
        for (i, block) in readableBlocks(source).enumerated() {
            if i > 0 { out.append(AttributedString("\n")) }
            out.append(flat(block))
        }
        return out
    }

    private static func flat(_ block: DispatchMarkdownBlock) -> AttributedString {
        switch block {
        case .heading(_, let text):
            var heading = inline(text)
            heading.inlinePresentationIntent = .stronglyEmphasized
            return heading
        case .paragraph(let text), .quote(let text):
            return inline(text)
        case .listItem(let depth, let ordinal, let text):
            var item = AttributedString(String(repeating: "  ", count: depth) + (ordinal.map { "\($0). " } ?? "• "))
            item.append(inline(text))
            return item
        case .code(_, let text):
            var code = AttributedString(text)
            code.inlinePresentationIntent = .code
            return code
        case .table(let header, let rows):
            var table = AttributedString()
            for (r, row) in ([header] + rows).enumerated() {
                if r > 0 { table.append(AttributedString("\n")) }
                for (c, cell) in row.enumerated() {
                    if c > 0 { table.append(AttributedString(" · ")) }
                    table.append(inline(cell))
                }
            }
            return table
        case .rule:
            return AttributedString("—")
        }
    }
}

private struct DispatchBlockParser {
    let lines: [String]
    private var i = 0
    private var out: [DispatchMarkdownBlock] = []
    private var paragraph: [String] = []
    /// The open list item: its depth, ordinal, text lines and the column its marker starts at.
    private var item: (depth: Int, ordinal: Int?, lines: [String], indent: Int)?
    /// Marker columns of the enclosing list items, outermost first.
    private var listIndents: [Int] = []

    init(lines: [String]) { self.lines = lines }

    mutating func parse() -> [DispatchMarkdownBlock] {
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let open = DispatchFence(opening: line) { fence(open); continue }
            if trimmed.isEmpty { flush(); i += 1; continue }
            if let heading = Self.heading(trimmed) { endList(); out.append(heading); i += 1; continue }
            if Self.isRule(trimmed) { endList(); out.append(.rule); i += 1; continue }
            if trimmed.contains("|"), i + 1 < lines.count, Self.isTableSeparator(lines[i + 1]) { table(); continue }
            if trimmed.hasPrefix(">") { quote(); continue }
            if let marker = Self.listMarker(line) { startItem(marker); i += 1; continue }
            if let open = item, Self.indent(of: line) > open.indent {
                item?.lines.append(trimmed)
            } else {
                if item != nil { endList() }
                paragraph.append(trimmed)
            }
            i += 1
        }
        flush()
        return out
    }

    private mutating func flush() {
        if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        if let open = item { out.append(.listItem(depth: open.depth, ordinal: open.ordinal, text: open.lines.joined(separator: "\n"))); item = nil }
    }

    private mutating func endList() {
        flush()
        listIndents = []
    }

    private mutating func startItem(_ marker: (indent: Int, ordinal: Int?, text: String)) {
        if !paragraph.isEmpty { endList() } else { flush() }
        while let last = listIndents.last, last > marker.indent { listIndents.removeLast() }
        if listIndents.last != marker.indent { listIndents.append(marker.indent) }
        item = (depth: listIndents.count - 1, ordinal: marker.ordinal, lines: [marker.text], indent: marker.indent)
    }

    /// A fenced block (DispatchFence): to a bare fence of the same mark and at least its length, or to the end.
    private mutating func fence(_ open: DispatchFence) {
        endList()
        var body: [String] = []
        i += 1
        while i < lines.count, !open.closes(lines[i]) {
            body.append(open.body(lines[i]))
            i += 1
        }
        i += 1   // the closing fence, or past the end
        while body.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { body.removeLast() }
        out.append(.code(language: open.language, text: body.joined(separator: "\n")))
    }

    private mutating func table() {
        endList()
        let header = Self.cells(lines[i])
        i += 2
        var rows: [[String]] = []
        while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
            rows.append(Self.cells(lines[i]))
            i += 1
        }
        out.append(.table(header: header, rows: rows))
    }

    private mutating func quote() {
        endList()
        var body: [String] = []
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(">") else { break }
            let rest = trimmed.dropFirst()
            body.append(String(rest.hasPrefix(" ") ? rest.dropFirst() : rest))
            i += 1
        }
        out.append(.quote(body.joined(separator: "\n")))
    }

    // MARK: - line tests

    private static let headingPattern = try! NSRegularExpression(pattern: "^(#{1,6})\\s+(.*?)\\s*#*$")
    private static let listPattern = try! NSRegularExpression(pattern: "^([ \\t]*)([-*+]|(\\d{1,9})[.)])\\s+(.*)$")
    private static let separatorCell = try! NSRegularExpression(pattern: "^:?-{3,}:?$")

    private static func heading(_ trimmed: String) -> DispatchMarkdownBlock? {
        guard let m = headingPattern.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
              let hashes = Range(m.range(at: 1), in: trimmed), let text = Range(m.range(at: 2), in: trimmed) else { return nil }
        return .heading(level: trimmed[hashes].count, text: String(trimmed[text]))
    }

    private static func isRule(_ trimmed: String) -> Bool {
        let chars = trimmed.filter { !$0.isWhitespace }
        guard let first = chars.first, "-*_".contains(first), chars.count >= 3 else { return false }
        return chars.allSatisfy { $0 == first }
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cells = cells(line)
        return !cells.isEmpty && cells.allSatisfy { separatorCell.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil }
    }

    private static func cells(_ line: String) -> [String] {
        var row = line.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("|") { row.removeFirst() }
        if row.hasSuffix("|") { row.removeLast() }
        return row.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func listMarker(_ line: String) -> (indent: Int, ordinal: Int?, text: String)? {
        guard let m = listPattern.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let lead = Range(m.range(at: 1), in: line), let text = Range(m.range(at: 4), in: line) else { return nil }
        let ordinal = Range(m.range(at: 3), in: line).flatMap { Int(line[$0]) }
        return (indent: indent(of: String(line[lead])), ordinal: ordinal, text: String(line[text]))
    }

    /// Leading columns, a tab counting as four.
    private static func indent(of line: String) -> Int {
        var n = 0
        for ch in line {
            if ch == " " { n += 1 } else if ch == "\t" { n += 4 } else { break }
        }
        return n
    }
}
