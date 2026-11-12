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

/// What ⌘V on the terminal's screen does with the clipboard (docs/terminal-v0.md §1 Mac, "粘贴图片", 2026-10-15). SwiftTerm
/// pastes the clipboard's text only, so a picture alone (a screenshot, a copy from Preview) pasted nothing; and the
/// files of this Mac (copied in Finder, which also puts their names as text) mean nothing on another node. Those two are
/// sent to the terminal's node (`POST /uploads`, then `POST /terminals/:id/attach`, which pastes their paths there, as a
/// phone's are); everything else is SwiftTerm's paste as before. Ctrl+V stays the program's own key (the agent reads
/// its own clipboard with it).
public enum TerminalPaste: Equatable, Sendable {
    /// SwiftTerm's own paste: the clipboard's text.
    case text
    /// The files on the clipboard, sent to the terminal's node.
    case files
    /// The picture on the clipboard, sent as a PNG.
    case picture

    /// `files`: how many file URLs the clipboard holds; `text`: whether it has text; `picture`: whether an image can be
    /// read from it; `remote`: whether the terminal is on another node.
    public static func of(files: Int, text: Bool, picture: Bool, remote: Bool) -> TerminalPaste {
        // On this Mac, Finder's copy pastes as it did (the names it puts as text).
        if files > 0 { return remote ? .files : .text }
        // Text beside a picture (a copy from a document or a web page) is pasted as text, as before.
        if picture, !text { return .picture }
        return .text
    }
}
