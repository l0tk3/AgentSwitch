import CryptoKit
import Foundation

/// What a vendor publishes for a downloaded file to be checked against (docs/agents-v0.md §7).
public enum AgentDigest: Sendable, Equatable {
    /// 64 hex digits: Claude Code's manifest, Codex's release files.
    case sha256(String)
    /// npm's `integrity`, the part after `sha512-`: base64.
    case sha512(String)

    /// `sha256:<hex>` (GitHub, releases.openai.com) or a bare 64-digit hex.
    public static func sha256(parsing text: String) -> AgentDigest? {
        let hex = (text.hasPrefix("sha256:") ? String(text.dropFirst(7)) : text).lowercased()
        return hex.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil ? .sha256(hex) : nil
    }

    /// `sha512-<base64>`.
    public static func sha512(parsing text: String) -> AgentDigest? {
        guard text.hasPrefix("sha512-") else { return nil }
        let encoded = String(text.dropFirst(7))
        guard let raw = Data(base64Encoded: encoded), raw.count == 64 else { return nil }
        return .sha512(encoded)
    }

    /// Whether the file is the one the vendor published. Read in pieces: these files run to hundreds of megabytes.
    public func matches(file: URL) throws -> Bool {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        func pieces(_ update: (Data) -> Void) throws {
            while let piece = try handle.read(upToCount: 4 << 20), !piece.isEmpty { update(piece) }
        }
        switch self {
        case .sha256(let hex):
            var hash = SHA256()
            try pieces { hash.update(data: $0) }
            return hash.finalize().map { String(format: "%02x", $0) }.joined() == hex
        case .sha512(let encoded):
            var hash = SHA512()
            try pieces { hash.update(data: $0) }
            return Data(hash.finalize()).base64EncodedString() == encoded
        }
    }
}

/// One version of one agent as a file to download: where it is, what it must hash to, and what is in it.
public struct AgentArtifact: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        /// The program itself, one file (Claude Code).
        case program(name: String)
        /// A `tar.gz` kept whole, its program at `program` (Codex's package: the program and what it needs beside it).
        case tree(program: String)
        /// A `tar.gz` of which only the program at `path` is kept, as `name` (OpenCode's npm package).
        case packed(path: String, name: String)
    }

    public let url: URL
    public let digest: AgentDigest
    public let size: Int64?
    public let kind: Kind

    public init(url: URL, digest: AgentDigest, size: Int64? = nil, kind: Kind) {
        self.url = url
        self.digest = digest
        self.size = size
        self.kind = kind
    }

    /// The program's place in the version's folder once it is there.
    public var program: String {
        switch kind {
        case .program(let name), .packed(_, let name): return name
        case .tree(let program): return program
        }
    }
}

/// Where the facts about one version are and how they become a file to download (agents-v0 §1, §5). pi is not here:
/// it is a set of npm packages, installed only where its own installer puts them.
public enum AgentArtifacts {
    /// The address that describes `version`, and how its answer is read.
    public static func lookup(_ agent: AgentCLI, version: String, platform: AgentPlatform) -> (url: URL, read: @Sendable (Data) -> AgentArtifact?)? {
        guard AgentVersion.isWellFormed(version) else { return nil }
        switch agent {
        case .claude:
            return (URL(string: "\(AgentReleases.claudeBase)/\(version)/manifest.json")!, { claude(manifest: $0, version: version, platform: platform) })
        case .codex:
            return (URL(string: "\(AgentReleases.codexGitHub)/tags/rust-v\(version)")!, { codex(release: $0, platform: platform) })
        case .opencode:
            return (URL(string: "https://registry.npmjs.org/@opencode%2fcli-\(platform.node)/\(version)")!, { opencode(package: $0, platform: platform) })
        case .pi:
            return nil
        }
    }

    /// `{"platforms": {"darwin-arm64": {"binary": "claude", "checksum": "<sha256>", "size": 233211568}}}`.
    static func claude(manifest: Data, version: String, platform: AgentPlatform) -> AgentArtifact? {
        guard let object = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any],
              let platforms = object["platforms"] as? [String: Any], let entry = platforms[platform.node] as? [String: Any],
              let digest = (entry["checksum"] as? String).flatMap(AgentDigest.sha256(parsing:)) else { return nil }
        let name = entry["binary"] as? String ?? "claude"
        guard name == "claude" else { return nil }
        return AgentArtifact(url: URL(string: "\(AgentReleases.claudeBase)/\(version)/\(platform.node)/claude")!, digest: digest,
                             size: (entry["size"] as? NSNumber)?.int64Value, kind: .program(name: "claude"))
    }

    /// A GitHub release: the asset `codex-package-<platform>.tar.gz` with its `digest` and where to get it.
    static func codex(release: Data, platform: AgentPlatform) -> AgentArtifact? {
        let wanted = "codex-package-\(platform.rust).tar.gz"
        guard let object = try? JSONSerialization.jsonObject(with: release) as? [String: Any], let assets = object["assets"] as? [[String: Any]],
              let asset = assets.first(where: { $0["name"] as? String == wanted }),
              let digest = (asset["digest"] as? String).flatMap(AgentDigest.sha256(parsing:)),
              let url = (asset["browser_download_url"] as? String).flatMap(URL.init(string:)), AgentReleases.allowed(url) else { return nil }
        return AgentArtifact(url: url, digest: digest, size: (asset["size"] as? NSNumber)?.int64Value, kind: .tree(program: "bin/codex"))
    }

    /// One version of the npm package: `dist.tarball` and `dist.integrity`; the program is `package/bin/opencode`.
    static func opencode(package: Data, platform: AgentPlatform) -> AgentArtifact? {
        guard let object = try? JSONSerialization.jsonObject(with: package) as? [String: Any], let dist = object["dist"] as? [String: Any],
              let digest = (dist["integrity"] as? String).flatMap(AgentDigest.sha512(parsing:)),
              let url = (dist["tarball"] as? String).flatMap(URL.init(string:)), url.host == "registry.npmjs.org", AgentReleases.allowed(url),
              url.path.hasPrefix("/@opencode/cli-\(platform.node)/") else { return nil }
        // npm says how large the package unpacks, not how large the download is: the size comes with the download.
        return AgentArtifact(url: url, digest: digest, kind: .packed(path: "package/bin/opencode", name: "opencode"))
    }

    /// The file for `version`, asked of the vendor. A version the vendor does not have, or facts that do not read, is
    /// an error said in words.
    public static func resolve(_ agent: AgentCLI, version: String, platform: AgentPlatform = .current,
                               fetch: AgentReleases.Fetch = AgentReleases.fetch) async throws -> AgentArtifact {
        guard let lookup = lookup(agent, version: version, platform: platform) else {
            throw AgentError(agent == .pi ? "pi 只能安装在它自己的位置。" : "“\(version)”不是一个版本号。")
        }
        let data: Data
        do { data = try await fetch(lookup.url) } catch { throw AgentError("未找到 \(agent.title) \(version)：\(error.localizedDescription)") }
        guard let artifact = lookup.read(data) else { throw AgentError("\(agent.title) \(version) 没有适用于这台 Mac 的发布文件。") }
        return artifact
    }
}

/// Something that went wrong with an install, said to the user (formal Chinese, docs/ui-v0.md §4.1).
public struct AgentError: LocalizedError, Sendable, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
