import Foundation

/// Stable GitHub releases only. Checking never downloads, stages or installs an app.
public enum ReleaseCheck {
    public static let repository = "l0tk3/AgentSwitch"
    public static let releasesURL = URL(string: "https://github.com/\(repository)/releases")!
    public struct Release: Decodable, Sendable {
        public let tag_name: String
        public let draft: Bool
        public let prerelease: Bool
        public var version: String { String(tag_name.dropFirst()) }
        public var page: URL { ReleaseCheck.releasesURL.appendingPathComponent("tag").appendingPathComponent(tag_name) }
    }
    public enum Problem: LocalizedError {
        case noRelease, rateLimited, response(Int), invalidVersion
        public var errorDescription: String? {
            switch self {
            case .noRelease: "GitHub 尚无正式发布的版本。"
            case .rateLimited: "GitHub 请求受限，请稍后再试，或直接查看发布页。"
            case .response(let code): "检查更新失败（HTTP \(code)）。"
            case .invalidVersion: "版本信息无效，无法比较，请查看发布页。"
            }
        }
    }
    public static func components(_ version: String) -> [Int]? {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let values = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.allSatisfy({ $0.isASCII && $0.isNumber }), part.count == 1 || part.first != "0" else { return nil }
            return Int(part)
        }
        return values.count == 3 ? values : nil
    }
    public static func newer(_ candidate: String, than current: String) throws -> Bool {
        guard let next = components(candidate), let own = components(current) else { throw Problem.invalidVersion }
        return own.lexicographicallyPrecedes(next)
    }
    public static func decode(_ data: Data, status: Int) throws -> Release {
        if status == 404 { throw Problem.noRelease }
        if status == 403 || status == 429 { throw Problem.rateLimited }
        guard status == 200 else { throw Problem.response(status) }
        let release = try JSONDecoder().decode(Release.self, from: data)
        guard !release.draft, !release.prerelease, release.tag_name.hasPrefix("v"), components(release.version) != nil else { throw Problem.invalidVersion }
        return release
    }
    public static func latest(session: URLSession = .shared) async throws -> Release {
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("AgentSwitch", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request)
        return try decode(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
