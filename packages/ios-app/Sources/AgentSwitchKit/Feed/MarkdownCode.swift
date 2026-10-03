import Foundation

// Code in what Dispatch shows (docs/dispatch-v0.md §2, 2026-10-03, user: dispatch里加上代码块支持吧，这样看着太难受了 ……
// 手机上也是): fenced blocks and backtick spans. Model output is Markdown as a whole (Markdown.blocks); what a person typed
// goes through these two only, so nothing else they typed is read as Markdown. Same as the Mac Core's DispatchCode.

/// A fence line as people and models write it (CommonMark's rule): three or more backticks or tildes, then an optional
/// info string — for backticks one without a backtick, so ```ls``` on a line is a code span, not a fence.
struct MarkdownFence: Equatable {
    let mark: Character
    let length: Int
    /// The info string's first word (`bash`, `json`), if any.
    let language: String?
    /// The opening line's leading spaces, taken off the block's lines too (a fence under a list item).
    let indent: Int

    init?(opening line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let mark = trimmed.first, mark == "`" || mark == "~" else { return nil }
        let length = trimmed.prefix(while: { $0 == mark }).count
        let info = trimmed.dropFirst(length).trimmingCharacters(in: .whitespaces)
        guard length >= 3, mark == "~" || !info.contains("`") else { return nil }
        self.mark = mark
        self.length = length
        self.language = info.split(separator: " ").first.map(String.init)
        self.indent = line.prefix(while: { $0 == " " }).count
    }

    /// Whether `line` ends the block: the same mark, at least as many, nothing else on the line.
    func closes(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count >= length && trimmed.allSatisfy { $0 == mark }
    }

    /// A line of the block without the fence's own indentation (no more than the line has).
    func body(_ line: String) -> String {
        String(line.dropFirst(min(indent, line.prefix(while: { $0 == " " }).count)))
    }
}

extension Markdown {
    /// What a person typed, as typed, with only its code read: fenced blocks become `.code`, the text between them one
    /// `.paragraph` each, whole — blank lines, `#`, `*`, `-` and `1.` stay as typed (draw it with `codeSpans`). A fence
    /// left open runs to the end, as in model output.
    public static func typedBlocks(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var out: [MarkdownBlock] = []
        var text: [String] = []
        func endText() {
            while text.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { text.removeFirst() }
            while text.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { text.removeLast() }
            if !text.isEmpty { out.append(.paragraph(text.joined(separator: "\n"))) }
            text = []
        }
        var i = 0
        while i < lines.count {
            guard let fence = MarkdownFence(opening: lines[i]) else { text.append(lines[i]); i += 1; continue }
            endText()
            var body: [String] = []
            i += 1
            while i < lines.count, !fence.closes(lines[i]) { body.append(fence.body(lines[i])); i += 1 }
            i += 1   // the closing fence, or past the end
            while body.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { body.removeLast() }
            out.append(.code(language: fence.language, text: body.joined(separator: "\n")))
        }
        endText()
        return out
    }

    /// `text` with its backtick code spans marked as code (the `.code` inline intent) and nothing else read. A span is
    /// closed by a run of as many backticks on the same line (CommonMark's rule, kept to one line so a stray backtick
    /// never turns a paragraph into code); one space inside both ends is taken off; a run with no partner stays as typed.
    public static func codeSpans(_ text: String) -> AttributedString {
        var out = AttributedString()
        for (n, line) in text.components(separatedBy: "\n").enumerated() {
            if n > 0 { out.append(AttributedString("\n")) }
            out.append(spans(in: Array(line)))
        }
        return out
    }

    private static func spans(in chars: [Character]) -> AttributedString {
        var out = AttributedString()
        var plain = ""
        var i = 0
        while i < chars.count {
            guard chars[i] == "`" else { plain.append(chars[i]); i += 1; continue }
            let open = run(chars, at: i)
            guard let close = closing(chars, length: open, from: i + open) else {
                plain += String(chars[i..<(i + open)])
                i += open
                continue
            }
            var code = String(chars[(i + open)..<close])
            if code.count >= 2, code.first == " ", code.last == " ", code.contains(where: { $0 != " " }) {
                code = String(code.dropFirst().dropLast())
            }
            if !plain.isEmpty { out.append(AttributedString(plain)); plain = "" }
            var span = AttributedString(code)
            span.inlinePresentationIntent = .code
            out.append(span)
            i = close + open
        }
        if !plain.isEmpty { out.append(AttributedString(plain)) }
        return out
    }

    /// How many backticks run from `start`.
    private static func run(_ chars: [Character], at start: Int) -> Int {
        var n = 0
        while start + n < chars.count, chars[start + n] == "`" { n += 1 }
        return n
    }

    /// Where the next run of exactly `length` backticks starts, from `start` on.
    private static func closing(_ chars: [Character], length: Int, from start: Int) -> Int? {
        var j = start
        while j < chars.count {
            guard chars[j] == "`" else { j += 1; continue }
            let n = run(chars, at: j)
            if n == length { return j }
            j += n
        }
        return nil
    }
}
