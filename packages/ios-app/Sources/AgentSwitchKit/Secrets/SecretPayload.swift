import Foundation

/// Plaintext + policy, validated like `SecretPayload.create` in policy.py. Only `SecretPayload.make` builds one, so a
/// value of this type always passed the gate's rules.
public struct SecretPayload: Sendable, Equatable {
    public let value: String
    public let hosts: [String]
    public let uses: [SecretUse]          // sorted, as Python's `sorted(self.uses)`
    public let label: String
    public let kind: SecretKind
    public let seedImportHosts: [String]

    public static func make(value: String, hosts: [String], uses: Set<SecretUse>, label: String,
                            kind: SecretKind = .secret, seedImportHosts: [String] = []) throws -> SecretPayload {
        guard !value.isEmpty else { throw GatePolicyError.emptyValue }
        guard GatePolicy.isValidLabel(label) else { throw GatePolicyError.invalidLabel(label) }
        guard !uses.isEmpty else { throw GatePolicyError.emptyUses }
        let normalized = try hosts.map(GatePolicy.normalizeHost)
        if kind == .totp && !GatePolicy.isBase32(value) { throw GatePolicyError.totpNotBase32 }
        var grants: [String] = []
        for host in try seedImportHosts.map(GatePolicy.normalizeHost) where !grants.contains(host) { grants.append(host) }
        if !grants.isEmpty && kind != .totp { throw GatePolicyError.seedImportNeedsTotp }
        for grant in grants where grant.contains("*") || !normalized.contains(where: { GatePolicy.hostMatches(pattern: $0, host: grant) }) {
            throw GatePolicyError.seedImportNotAllowed(grant)
        }
        return SecretPayload(value: value, hosts: normalized, uses: uses.sorted(), label: label, kind: kind, seedImportHosts: grants)
    }

    /// Byte-identical to `SecretPayload.to_json()`: fixed key order, `separators=(",", ":")`, `ensure_ascii=True`.
    public var jsonText: String {
        let list: ([String]) -> String = { "[" + $0.map(PythonJSON.string).joined(separator: ",") + "]" }
        return "{\"v\":\(PythonJSON.string(value)),\"host\":\(list(hosts)),\"use\":\(list(uses.map(\.rawValue))),"
            + "\"label\":\(PythonJSON.string(label)),\"kind\":\(PythonJSON.string(kind.rawValue)),"
            + "\"seed_import_hosts\":\(list(seedImportHosts))}"
    }

    public var jsonData: Data { Data(jsonText.utf8) }
}

/// Python's `json.dumps` string encoding with `ensure_ascii=True`: printable ASCII passes through except `"` and `\`,
/// the usual short escapes, everything else (DEL included) as lowercase `\uXXXX`, astral code points as surrogate pairs.
enum PythonJSON {
    static func string(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case " "..."~": out.unicodeScalars.append(scalar)
            default:
                for unit in String(scalar).utf16 { out += String(format: "\\u%04x", unit) }
            }
        }
        return out + "\""
    }
}
