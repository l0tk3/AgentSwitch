import Foundation

/// Downloads live in Caches/agentswitch-files/…, emptied when the app starts.
enum FileCache {
    static func root() throws -> URL {
        try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("agentswitch-files", isDirectory: true)
    }

    static func clear() {
        guard let root = try? root() else { return }
        try? FileManager.default.removeItem(at: root)
    }
}
