import Foundation

/// A terminal reply with pictures and files in it (docs/terminal-v0.md §4 `attachments`), as Claude Code shows them: each
/// stands in the text as its placeholder, where the user put it — `[Image #1]`, `[File #2]` — and goes where it stands
/// when the reply is sent. Deleting the placeholder drops the file.
public enum TerminalDraft {
    public static func token(image: Bool, number: Int) -> String { image ? "[Image #\(number)]" : "[File #\(number)]" }

    /// `tokens` put into `text` at the character `offset` (nil: at the end), as typing them would: a space before when
    /// the text there does not already have one, a space after each. Returns the text and where the caret goes after.
    public static func insert(_ tokens: [String], into text: String, at offset: Int?) -> (text: String, caret: Int) {
        guard !tokens.isEmpty else { return (text, offset ?? text.count) }
        let at = min(max(0, offset ?? text.count), text.count)
        let index = text.index(text.startIndex, offsetBy: at)
        let before = text[..<index], after = text[index...]
        let lead = before.isEmpty || before.last?.isWhitespace == true ? "" : " "
        let inserted = lead + tokens.map { $0 + " " }.joined()
        // A space already after the caret is not doubled.
        let joined = after.first?.isWhitespace == true ? String(inserted.dropLast()) : inserted
        return (String(before) + joined + String(after), at + joined.count)
    }

    /// `text` without `token` and the space typed after it.
    public static func remove(_ token: String, from text: String) -> String {
        text.replacingOccurrences(of: token + " ", with: "").replacingOccurrences(of: token, with: "")
    }
}
