import Foundation

/// What a drop on the terminal types (docs/terminal-v0.md §1 Mac), as iTerm does: each file's path with the shell's
/// special characters escaped by a backslash, separated by spaces (Claude Code turns a picture's path into [Image #n]);
/// text as it is. A program that asked for bracketed paste gets it as one paste.
public enum TerminalDrop {
    /// Characters a shell would read as something else in a path.
    static let special: Set<Character> = [" ", "\t", "\\", "'", "\"", "`", "$", "&", ";", "|", "<", ">", "(", ")", "[", "]", "{", "}", "*", "?", "!", "#", "~", "^"]

    public static func paths(_ paths: [String]) -> String {
        paths.map { path in String(path.flatMap { special.contains($0) ? ["\\", $0] : [$0] }) }.joined(separator: " ")
    }

    /// `text` as a paste: between the bracketed-paste marks when the program asked for them (an end mark inside cannot
    /// end it early).
    public static func pasted(_ text: String, bracketed: Bool) -> String {
        guard bracketed else { return text }
        return "\u{1b}[200~" + text.replacingOccurrences(of: "\u{1b}[201~", with: "") + "\u{1b}[201~"
    }
}
