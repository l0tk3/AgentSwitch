import Foundation

/// Plaintext + policy, validated like `SecretPayload.create` in policy.py. Only `SecretPayload.make` builds one, so a
/// value of this type always passed the gate's rules.
public struct SecretPayload: Sendable, Equatable {
    public let value: String
    public let hosts: [String]
    public let uses: [SecretUse]          // sorted, as Python's `sorted(self.uses)`
    public let label: String
    public let kind: SecretKind

    /// A site that needs a TOTP seed itself gets it as an ordinary `secret` sealed for `fill` on that site
    /// (gate-simple-v0 §1); there is no seed-import grant any more.
    public static func make(value: String, hosts: [String], uses: Set<SecretUse>, label: String,
                            kind: SecretKind = .secret) throws -> SecretPayload {
        guard !value.isEmpty else { throw GatePolicyError.emptyValue }
        guard GatePolicy.isValidLabel(label) else { throw GatePolicyError.invalidLabel(label) }
        guard !uses.isEmpty else { throw GatePolicyError.emptyUses }
        let normalized = try hosts.map(GatePolicy.normalizeHost)
        if kind == .totp && !GatePolicy.isBase32(value) { throw GatePolicyError.totpNotBase32 }
        // Last, as `secret-gate enc` checks it after `create` (policy.check_seal_length): only sealing builds one here.
        if GatePolicy.isTooShortToSeal(value, uses: uses) { throw GatePolicyError.valueTooShort }
        return SecretPayload(value: value, hosts: normalized, uses: uses.sorted(), label: label, kind: kind)
    }

    /// Byte-identical to `SecretPayload.to_json()`: fixed key order, `separators=(",", ":")`, `ensure_ascii=True`.
    public var jsonText: String {
        let list: ([String]) -> String = { "[" + $0.map(PythonJSON.string).joined(separator: ",") + "]" }
        return "{\"v\":\(PythonJSON.string(value)),\"host\":\(list(hosts)),\"use\":\(list(uses.map(\.rawValue))),"
            + "\"label\":\(PythonJSON.string(label)),\"kind\":\(PythonJSON.string(kind.rawValue))}"
    }

    public var jsonData: Data { Data(jsonText.utf8) }

    /// What is sealed (tokens.sealed_plaintext, gate-simple-v0 §3.4): `jsonData` padded with trailing ASCII spaces to a
    /// multiple of `GatePolicy.sealPadBlock` bytes, so a ciphertext's length does not follow the value's. JSON allows
    /// trailing whitespace and the gate strips it before parsing.
    public var sealedData: Data {
        var data = jsonData
        let pad = (GatePolicy.sealPadBlock - data.count % GatePolicy.sealPadBlock) % GatePolicy.sealPadBlock
        data.append(contentsOf: [UInt8](repeating: 0x20, count: pad))
        return data
    }
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
