import Foundation

/// Any string key, so decoders can accept both the camelCase the daemon uses and snake_case (`expiresAt` /
/// `expires_at`) while the remote API settles (docs/app-v0.md names fields in both styles).
struct AnyKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

extension KeyedDecodingContainer where Key == AnyKey {
    /// First present, non-null key among `keys` decoded as T; nil when none is.
    func first<T: Decodable>(_ type: T.Type, _ keys: String...) -> T? {
        for key in keys {
            let k = AnyKey(key)
            if contains(k), (try? decodeNil(forKey: k)) == false, let value = try? decode(T.self, forKey: k) { return value }
        }
        return nil
    }

    func require<T: Decodable>(_ type: T.Type, _ keys: String...) throws -> T {
        for key in keys {
            let k = AnyKey(key)
            if contains(k), (try? decodeNil(forKey: k)) == false, let value = try? decode(T.self, forKey: k) { return value }
        }
        throw DecodingError.keyNotFound(AnyKey(keys.first ?? "?"), .init(codingPath: codingPath,
                                                                          debugDescription: "none of \(keys) present"))
    }

    /// Epoch milliseconds (the daemon's convention), epoch seconds, or an ISO-8601 string.
    func date(_ keys: String...) -> Date? {
        for key in keys {
            let k = AnyKey(key)
            guard contains(k), (try? decodeNil(forKey: k)) == false else { continue }
            if let number = try? decode(Double.self, forKey: k) { return FlexibleDate.fromNumber(number) }
            if let text = try? decode(String.self, forKey: k), let date = FlexibleDate.parse(text) { return date }
        }
        return nil
    }
}

public enum FlexibleDate {
    /// Values above 1e11 are milliseconds (1e11 s is the year 5138).
    public static func fromNumber(_ value: Double) -> Date {
        Date(timeIntervalSince1970: value > 1e11 ? value / 1000 : value)
    }

    public static func parse(_ text: String) -> Date? {
        if let number = Double(text) { return fromNumber(number) }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}

/// A list of model ids that may arrive as `["a","b"]`, `[{"id":"a"}]` or `{"a": {...}}` (targets.yaml shape).
struct FlexibleStringList: Decodable {
    let values: [String]

    init(from decoder: Decoder) throws {
        if let list = try? decoder.singleValueContainer().decode([String].self) {
            values = list
            return
        }
        if var array = try? decoder.unkeyedContainer() {
            var out: [String] = []
            while !array.isAtEnd {
                let item = try array.nestedContainer(keyedBy: AnyKey.self)
                if let id = item.first(String.self, "id", "model", "name") { out.append(id) }
            }
            values = out
            return
        }
        let keyed = try decoder.container(keyedBy: AnyKey.self)
        values = keyed.allKeys.map(\.stringValue).sorted()
    }
}
