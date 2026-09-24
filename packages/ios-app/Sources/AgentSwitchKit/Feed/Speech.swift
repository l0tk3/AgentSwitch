import Foundation

/// What a voice reads (app-v0 §5 朗读): the daemon already asks for text written for the ear and cleans it
/// (threads-v0 §3); this is the phone's own pass before speaking — ciphertexts, links, Markdown markers, @ and _ in
/// handles (not in e-mail addresses), long random-looking strings, long runs of digits (ids nobody wants read out) and
/// the daemon's removal marker never reach the synthesizer. `\b` is not used: next to Chinese it does not match.
public enum Speech {
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
