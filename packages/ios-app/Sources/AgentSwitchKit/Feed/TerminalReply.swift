import Foundation

/// Whether a reply about to go to a terminal as typed looks like it holds a password or token (terminal-v0 §1, second
/// round): then the phone offers the sealed send instead. A guess on the phone, with no model — it only has to catch
/// the usual shapes: known token prefixes, a private key, "密码：…" and the like, a long random-looking word. Text
/// already sealed (`enc:v1:…`, `enc:ref:…`) does not count.
public enum SecretHint {
    private static let patterns: [NSRegularExpression] = [
        #"sk-[A-Za-z0-9_-]{20,}"#,                                  // OpenAI, Anthropic
        #"gh[pousr]_[A-Za-z0-9]{30,}"#, #"github_pat_[A-Za-z0-9_]{30,}"#,
        #"xox[abpr]-[A-Za-z0-9-]{10,}"#,                             // Slack
        #"AKIA[0-9A-Z]{16}"#,                                        // AWS
        #"AIza[0-9A-Za-z_-]{35}"#,                                   // Google
        #"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"#,   // a JWT
        #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#,
        #"(?i)(password|passwd|pwd|passcode|secret|token|api[ _-]?key|密码|口令|验证码|令牌|密钥)\s*(?:[:：=]|是|为)\s*\S{4,}"#,
    ].map { try! NSRegularExpression(pattern: $0) }
    private static let sealed = try! NSRegularExpression(pattern: #"enc:(?:v1|ref):\S+"#)

    public static func looksSecret(_ text: String) -> Bool {
        let range = NSRange(text.startIndex..., in: text)
        let plain = sealed.stringByReplacingMatches(in: text, range: range, withTemplate: " ")
        let all = NSRange(plain.startIndex..., in: plain)
        if patterns.contains(where: { $0.firstMatch(in: plain, range: all) != nil }) { return true }
        return plain.split(whereSeparator: \.isWhitespace).contains { randomLooking(String($0)) }
    }

    /// 24 characters or more, upper and lower case and digits, many different ones, and not a path or an address.
    static func randomLooking(_ word: String) -> Bool {
        guard word.count >= 24, !word.contains("/"), !word.contains("."), !word.contains("@") else { return false }
        let hasUpper = word.contains(where: \.isUppercase), hasLower = word.contains(where: \.isLowercase), hasDigit = word.contains(where: \.isNumber)
        return hasUpper && hasLower && hasDigit && Set(word).count >= 14
    }
}

/// A slash command the terminal's agent takes (`GET /terminals/:id/commands`): its own, or one of yours (a command
/// file or skill in your home or the project).
public struct SlashCommand: Decodable, Sendable, Hashable, Identifiable {
    /// Without the slash: "compact", "frontend:lint".
    public let name: String
    public let description: String
    /// builtin · user · project
    public let source: String

    public var id: String { name }

    public init(name: String, description: String, source: String = "builtin") {
        self.name = name
        self.description = description
        self.source = source
    }

    public static let shown = 6

    /// The commands `text` may be the start of: while it is a slash and no space yet, names that start with what
    /// follows the slash first, then names with a word that does (`/lint` finds `frontend:lint`); at most `shown`.
    public static func matching(_ text: String, in commands: [SlashCommand]) -> [SlashCommand] {
        guard text.hasPrefix("/"), !text.contains(where: \.isWhitespace) else { return [] }
        let typed = text.dropFirst().lowercased()
        let starts = commands.filter { $0.name.lowercased().hasPrefix(typed) }
        let inside = typed.isEmpty ? [] : commands.filter { c in
            !c.name.lowercased().hasPrefix(typed)
                && c.name.lowercased().split(whereSeparator: { ":-_".contains($0) }).contains { $0.hasPrefix(typed) }
        }
        let found = starts + inside
        // A complete name alone needs no list.
        if found.count == 1, found[0].name.lowercased() == typed { return [] }
        return Array(found.prefix(shown))
    }
}
