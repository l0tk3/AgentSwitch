import Foundation

public enum StoreError: Error, LocalizedError {
    case io(String)

    public var errorDescription: String? {
        if case .io(let message) = self { return "本地存储失败：\(message)" }
        return nil
    }
}

/// JSON files under Application Support: the paired Macs. No device token ever goes here (the token is in the
/// Keychain).
public struct LocalStore: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// `<Application Support>/AgentSwitch`.
    public static func standard() throws -> LocalStore {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw StoreError.io("no Application Support directory")
        }
        return LocalStore(directory: base.appendingPathComponent("AgentSwitch", isDirectory: true))
    }

    private var macsURL: URL { directory.appendingPathComponent("macs.json") }
    /// The one Mac of the versions before 2026-09-27, moved into `macs.json` on first load.
    private var legacyProfileURL: URL { directory.appendingPathComponent("server.json") }

    public func loadMacs() throws -> PairedMacs {
        if let saved = try read(PairedMacs.self, from: macsURL) { return PairedMacs(servers: saved.servers, active: saved.active) }
        guard let legacy = try read(ServerProfile.self, from: legacyProfileURL) else { return PairedMacs() }
        let macs = PairedMacs(servers: [legacy])
        try saveMacs(macs)
        try remove(legacyProfileURL)
        return macs
    }

    public func saveMacs(_ macs: PairedMacs) throws { try write(macs, to: macsURL) }

    // MARK: - files

    private func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(T.self, from: Data(contentsOf: url))
        } catch {
            throw StoreError.io("\(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS)
            options.insert(.completeFileProtection)
            #endif
            try encoder.encode(value).write(to: url, options: options)
        } catch {
            throw StoreError.io("\(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    private func remove(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do { try FileManager.default.removeItem(at: url) } catch { throw StoreError.io(error.localizedDescription) }
    }
}
