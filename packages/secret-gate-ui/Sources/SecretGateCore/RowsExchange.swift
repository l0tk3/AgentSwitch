import Foundation

/// Import/export of the whole table as JSON, the counterpart of the CSV paste: every field including the
/// secret value, so a set of rows can be moved between machines or kept in a password manager. The text
/// contains plaintext secrets and must never be pasted into a model context.
public enum RowsExchange {
    public struct Row: Codable, Sendable {
        public var label: String
        public var hosts: String
        public var kind: SecretKind
        public var uses: [SecretUse]
        public var value: String
        public var note: String
        public var account: String
        public var encryptAccount: Bool

        public init(_ e: TokenEntry) {
            label = e.label; hosts = e.hosts; kind = e.kind; uses = e.uses.map(\.rawValue).sorted().compactMap(SecretUse.init(rawValue:))
            value = e.value; note = e.note; account = e.account; encryptAccount = e.encryptAccount
        }

        public var entry: TokenEntry {
            TokenEntry(label: label, hosts: hosts, kind: kind, uses: Set(uses), value: value, note: note, account: account, encryptAccount: encryptAccount)
        }
    }

    public static func export(_ entries: [TokenEntry]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = (try? enc.encode(entries.map(Row.init))) ?? Data("[]".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// JSON array (as exported) or the CSV lines the paste sheet always accepted; whichever the text looks like.
    public static func parse(_ text: String) -> [TokenEntry] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("["), let rows = try? JSONDecoder().decode([Row].self, from: Data(trimmed.utf8)) {
            return rows.map(\.entry)
        }
        return CSVImport.parse(text)
    }
}
