import Foundation

/// The newest version on each of an agent's channels.
public struct AgentChannels: Sendable, Equatable, Codable {
    public var stable: String?
    public var beta: String?

    public init(stable: String? = nil, beta: String? = nil) {
        self.stable = stable
        self.beta = beta
    }
}

/// What the vendors published when last asked (docs/agents-v0.md §4), kept between launches.
public struct AgentReleaseInfo: Sendable, Equatable, Codable {
    /// By the agent's raw value.
    public var channels: [String: AgentChannels]
    public var checkedAt: Date?
    /// Agents whose lookup failed the last time: their numbers are the ones from before.
    public var failed: [String]

    public init(channels: [String: AgentChannels] = [:], checkedAt: Date? = nil, failed: [String] = []) {
        self.channels = channels
        self.checkedAt = checkedAt
        self.failed = failed
    }

    public static let freshFor: TimeInterval = 12 * 3600

    public func channels(_ agent: AgentCLI) -> AgentChannels? { channels[agent.rawValue] }
    public func isFresh(at now: Date) -> Bool { checkedAt.map { now.timeIntervalSince($0) < AgentReleaseInfo.freshFor && now >= $0 } ?? false }

    public static func load(from url: URL) -> AgentReleaseInfo? {
        guard let data = try? Data(contentsOf: url), data.count < 200_000 else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(AgentReleaseInfo.self, from: data)
    }

    public func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
    }
}

/// The Mac this runs on, as each vendor names it in its file names.
public enum AgentPlatform: Sendable, Equatable {
    case arm64, x64

    public static var current: AgentPlatform {
        #if arch(arm64)
        return .arm64
        #else
        return .x64
        #endif
    }

    /// Claude Code's manifest and OpenCode's npm package: `darwin-arm64`.
    public var node: String { self == .arm64 ? "darwin-arm64" : "darwin-x64" }
    /// Codex's release files: `aarch64-apple-darwin`.
    public var rust: String { self == .arm64 ? "aarch64-apple-darwin" : "x86_64-apple-darwin" }
}

/// Where each vendor says what its newest versions are, and how to read the answer (agents-v0 §1). Only these hosts
/// are ever asked, over HTTPS, and only for this: nothing about this Mac goes with the request.
public enum AgentReleases {
    public static let claudeBase = "https://downloads.claude.ai/claude-code-releases"
    public static let codexChannel = "https://releases.openai.com/codex/channels/latest"
    public static let codexGitHub = "https://api.github.com/repos/openai/codex/releases"
    public static let opencodeLatest = "https://opencode.ai/update/api/latest/cli/npm"
    public static let piLatest = "https://pi.dev/api/latest-version"
    public static func opencodeTags(_ platform: AgentPlatform) -> String { "https://registry.npmjs.org/-/package/@opencode%2fcli-\(platform.node)/dist-tags" }

    /// Hosts a lookup or a download may end on (a redirect elsewhere is refused).
    public static let allowedHosts: Set<String> = [
        "downloads.claude.ai", "releases.openai.com", "api.github.com", "github.com", "objects.githubusercontent.com",
        "release-assets.githubusercontent.com", "registry.npmjs.org", "opencode.ai", "pi.dev", "chatgpt.com",
    ]

    public static func allowed(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return allowedHosts.contains(host)
    }

    /// One address and how its answer becomes a version.
    public struct Lookup: Sendable {
        public let url: URL
        public let read: @Sendable (Data) -> String?
    }

    /// For each channel the places to ask, in order: the first that answers with a version wins.
    public static func lookups(_ agent: AgentCLI, platform: AgentPlatform) -> (stable: [Lookup], beta: [Lookup]) {
        func at(_ address: String, _ read: @escaping @Sendable (Data) -> String?) -> Lookup { Lookup(url: URL(string: address)!, read: read) }
        switch agent {
        case .claude:
            // Its two channels: `stable` runs about a week behind `latest` (taken here as the test channel).
            return ([at("\(claudeBase)/stable", plainVersion)], [at("\(claudeBase)/latest", plainVersion)])
        case .codex:
            return ([at(codexChannel, codexTag), at("\(codexGitHub)/latest", codexTag)], [at("\(codexGitHub)?per_page=10", codexPrerelease)])
        case .opencode:
            return ([at(opencodeLatest, jsonVersion)], [at(opencodeTags(platform), npmTag("beta"))])
        case .pi:
            return ([at(piLatest, jsonVersion)], [])
        }
    }

    // MARK: reading the answers

    /// A version and nothing else (`2.1.291\n`); an error page is not one.
    static func plainVersion(_ data: Data) -> String? {
        guard data.count < 100, let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return checked(text)
    }

    /// `{"tag_name": "rust-v0.160.1", …}`: Codex's channel file and GitHub's `releases/latest`.
    static func codexTag(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let tag = object["tag_name"] as? String else { return nil }
        return checked(stripped(tag))
    }

    /// GitHub's list of releases: the highest version among the pre-releases (they are not published in order).
    static func codexPrerelease(_ data: Data) -> String? {
        guard let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        return list.filter { $0["prerelease"] as? Bool == true && $0["draft"] as? Bool != true }
            .compactMap { ($0["tag_name"] as? String).flatMap { checked(stripped($0)) } }
            .max { AgentVersion($0) < AgentVersion($1) }
    }

    /// `{"version": "2.0.24", …}`: OpenCode's and pi's.
    static func jsonVersion(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let version = object["version"] as? String else { return nil }
        return checked(version)
    }

    /// npm's dist-tags: `{"beta": "0.0.0-beta-19507", "latest": "2.0.24", …}`.
    static func npmTag(_ tag: String) -> @Sendable (Data) -> String? {
        { data in
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let version = object[tag] as? String else { return nil }
            return checked(version)
        }
    }

    static func stripped(_ tag: String) -> String { tag.hasPrefix("rust-v") ? String(tag.dropFirst(6)) : tag.hasPrefix("v") ? String(tag.dropFirst()) : tag }
    static func checked(_ version: String) -> String? { AgentVersion.isWellFormed(version) ? version : nil }

    // MARK: asking

    public typealias Fetch = @Sendable (URL) async throws -> Data

    /// Every agent's channels, asked together. A channel that cannot be read keeps its number from `previous`, and its
    /// agent is listed in `failed`.
    public static func check(agents: [AgentCLI] = AgentCLI.allCases, platform: AgentPlatform = .current, previous: AgentReleaseInfo? = nil,
                             now: Date = Date(), fetch: @escaping Fetch = AgentReleases.fetch) async -> AgentReleaseInfo {
        let results = await withTaskGroup(of: (AgentCLI, AgentChannels, Bool).self) { group -> [(AgentCLI, AgentChannels, Bool)] in
            for agent in agents {
                group.addTask {
                    let places = lookups(agent, platform: platform)
                    let before = previous?.channels(agent)
                    async let stable = first(places.stable, fetch: fetch)
                    async let beta = first(places.beta, fetch: fetch)
                    let (s, b) = await (stable, beta)
                    let missed = (s == nil && !places.stable.isEmpty) || (b == nil && !places.beta.isEmpty)
                    return (agent, AgentChannels(stable: s ?? before?.stable, beta: b ?? before?.beta), missed)
                }
            }
            var out: [(AgentCLI, AgentChannels, Bool)] = []
            for await result in group { out.append(result) }
            return out
        }
        var info = AgentReleaseInfo(channels: previous?.channels ?? [:], checkedAt: now, failed: [])
        for (agent, channels, missed) in results {
            info.channels[agent.rawValue] = channels
            if missed { info.failed.append(agent.rawValue) }
        }
        info.failed.sort()
        return info
    }

    static func first(_ lookups: [Lookup], fetch: Fetch) async -> String? {
        for lookup in lookups {
            if let data = try? await fetch(lookup.url), let version = lookup.read(data) { return version }
        }
        return nil
    }

    /// A GET to one of the vendors' hosts: HTTPS, the answer from an allowed host (redirects included), at most a few
    /// megabytes (GitHub's list of releases is the largest).
    public static let fetch: Fetch = { url in
        guard allowed(url) else { throw CommandError("不在允许的发布地址之内：\(url.host ?? url.absoluteString)") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("AgentSwitch", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json, text/plain, */*", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, allowed(http.url) else {
            throw CommandError("\(url.host ?? "") 未给出发布信息")
        }
        guard data.count <= 8_000_000 else { throw CommandError("\(url.host ?? "") 的答复过大") }
        return data
    }

    /// No cookies, no cache, no credentials: these requests carry nothing of the user's.
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForResource = 40
        return URLSession(configuration: config)
    }()
}

/// Whether an install has something newer to move to (agents-v0 §4).
public enum AgentUpdates {
    /// The version its channel now has, when that is newer than what is installed. The vendor's own install follows
    /// the stable channel — Claude Code's follows whichever its own setting says; the beta follows the test channel;
    /// a pinned version, the app's copy and what was found elsewhere follow nothing.
    public static func newer(for install: AgentInstall, channels: AgentChannels?) -> String? {
        guard let channels, let installed = install.version else { return nil }
        let target: String?
        switch install.source {
        case .stable: target = install.agent == .claude && install.channel == "latest" ? channels.beta : channels.stable
        case .beta: target = channels.beta
        case .pinned, .app, .other: target = nil
        }
        guard let target, AgentVersion(target) > AgentVersion(installed) else { return nil }
        return target
    }

    /// How many installs have an update: the number beside `Agents` in the sidebar.
    public static func count(_ reports: [AgentReport], info: AgentReleaseInfo?) -> Int {
        guard let info else { return 0 }
        return reports.reduce(0) { n, report in n + report.installs.filter { newer(for: $0, channels: info.channels(report.agent)) != nil }.count }
    }
}

/// Which install AgentSwitch runs for each agent (agents-v0 §3).
public enum AgentSelection {
    /// UserDefaults: the agent's raw value → the install's key.
    public static let defaultsKey = "agents.use"

    /// With nothing chosen: the vendor's own install; else, for Codex, the app's copy; else what there is.
    public static func fallback(_ report: AgentReport) -> AgentInstall? {
        let usable = report.installs.filter(\.selectable)
        for source in [AgentSource.stable, .app, .beta, .pinned, .other] {
            if let install = usable.first(where: { $0.source == source }) { return install }
        }
        return nil
    }

    /// The saved choice while it is still there and usable, else the fallback.
    public static func chosen(_ report: AgentReport, saved: String?) -> AgentInstall? {
        if let saved, let install = report.install(saved), install.selectable { return install }
        return fallback(report)
    }

    /// The saved choice no longer exists (deleted, moved): said on the page, and the fallback is used.
    public static func lost(_ report: AgentReport, saved: String?) -> Bool {
        guard let saved else { return false }
        return report.install(saved)?.selectable != true
    }

    /// The program for each agent that has one.
    public static func binaries(_ reports: [AgentReport], saved: [String: String]) -> [AgentCLI: String] {
        var out: [AgentCLI: String] = [:]
        for report in reports {
            if let install = chosen(report, saved: saved[report.agent.rawValue]) { out[report.agent] = install.binary }
        }
        return out
    }
}
