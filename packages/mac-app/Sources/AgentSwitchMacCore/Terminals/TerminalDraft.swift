import Foundation

/// A reply's files (docs/terminal-v0.md §4; the phone's TerminalDraft, the same placeholders): each stands in the text
/// as `[Image #n]` or `[File #n]` where it was put, and the service types its path there, as a terminal types a file
/// dragged onto it. Deleting the placeholder takes the file out.
public enum TerminalDraft {
    /// At most this many files in one reply (the service's limit).
    public static let maxFiles = 10

    public static func token(image: Bool, number: Int) -> String { image ? "[Image #\(number)]" : "[File #\(number)]" }

    /// What an agent reads as a picture when its path is typed (Claude Code and Codex make it an image of the message).
    public static func isImage(name: String) -> Bool {
        ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains((name as NSString).pathExtension.lowercased())
    }

    /// `tokens` as typed at the caret: a space before when the text there has none, a space after each.
    public static func typed(_ tokens: [String], after before: Character?) -> String {
        guard !tokens.isEmpty else { return "" }
        let lead = before == nil || before?.isWhitespace == true ? "" : " "
        return lead + tokens.map { $0 + " " }.joined()
    }

    /// `text` without `token` and the space typed after it.
    public static func remove(_ token: String, from text: String) -> String {
        text.replacingOccurrences(of: token + " ", with: "").replacingOccurrences(of: token, with: "")
    }
}

/// One file of a reply on the wire (`POST /terminals/:id/input` `attachments`): where it is on this Mac (`path`: a file
/// dragged in is not copied), or what `POST /uploads` called it (`upload`: a picture off the clipboard, with no file
/// behind it).
public struct TerminalReplyFile: Encodable, Sendable, Hashable {
    public let token: String
    public let upload: String?
    public let path: String?

    public init(token: String, path: String) {
        self.token = token
        self.path = path
        upload = nil
    }

    public init(token: String, upload: String) {
        self.token = token
        self.upload = upload
        path = nil
    }
}
