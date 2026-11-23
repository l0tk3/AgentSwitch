import Foundation

/// What stands in the message box for a file it comes with (the Mac's `RoomAttachTokens`, 2026-11-23): `[Image #1]`
/// for a picture, `[File name.ext]` for anything else, put in the box when the file is picked. Deleting the token takes
/// the file off; taking the file off deletes the token. The tokens go out with the text, so the reader sees where each
/// file belongs. A file is known by a key (its path on the Mac, or the id of a picture picked on the phone).
public struct RoomAttachTokens: Equatable, Sendable {
    public static let pictureKinds: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp"]

    /// Key → its token.
    public private(set) var tokens: [String: String] = [:]
    /// The tokens the box has shown: one not yet put in is not "deleted".
    private var shown: Set<String> = []

    public init() {}

    public static func isPicture(_ name: String) -> Bool { pictureKinds.contains((name as NSString).pathExtension.lowercased()) }

    /// A new token for `key` (named `name`, by default the key's last part), unlike any the box has now.
    public mutating func add(_ key: String, name: String? = nil) -> String {
        if let had = tokens[key] { return had }
        let name = name ?? (key as NSString).lastPathComponent
        let used = Set(tokens.values)
        var token: String
        if Self.isPicture(name) {
            var n = 1
            repeat { token = "[Image #\(n)]"; n += 1 } while used.contains(token)
        } else {
            token = "[File \(name)]"
            var n = 2
            while used.contains(token) { token = "[File \(name) #\(n)]"; n += 1 }
        }
        tokens[key] = token
        return token
    }

    /// The box now says `draft`: the keys whose token was there and is gone.
    public mutating func gone(in draft: String) -> [String] {
        var out: [String] = []
        for (key, token) in tokens {
            if draft.contains(token) { shown.insert(token) } else if shown.contains(token) { out.append(key) }
        }
        for key in out { forget(key) }
        return out.sorted()
    }

    /// `key` taken off: its token, to be cut from the box.
    @discardableResult public mutating func forget(_ key: String) -> String? {
        guard let token = tokens.removeValue(forKey: key) else { return nil }
        shown.remove(token)
        return token
    }

    public mutating func clear() { tokens = [:]; shown = [] }

    /// What goes in the box for new tokens: a space before them unless the box is empty or ends in one.
    public static func appended(_ new: [String], to draft: String) -> String {
        guard !new.isEmpty else { return draft }
        let lead = draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") ? "" : " "
        return draft + lead + new.joined(separator: " ") + " "
    }

    /// The box without `token` (and the space after it).
    public static func removing(_ token: String, from draft: String) -> String {
        draft.replacingOccurrences(of: token + " ", with: "").replacingOccurrences(of: token, with: "")
    }
}

/// The sessions to seat, searched (the Mac's add-sessions search, 2026-11-23): by name, agent, model, profile and
/// folder at once, case aside.
public enum RoomSessionSearch {
    /// What a session is searched by.
    public static func words(_ t: TerminalInfo) -> String {
        [t.name, t.harness, ModelName.harness(t.harness), t.model, t.model.map(ModelName.display), t.modelNow, t.modelNow.map(ModelName.display),
         t.profile?.name, t.workdir, t.cwd].compactMap { $0 }.joined(separator: "  ")
    }

    public static func filter(_ terminals: [TerminalInfo], query: String) -> [TerminalInfo] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return terminals }
        return terminals.filter { words($0).range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}

/// The Markdown of a stretch of a message's plain text (the Mac's `RoomRich.markdown`, 2026-11-23): bold, italic,
/// strikethrough and links as they read; a heading's line bold; a list's `-` / `*` / `+` a bullet. Lines stay as
/// written (no reflowing), and what does not parse is shown as typed. `lineStart`: the stretch begins a line.
public enum RoomMarkdown {
    public static func attributed(_ s: String, lineStart: Bool) -> AttributedString {
        var out = AttributedString()
        for (i, raw) in s.components(separatedBy: "\n").enumerated() {
            if i > 0 { out += AttributedString("\n") }
            var line = Substring(raw)
            var heading = false
            if i > 0 || lineStart {
                if let rest = headingRest(line) {
                    line = rest
                    heading = true
                } else if let (indent, rest) = bulletRest(line) {
                    out += AttributedString(indent + "• ")
                    line = rest
                }
            }
            var run = (try? AttributedString(markdown: String(line), options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
                                                                                     failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(line)
            if heading {
                for r in run.runs { run[r.range].inlinePresentationIntent = (r.inlinePresentationIntent ?? []).union(.stronglyEmphasized) }
            }
            out += run
        }
        return out
    }

    /// `# Title` → `Title`.
    static func headingRest(_ line: Substring) -> Substring? {
        let hashes = line.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count) else { return nil }
        let after = line.dropFirst(hashes.count)
        let space = after.prefix { $0 == " " || $0 == "\t" }
        guard !space.isEmpty else { return nil }
        return after.dropFirst(space.count)
    }

    /// `  - item` → (`  `, `item`).
    static func bulletRest(_ line: Substring) -> (String, Substring)? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }
        let after = line.dropFirst(indent.count)
        guard let mark = after.first, "-*+".contains(mark) else { return nil }
        let rest = after.dropFirst()
        let space = rest.prefix { $0 == " " || $0 == "\t" }
        guard !space.isEmpty else { return nil }
        return (String(indent), rest.dropFirst(space.count))
    }
}
