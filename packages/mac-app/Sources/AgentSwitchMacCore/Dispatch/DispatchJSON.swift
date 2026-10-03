import Foundation
import os

/// Any JSON value (ported from the iPhone Kit's JSONValue). Event payloads and a few loosely typed daemon fields decode
/// into it, so a new field on the daemon never breaks the Dispatch page.
public enum DispatchJSON: Sendable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([DispatchJSON])
    case object([String: DispatchJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([DispatchJSON].self) { self = .array(a) }
        else if let o = try? c.decode([String: DispatchJSON].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public subscript(key: String) -> DispatchJSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var number: Double? { if case .number(let n) = self { return n }; return nil }
    public var int: Int? { number.flatMap { $0.isFinite && $0 == $0.rounded() ? Int(exactly: $0) : nil } }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var array: [DispatchJSON]? { if case .array(let a) = self { return a }; return nil }
    public var object: [String: DispatchJSON]? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { self == .null }

    /// Compact JSON text with sorted keys, for "show the raw payload" lines.
    public var compactText: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}

/// A value behind an unfair lock, for the event stream's reader and watchdog (they run on different tasks).
final class DispatchLock<Value: Sendable>: Sendable {
    private let lock: OSAllocatedUnfairLock<Value>

    init(_ value: Value) { lock = OSAllocatedUnfairLock(initialState: value) }

    func withLock<R: Sendable>(_ body: @Sendable (inout Value) -> R) -> R { lock.withLock(body) }

    var value: Value { lock.withLock { $0 } }
}

extension Date {
    /// The daemon's epoch milliseconds.
    init(dispatchMilliseconds ms: Int64) { self.init(timeIntervalSince1970: TimeInterval(ms) / 1000) }
}
