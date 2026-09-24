import Foundation

/// Append-only child logs in ~/Library/Logs/AgentSwitch, rotated once at open when they grow too big.
public enum LogFiles {
    public static let rotateBytes: UInt64 = 10 * 1024 * 1024

    public static func shouldRotate(size: UInt64, limit: UInt64 = rotateBytes) -> Bool {
        size >= limit
    }

    /// Opens `url` for appending (creating it 0600 in a 0700 directory), after moving an oversized file to `.1`.
    public static func open(_ url: URL, header: String, now: Date = Date()) throws -> FileHandle {
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? UInt64, shouldRotate(size: size) {
            let old = url.appendingPathExtension("1")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: url, to: old)
        }
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(stamp(header, now: now).utf8))
        return handle
    }

    public static func appendLine(_ url: URL?, _ line: String, now: Date = Date()) {
        guard let url, let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(stamp(line, now: now).utf8))
    }

    static func stamp(_ line: String, now: Date) -> String {
        "=== \(ISO8601DateFormatter().string(from: now)) \(line)\n"
    }

    /// Last `maxLines` lines, for showing why a child keeps dying.
    public static func tail(_ url: URL, maxLines: Int = 20, maxBytes: Int = 16_384) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try? handle.seek(toOffset: start)
        let data = (try? handle.readToEnd()) ?? Data()
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
        return lines.suffix(maxLines).joined(separator: "\n")
    }
}
