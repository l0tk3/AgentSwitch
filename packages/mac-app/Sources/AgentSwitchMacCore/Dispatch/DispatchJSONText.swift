import Foundation

/// JSON written for people, as the web console writes it (`JSON.stringify(value, null, 2)`): `"key": value`, two
/// spaces a level, numbers in their shortest form (`0.86`, `5`), keys sorted (the order is not kept on decoding).
public extension DispatchJSON {
    func prettyText(indent: Int = 0) -> String {
        let pad = String(repeating: "  ", count: indent), inner = String(repeating: "  ", count: indent + 1)
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return Self.number(n)
        case .string(let s): return Self.quoted(s)
        case .array(let items):
            guard !items.isEmpty else { return "[]" }
            return "[\n" + items.map { inner + $0.prettyText(indent: indent + 1) }.joined(separator: ",\n") + "\n\(pad)]"
        case .object(let fields):
            guard !fields.isEmpty else { return "{}" }
            let lines = fields.keys.sorted().map { key in "\(inner)\(Self.quoted(key)): \(fields[key]!.prettyText(indent: indent + 1))" }
            return "{\n" + lines.joined(separator: ",\n") + "\n\(pad)}"
        }
    }

    private static func number(_ n: Double) -> String {
        guard n.isFinite else { return "null" }
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return "\(n)"   // Swift prints the shortest text that reads back as the same double
    }

    private static func quoted(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let c where c.value < 0x20: out += String(format: "\\u%04x", c.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}
