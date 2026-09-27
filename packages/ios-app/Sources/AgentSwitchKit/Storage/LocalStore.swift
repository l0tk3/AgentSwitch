import Foundation

/// A token saved on the phone: the ciphertext and the user's note, nothing else. It is not a secret (only the Mac's
/// gate can open it), but it is still kept out of logs and the shared clipboard.
public struct SavedCiphertext: Codable, Sendable, Hashable, Identifiable {
    public let id: UUID
    public let token: String
    public let note: String
    public let createdAt: Date
    /// Fingerprint of the Mac whose gate key sealed it: only that Mac can open it. Nil for tokens saved before the
    /// phone knew several Macs.
    public let mac: String?

    public init(id: UUID = UUID(), token: String, note: String, createdAt: Date = Date(), mac: String? = nil) {
        self.id = id
        self.token = token
        self.note = note
        self.createdAt = createdAt
        self.mac = mac
    }

    /// Worth offering while `current` is the Mac in use: made for it, untagged, or made for a Mac no longer paired
    /// (a Mac set up again after a reinstall comes back with a new fingerprint and most likely the same gate).
    public func usable(with current: String?, paired: [String]) -> Bool {
        guard let mac else { return true }
        return mac == current || !paired.contains(mac)
    }

    /// `enc:v1:AbCd…wXyZ`, enough to tell tokens apart.
    public var shortToken: String {
        guard token.count > 24 else { return token }
        return "\(token.prefix(15))…\(token.suffix(6))"
    }
}

public enum StoreError: Error, LocalizedError {
    case io(String)

    public var errorDescription: String? {
        if case .io(let message) = self { return "本地存储失败：\(message)" }
        return nil
    }
}

/// JSON files under Application Support: the paired Macs and the saved ciphertexts. No plaintext secret
/// and no device token ever goes here (the token is in the Keychain).
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
    private var ciphertextsURL: URL { directory.appendingPathComponent("ciphertexts.json") }

    public func loadMacs() throws -> PairedMacs {
        if let saved = try read(PairedMacs.self, from: macsURL) { return PairedMacs(servers: saved.servers, active: saved.active) }
        guard let legacy = try read(ServerProfile.self, from: legacyProfileURL) else { return PairedMacs() }
        let macs = PairedMacs(servers: [legacy])
        try saveMacs(macs)
        try remove(legacyProfileURL)
        return macs
    }

    public func saveMacs(_ macs: PairedMacs) throws { try write(macs, to: macsURL) }

    public func loadCiphertexts() throws -> [SavedCiphertext] { try read([SavedCiphertext].self, from: ciphertextsURL) ?? [] }
    public func saveCiphertexts(_ items: [SavedCiphertext]) throws { try write(items, to: ciphertextsURL) }

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
