import Foundation

/// The gate's current keypair as the Mac hands it over (`GET /gate/pubkey` has the same shape).
public struct GateKey: Codable, Sendable, Hashable {
    public let publicKey: String   // base64url, 32 bytes
    public let keypair: String

    public init(publicKey: String, keypair: String) {
        self.publicKey = publicKey
        self.keypair = keypair
    }

    public var isValid: Bool { (try? TokenMinter(publicKeyBase64URL: publicKey)) != nil }
}

/// The JSON inside `agentswitch://pair?p=…` (app-v0 §2), version 1.
public struct PairingPayload: Codable, Sendable, Equatable {
    public let v: Int
    public let name: String
    public let port: Int
    public let fp: String
    public let code: String
    public let lan: [String]
    public let tailnet: [String]
    public let bonjour: String
    /// Optional here so a Mac without a gate keypair can still pair; the phone then asks `GET /gate/pubkey`.
    public let gate: GateKey?

    public init(v: Int = 1, name: String, port: Int, fp: String, code: String, lan: [String], tailnet: [String],
                bonjour: String, gate: GateKey?) {
        self.v = v
        self.name = name
        self.port = port
        self.fp = fp
        self.code = code
        self.lan = lan
        self.tailnet = tailnet
        self.bonjour = bonjour
        self.gate = gate
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        name = try c.decode(String.self, forKey: .name)
        port = try c.decode(Int.self, forKey: .port)
        fp = try c.decode(String.self, forKey: .fp)
        code = try c.decode(String.self, forKey: .code)
        lan = try c.decodeIfPresent([String].self, forKey: .lan) ?? []
        tailnet = try c.decodeIfPresent([String].self, forKey: .tailnet) ?? []
        bonjour = try c.decodeIfPresent(String.self, forKey: .bonjour) ?? ""
        gate = try c.decodeIfPresent(GateKey.self, forKey: .gate)
    }
}

public enum PairingLinkError: Error, Equatable, LocalizedError {
    case notALink
    case missingPayload
    case badEncoding
    case badJSON
    case unsupportedVersion(Int)
    case invalidField(String)

    public var errorDescription: String? {
        switch self {
        case .notALink: return "不是 AgentSwitch 配对链接（应以 agentswitch://pair 开头）"
        case .missingPayload: return "配对链接缺少内容"
        case .badEncoding: return "配对链接内容不是有效的 base64url"
        case .badJSON: return "配对链接内容无法解析"
        case .unsupportedVersion(let v): return "不支持的配对版本 v=\(v)，请更新 App"
        case .invalidField(let f): return "配对信息字段无效：\(f)"
        }
    }
}

/// `agentswitch://pair?p=<base64url(JSON)>`: parse and validate. Nothing here trusts the link beyond its shape; the
/// fingerprint it carries is what every later TLS connection is pinned to.
public enum PairingLink {
    public static let scheme = "agentswitch"
    public static let host = "pair"
    public static let supportedVersion = 1

    /// Accepts the bare link or text that contains it (a pasted message).
    public static func parse(_ text: String) throws -> PairingPayload {
        guard let link = extractLink(text), let comps = URLComponents(string: link),
              comps.scheme?.lowercased() == scheme, comps.host?.lowercased() == host else { throw PairingLinkError.notALink }
        guard let p = comps.queryItems?.first(where: { $0.name == "p" })?.value, !p.isEmpty else { throw PairingLinkError.missingPayload }
        guard let data = Base64URL.decode(p) else { throw PairingLinkError.badEncoding }
        let payload: PairingPayload
        do { payload = try JSONDecoder().decode(PairingPayload.self, from: data) } catch { throw PairingLinkError.badJSON }
        return try validate(payload)
    }

    /// The link for a payload (tests and previews; the Mac builds the real one).
    public static func make(_ payload: PairingPayload) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = (try? encoder.encode(payload)) ?? Data()
        return "\(scheme)://\(host)?p=\(Base64URL.encode(data))"
    }

    /// Normalizes the fingerprint and code; rejects anything that could not be a v1 payload.
    public static func validate(_ p: PairingPayload) throws -> PairingPayload {
        guard p.v == supportedVersion else { throw PairingLinkError.unsupportedVersion(p.v) }
        let name = p.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 128 else { throw PairingLinkError.invalidField("name") }
        guard (1...65535).contains(p.port) else { throw PairingLinkError.invalidField("port") }
        guard let fp = CertificatePin.normalize(p.fp) else { throw PairingLinkError.invalidField("fp") }
        guard let code = normalizeCode(p.code) else { throw PairingLinkError.invalidField("code") }
        guard p.lan.allSatisfy(HostAddress.isValid) else { throw PairingLinkError.invalidField("lan") }
        guard p.tailnet.allSatisfy(HostAddress.isValid) else { throw PairingLinkError.invalidField("tailnet") }
        guard !(p.lan.isEmpty && p.tailnet.isEmpty && p.bonjour.isEmpty) else { throw PairingLinkError.invalidField("lan/tailnet/bonjour") }
        if let gate = p.gate, !gate.isValid { throw PairingLinkError.invalidField("gate.publicKey") }
        return PairingPayload(v: p.v, name: name, port: p.port, fp: fp, code: code, lan: p.lan, tailnet: p.tailnet,
                              bonjour: p.bonjour, gate: p.gate)
    }

    /// `XXXX-XXXX`, decoded like the daemon's normalizeCode (remote/pairing.ts): case-insensitive, dashes and spaces
    /// ignored, O → 0, I and L → 1; the result is canonical.
    public static func normalizeCode(_ code: String) -> String? {
        let mapped: [Character: Character] = ["O": "0", "I": "1", "L": "1"]
        let raw = String(code.uppercased().filter { $0 != "-" && !$0.isWhitespace }.map { mapped[$0] ?? $0 })
        let alphabet = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        guard raw.count == 8, raw.allSatisfy(alphabet.contains) else { return nil }
        return "\(raw.prefix(4))-\(raw.suffix(4))"
    }

    private static func extractLink(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.range(of: "\(scheme)://", options: .caseInsensitive) else { return nil }
        let tail = trimmed[start.lowerBound...]
        let end = tail.firstIndex(where: { $0.isWhitespace || $0 == "\"" || $0 == "'" || $0 == "<" || $0 == ">" }) ?? tail.endIndex
        return String(tail[..<end])
    }
}

/// Addresses from the pairing payload end up in URLs, so they must be plain IP literals or DNS names.
public enum HostAddress {
    public static func isValid(_ host: String) -> Bool {
        isIPv4(host) || isIPv6(host) || isDNSName(host)
    }

    public static func isIPv4(_ host: String) -> Bool {
        var addr = in_addr()
        return host.withCString { inet_pton(AF_INET, $0, &addr) } == 1
    }

    public static func isIPv6(_ host: String) -> Bool {
        var addr = in6_addr()
        return host.withCString { inet_pton(AF_INET6, $0, &addr) } == 1
    }

    public static func isDNSName(_ host: String) -> Bool {
        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        guard !name.isEmpty, name.utf8.count <= 253 else { return false }
        return name.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            guard (1...63).contains(label.utf8.count), label.first != "-", label.last != "-" else { return false }
            return label.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-") }
        }
    }

    /// `host` as it goes into a URL authority: IPv6 literals in brackets.
    public static func urlHost(_ host: String) -> String {
        isIPv6(host) ? "[\(host)]" : host
    }
}
