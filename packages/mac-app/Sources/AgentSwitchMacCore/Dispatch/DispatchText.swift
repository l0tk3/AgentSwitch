import Foundation

/// How a stored text reads on screen (ported from the Kit's MessageDisplay): the sealer's legend (router-v0 §9, meant
/// for the executor) is cut off and each ciphertext shows as a lock.
public enum DispatchMessageDisplay {
    public static let tokenMark = "🔒密文"
    /// The start of the daemon's LEGEND_HEADER after the blank line `legend()` puts before it (daemon src/secrets/sealer.ts).
    static let legendStart = "\n\n[AgentSwitch sealed the credentials"
    private static let token = try! NSRegularExpression(pattern: "enc:v1:[A-Za-z0-9_-]{16,}={0,2}")

    public static func readable(_ text: String) -> String {
        let body = text.range(of: legendStart).map { String(text[..<$0.lowerBound]) } ?? text
        let range = NSRange(body.startIndex..., in: body)
        return token.stringByReplacingMatches(in: body, range: range, withTemplate: tokenMark)
    }
}

/// What a voice reads, and the card's spoken summary (ported from the Kit's Speech): ciphertexts, links, Markdown
/// markers, @ and _ in handles (not in e-mail addresses), long random-looking strings, long runs of digits and the
/// daemon's removal marker are dropped. `\b` is not used: next to Chinese it does not match.
public enum DispatchSpeech {
    private static let rules: [(NSRegularExpression, String)] = [
        ("(?<![A-Za-z0-9_])enc:(?:v1|ref):[A-Za-z0-9_=-]{8,}", " "),
        ("(?<![A-Za-z0-9_])https?://\\S+", " "),
        ("\\s*\\[removed: not a secret-gate token\\]", ""),
        ("(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*[0-9])[A-Za-z0-9_+/=-]{16,}(?![A-Za-z0-9_+/=-])", " "),
        ("(?m)^\\s*(?:#{1,6}\\s+|[-*+]\\s+|\\d{1,3}[.)]\\s+|>\\s*)", ""),
        ("\\*\\*|__|~~|`+", ""),
        ("\\|", " "),
        ("(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_]{1,30})", "$1"),
        ("(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])", " "),
        ("\\d{8,}", " "),
        ("\\s+", " "),
        ("\\s+([，。！？、；：,.!?;:）」』】])", "$1"),
        ("([，。！？、；：（「『【])\\s+", "$1"),
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    public static func speakable(_ text: String) -> String {
        var out = text
        for (pattern, template) in rules {
            out = pattern.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template)
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum DispatchText {
    /// One line, at most `limit` characters, an ellipsis when cut.
    public static func clip(_ text: String, _ limit: Int) -> String {
        let one = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.count > limit ? String(one.prefix(max(limit - 1, 0))) + "…" : one
    }

    /// The first non-empty line.
    public static func firstLine(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: true)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    }
}

/// Durations in the status line and the process list, as the web console writes them (ui/lib/api.js `span`): `40s`,
/// `2m 14s`, `1m 02s`, `1h 05m`.
public enum DispatchClock {
    public static func span(milliseconds ms: Int64) -> String {
        let s = max(0, Int((Double(ms) / 1000).rounded()))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m " + String(format: "%02ds", s % 60) }
        return "\(s / 3600)h " + String(format: "%02dm", s % 3600 / 60)
    }

    /// A tool call's time in the process list: `0.1s` under a second, else as `span`.
    public static func short(seconds: TimeInterval) -> String {
        if seconds < 1 { return String(format: "%.1fs", max(seconds, 0.1)) }
        return span(milliseconds: Int64(seconds * 1000))
    }

    /// A task's clock on its status line: how long it has run (active) or ran (ended), by its own times.
    public static func taskClock(_ task: DispatchTask, now: Date = Date()) -> String {
        let end = task.status.isActive ? Int64(now.timeIntervalSince1970 * 1000) : task.updatedAt
        return span(milliseconds: end - task.createdAt)
    }
}
