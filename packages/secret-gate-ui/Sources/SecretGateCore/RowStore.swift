import Foundation

/// Persists the table rows (never the secret values) as JSON so a restart does not lose the labels,
/// hosts, notes and accounts the user typed. Default location: ~/Library/Application Support/SecretGateUI/rows.json.
public struct RowStore: Sendable {
    public let url: URL

    public init(url: URL) { self.url = url }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSString(string: "~/Library/Application Support").expandingTildeInPath)
        return base.appendingPathComponent("SecretGateUI", isDirectory: true).appendingPathComponent("rows.json")
    }

    public func load() -> [TokenEntry] {
        guard let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode([TokenEntry.Saved].self, from: data) else { return [] }
        return saved.map(TokenEntry.init(saved:))
    }

    /// Writes atomically with owner-only permissions; a failure is returned, not thrown, so the UI keeps working.
    @discardableResult
    public func save(_ entries: [TokenEntry]) -> Error? {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try enc.encode(entries.map(\.saved))
            try data.write(to: url, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return nil
        } catch {
            return error
        }
    }
}
