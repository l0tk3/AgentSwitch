import Foundation

public enum SecretKind: String, CaseIterable, Codable, Sendable {
    case secret, totp

    public var title: String {
        switch self {
        case .secret: return "密码 / token"
        case .totp: return "2FA 密钥 (TOTP)"
        }
    }
}

public enum SecretUse: String, CaseIterable, Codable, Sendable, Comparable {
    case exec, fill, http, otp

    public static func < (a: SecretUse, b: SecretUse) -> Bool { a.rawValue < b.rawValue }

    public var title: String {
        switch self {
        case .http: return "http（代理替换）"
        case .otp: return "otp（取验证码）"
        case .exec: return "exec（本地命令模板）"
        case .fill: return "fill（只填浏览器表单）"
        }
    }
}

public enum GatePolicyError: Error, Equatable, LocalizedError {
    case emptyValue
    case invalidLabel(String)
    case invalidHost(String)
    case emptyUses
    case totpNotBase32
    case seedImportNeedsTotp
    case seedImportNotAllowed(String)

    public var errorDescription: String? {
        switch self {
        case .emptyValue: return "值不能为空"
        case .invalidLabel(let l): return "label 不合法：\(l)（字母或数字开头，只含字母数字 . _ / -，最长 64）"
        case .invalidHost(let h): return "host 不合法：\(h)"
        case .emptyUses: return "至少选一种用途"
        case .totpNotBase32: return "TOTP 密钥必须是 base32"
        case .seedImportNeedsTotp: return "种子导入授权只适用于 TOTP"
        case .seedImportNotAllowed(let h): return "种子导入目标必须是 host 已允许的确切地址：\(h)"
        }
    }
}

/// Client-side mirror of `secret_gate/policy.py` and `constants.py`. The gate re-validates when it decrypts, so this
/// only has to be at least as strict; where Python is looser by accident (a trailing newline passing `$`, non-ASCII
/// digits in a port) this rejects.
public enum GatePolicy {
    public static let labelMaxLength = 64

    /// `^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$`
    public static func isValidLabel(_ label: String) -> Bool {
        let scalars = Array(label.unicodeScalars)
        guard (1...labelMaxLength).contains(scalars.count), isAlnum(scalars[0]) else { return false }
        return scalars.dropFirst().allSatisfy { isAlnum($0) || $0 == "." || $0 == "_" || $0 == "/" || $0 == "-" }
    }

    /// policy.normalize_host: trim, lowercase, split an optional `:port` (1-65535), strip trailing dots from the name,
    /// then the name must be `(*.)?label(.label)*` with DNS-style labels. Returns `name` or `name:port`.
    public static func normalizeHost(_ host: String) throws -> String {
        let text = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var (name, port) = try splitHostPort(text, original: host)
        while name.hasSuffix(".") { name.removeLast() }
        guard isValidHostPattern(name) else { throw GatePolicyError.invalidHost(host) }
        return port.map { "\(name):\($0)" } ?? name
    }

    /// policy.host_matches: exact name or `*.suffix` (not the apex); a pattern port must equal the host's port.
    public static func hostMatches(pattern: String, host: String) -> Bool {
        guard let (pName, pPort) = try? splitHostPort(pattern, original: pattern),
              let (hName, hPort) = try? splitHostPort(host, original: host) else { return false }
        if let pPort, pPort != hPort { return false }
        if pName.hasPrefix("*.") {
            let suffix = String(pName.dropFirst())  // ".example.com"
            return hName.hasSuffix(suffix) && hName.count > suffix.count
        }
        return pName == hName
    }

    /// policy._validate_base32: uppercase, drop spaces, pad to a multiple of 8, then Python's b32decode rules
    /// (A-Z2-7 only, padding length one of 0, 1, 3, 4, 6).
    public static func isBase32(_ value: String) -> Bool {
        var s = value.uppercased().replacingOccurrences(of: " ", with: "")
        s += String(repeating: "=", count: (8 - s.count % 8) % 8)
        let total = s.count
        while s.hasSuffix("=") { s.removeLast() }
        let padding = total - s.count
        guard s.unicodeScalars.allSatisfy({ ("A"..."Z").contains($0) || ("2"..."7").contains($0) }) else { return false }
        return total % 8 == 0 && [0, 1, 3, 4, 6].contains(padding)
    }

    // MARK: - helpers

    static func splitHostPort(_ text: String, original: String) throws -> (String, Int?) {
        guard let colon = text.lastIndex(of: ":") else { return (text, nil) }
        let name = String(text[..<colon])
        let portText = text[text.index(after: colon)...]
        guard !name.isEmpty, !name.contains(":"), !portText.isEmpty,
              portText.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) }),
              let port = Int(portText), (1...65535).contains(port) else {
            throw GatePolicyError.invalidHost(original)
        }
        return (name, port)
    }

    /// `^(\*\.)?(?:LABEL\.)*LABEL$` with LABEL = `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`
    static func isValidHostPattern(_ name: String) -> Bool {
        var rest = Substring(name)
        if rest.hasPrefix("*.") { rest = rest.dropFirst(2) }
        let labels = rest.split(separator: ".", omittingEmptySubsequences: false)
        return !labels.isEmpty && labels.allSatisfy(isValidDNSLabel)
    }

    private static func isValidDNSLabel(_ label: Substring) -> Bool {
        let scalars = Array(label.unicodeScalars)
        guard let first = scalars.first, let last = scalars.last else { return false }
        let lowerAlnum: (Unicode.Scalar) -> Bool = { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        return lowerAlnum(first) && lowerAlnum(last) && scalars.allSatisfy { lowerAlnum($0) || $0 == "-" }
    }

    private static func isAlnum(_ s: Unicode.Scalar) -> Bool {
        ("A"..."Z").contains(s) || ("a"..."z").contains(s) || ("0"..."9").contains(s)
    }
}
