import Foundation

/// How a stored text reads on screen (ported from the Kit's MessageDisplay): an old sealer legend (router-v0 §9, meant
/// for the executor; nothing writes it since 2026-11-23, older records still carry it) is cut off and each ciphertext
/// shows as a lock.
public enum DispatchMessageDisplay {
    public static let tokenMark = "🔒密文"
    /// The start of the legend the daemon's removed sealer put after a blank line (daemon assistant/register.ts OLD_LEGEND_START).
    static let legendStart = "\n\n[AgentSwitch sealed the credentials"
    private static let token = try! NSRegularExpression(pattern: "enc:v1:[A-Za-z0-9_-]{16,}={0,2}")

    public static func readable(_ text: String) -> String {
        let body = text.range(of: legendStart).map { String(text[..<$0.lowerBound]) } ?? text
        let range = NSRange(body.startIndex..., in: body)
        return token.stringByReplacingMatches(in: body, range: range, withTemplate: tokenMark)
    }
}
