import Foundation

/// base64url as the gate and the daemon write it: `-_` alphabet, padding stripped. Decoding accepts optional padding
/// but nothing outside the url-safe alphabet.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        while s.hasSuffix("=") { s.removeLast() }
        return s
    }

    public static func encode(_ bytes: [UInt8]) -> String { encode(Data(bytes)) }

    public static func decode(_ text: String) -> Data? {
        var body = Substring(text)
        var padding = 0
        while body.hasSuffix("=") { body = body.dropLast(); padding += 1 }
        guard padding <= 2, body.allSatisfy(isURLSafe) else { return nil }
        if padding > 0 && (body.count + padding) % 4 != 0 { return nil }
        var standard = body.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
        return Data(base64Encoded: standard)
    }

    private static func isURLSafe(_ c: Character) -> Bool {
        guard c.isASCII, let a = c.asciiValue else { return false }
        return (a >= 0x41 && a <= 0x5A) || (a >= 0x61 && a <= 0x7A) || (a >= 0x30 && a <= 0x39) || a == 0x2D || a == 0x5F
    }
}

extension Data {
    /// Lowercase hex, as the daemon prints certificate fingerprints.
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
