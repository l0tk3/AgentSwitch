import Foundation

/// What stands in the message box for a file it comes with (2026-11-23, user: 粘贴图片/文件的时候应该也有类似于
/// [image] 这样的占位符，就像是终端里一样): `[Image #1]` for a picture, `[File name.ext]` for anything else, put in
/// where the cursor is. Deleting the token takes the file off; taking the file off deletes the token. The tokens go
/// out with the text, so the reader sees where each file belongs.
public struct RoomAttachTokens: Equatable, Sendable {
    public static let pictureKinds: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp"]

    /// Path → its token.
    public private(set) var tokens: [String: String] = [:]
    /// The tokens the box has shown: one not yet put in is not "deleted".
    private var shown: Set<String> = []

    public init() {}

    public static func isPicture(_ path: String) -> Bool { pictureKinds.contains((path as NSString).pathExtension.lowercased()) }

    /// A new token for `path`, unlike any the box has now.
    public mutating func add(_ path: String) -> String {
        if let had = tokens[path] { return had }
        let used = Set(tokens.values)
        var token: String
        if Self.isPicture(path) {
            var n = 1
            repeat { token = "[Image #\(n)]"; n += 1 } while used.contains(token)
        } else {
            let name = (path as NSString).lastPathComponent
            token = "[File \(name)]"
            var n = 2
            while used.contains(token) { token = "[File \(name) #\(n)]"; n += 1 }
        }
        tokens[path] = token
        return token
    }

    /// The box now says `draft`: the paths whose token was there and is gone.
    public mutating func gone(in draft: String) -> [String] {
        var out: [String] = []
        for (path, token) in tokens {
            if draft.contains(token) { shown.insert(token) }
            else if shown.contains(token) { out.append(path) }
        }
        for path in out { forget(path) }
        return out.sorted()
    }

    /// `path` taken off: its token, to be cut from the box.
    @discardableResult public mutating func forget(_ path: String) -> String? {
        guard let token = tokens.removeValue(forKey: path) else { return nil }
        shown.remove(token)
        return token
    }

    public mutating func clear() { tokens = [:]; shown = [] }
}
