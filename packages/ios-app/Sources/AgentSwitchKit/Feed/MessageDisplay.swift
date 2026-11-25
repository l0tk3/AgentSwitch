import Foundation

/// How a stored text reads on the phone: the sealer's legend (meant for the agent) is cut off and each ciphertext
/// shows as a lock.
public enum MessageDisplay {
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
