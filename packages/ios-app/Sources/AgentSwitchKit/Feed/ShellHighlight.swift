import Foundation

/// A shell command in parts, for colouring (the simple view's opened step, docs/simple-view-v0.md §5.1): the word each
/// command begins with, what is quoted — a here-document's body with it —, comments, and the rest. It reads the
/// command only as far as that takes: no expansion, no nesting inside quotes.
public enum ShellHighlight {
    public enum Kind: Sendable, Equatable {
        case plain, command, string, comment
    }

    public struct Run: Sendable, Equatable {
        public let text: String
        public let kind: Kind

        public init(_ text: String, _ kind: Kind) {
            self.text = text
            self.kind = kind
        }
    }

    /// Words a command may begin after (`if make; then …`), and words that begin none.
    private static let leading: Set<String> = ["if", "then", "else", "elif", "while", "until", "do", "time", "!", "{", "exec", "sudo", "env", "nohup", "xargs"]
    private static let closing: Set<String> = ["fi", "done", "esac", "for", "case", "in", "function", "select", "}"]
    private static let breaks: Set<Character> = [" ", "\t", "\n", ";", "|", "&", "(", ")", "<", ">", "'", "\"", "`"]

    public static func runs(_ source: String) -> [Run] {
        let c = Array(source)
        var runs: [Run] = []
        var plain = ""
        func flush() { if !plain.isEmpty { runs.append(Run(plain, .plain)); plain = "" } }
        func emit(_ text: String, _ kind: Kind) {
            guard !text.isEmpty else { return }
            if kind == .plain { plain += text } else { flush(); runs.append(Run(text, kind)) }
        }
        var i = 0
        // The next word begins a command.
        var first = true
        // Here-documents announced on this line: their bodies begin after its end.
        var docs: [(mark: String, tabs: Bool)] = []

        while i < c.count {
            let ch = c[i]
            if ch == "\n" {
                emit("\n", .plain)
                i += 1
                first = true
                for doc in docs {
                    // Up to the line that is the mark alone (after its tabs, for `<<-`).
                    var body = ""
                    while i < c.count {
                        var end = i
                        while end < c.count, c[end] != "\n" { end += 1 }
                        let line = String(c[i..<end])
                        body += line
                        if end < c.count { body += "\n" }
                        i = min(end + 1, c.count)
                        if (doc.tabs ? String(line.drop { $0 == "\t" }) : line) == doc.mark { break }
                    }
                    // Its last newline is the line's, not the body's.
                    if body.hasSuffix("\n") { emit(String(body.dropLast()), .string); emit("\n", .plain) } else { emit(body, .string) }
                }
                docs = []
                continue
            }
            if ch == " " || ch == "\t" { emit(String(ch), .plain); i += 1; continue }
            if ch == "\\", i + 1 < c.count {
                // An escaped character is itself; a line carried on is still the same command.
                emit(String(c[i...(i + 1)]), .plain)
                i += 2
                continue
            }
            if ch == "#", i == 0 || c[i - 1] == " " || c[i - 1] == "\t" || c[i - 1] == "\n" || c[i - 1] == ";" {
                var end = i
                while end < c.count, c[end] != "\n" { end += 1 }
                emit(String(c[i..<end]), .comment)
                i = end
                continue
            }
            if ch == "'" || ch == "\"" || ch == "`" {
                var end = i + 1
                while end < c.count, c[end] != ch {
                    if ch != "'", c[end] == "\\", end + 1 < c.count { end += 1 }
                    end += 1
                }
                end = min(end + 1, c.count)
                emit(String(c[i..<end]), .string)
                i = end
                first = false
                continue
            }
            if ch == "<", i + 1 < c.count, c[i + 1] == "<", !(i + 2 < c.count && c[i + 2] == "<") {
                // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`.
                var at = i + 2
                var tabs = false
                if at < c.count, c[at] == "-" { tabs = true; at += 1 }
                emit(String(c[i..<at]), .plain)
                while at < c.count, c[at] == " " || c[at] == "\t" { emit(String(c[at]), .plain); at += 1 }
                var end = at
                if end < c.count, c[end] == "'" || c[end] == "\"" {
                    let quote = c[end]
                    end += 1
                    while end < c.count, c[end] != quote, c[end] != "\n" { end += 1 }
                    end = min(end + 1, c.count)
                } else {
                    while end < c.count, !breaks.contains(c[end]) { end += 1 }
                }
                let word = String(c[at..<end])
                let mark = word.trimmingCharacters(in: CharacterSet(charactersIn: "'\"\\"))
                emit(word, .string)
                if !mark.isEmpty { docs.append((mark, tabs)) }
                i = end
                continue
            }
            if ch == ";" || ch == "|" || ch == "&" || ch == "(" {
                emit(String(ch), .plain)
                i += 1
                // `2>&1`, `&>file`: where output goes, not the end of a command.
                let redirects = ch == "&" && ((i >= 2 && (c[i - 2] == ">" || c[i - 2] == "<")) || (i < c.count && c[i] == ">"))
                if !redirects { first = true }
                continue
            }
            if ch == ")" || ch == "<" || ch == ">" { emit(String(ch), .plain); i += 1; continue }
            // A word, up to what ends one. `$(` begins a command inside it.
            var end = i
            var opens = false
            while end < c.count, !breaks.contains(c[end]) {
                if c[end] == "\\", end + 1 < c.count { end += 2; continue }
                if c[end] == "$", end + 1 < c.count, c[end + 1] == "(" { end += 2; opens = true; break }
                end += 1
            }
            if end == i { end = i + 1 }
            let word = String(c[i..<end])
            if opens {
                emit(word, .plain)
                first = true
            } else if !first {
                emit(word, .plain)
            } else if word.range(of: #"^[A-Za-z_][A-Za-z0-9_]*\+?="#, options: .regularExpression) != nil || leading.contains(word) {
                emit(word, .plain)   // `FOO=1 make`, `if make`: the command is still to come
            } else if closing.contains(word) {
                emit(word, .plain)
                first = false
            } else {
                emit(word, .command)
                first = false
            }
            i = end
        }
        flush()
        return runs
    }
}
