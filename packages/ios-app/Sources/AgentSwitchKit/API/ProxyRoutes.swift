import Foundation

/// Proxies from the phone (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6): Clash Integration,
/// a profile's own proxy, the shared browser's. A Mac from before these were a phone's answers 403 or 404: then there
/// is nothing to show, said as nil.
extension AgentSwitchAPI {
    // MARK: Clash

    public func clash() async throws -> ClashView? {
        do { return try await get(["clash"]) } catch APIError.http(let status, _) where status == 403 || status == 404 { return nil }
    }

    public func saveClash(_ settings: ClashSettings) async throws -> ClashView {
        try await send("PUT", ["clash", "settings"], body: settings, timeout: 20)
    }

    /// Work from this link from now on (fetched now).
    public func setClashSource(link: String) async throws -> ClashView {
        try await send("POST", ["clash", "source"], body: ["link": link], timeout: ClashText.fetchTimeout)
    }

    /// Work from this file's text.
    public func setClashSource(yaml: String, name: String) async throws -> ClashView {
        try await send("POST", ["clash", "source"], body: ["yaml": yaml, "name": name], timeout: ClashText.fetchTimeout)
    }

    /// Take one of Clash Verge's own subscriptions in.
    public func setClashSource(verge uid: String) async throws -> ClashView {
        try await send("POST", ["clash", "source"], body: ["verge": uid], timeout: ClashText.fetchTimeout)
    }

    public func removeClashSource() async throws -> ClashView { try await perform("DELETE", ["clash", "source"], query: [], body: nil) }

    /// The subscription fetched again now.
    public func updateClash() async throws -> ClashView {
        try await perform("POST", ["clash", "update"], query: [], body: nil, timeout: ClashText.fetchTimeout)
    }

    /// A service's group uses `node` from now on; nil: its automatic group.
    public func selectClash(_ service: ClashService, node: String?) async throws -> ClashView {
        try await send("POST", ["clash", "select"], body: ClashSelection(service: service.rawValue, node: node), timeout: 20)
    }

    /// How long each node takes to reach the service, in ms (nil: no answer): the chosen ones, or every node.
    public func clashDelays(_ service: ClashService, all: Bool) async throws -> [String: Int?] {
        struct Answer: Decodable { let delays: [String: Int?] }
        let answer: Answer = try await send("POST", ["clash", "delays"], body: ["service": service.rawValue, "scope": all ? "all" : "chosen"], timeout: 30)
        return answer.delays
    }

    /// The routing check: a connection of each kind through the running core, and what the core did with it.
    public func checkClash() async throws -> [ClashCheckRow] {
        struct Answer: Decodable { let rows: [ClashCheckRow] }
        let answer: Answer = try await perform("POST", ["clash", "check"], query: [], body: nil, timeout: 40)
        return answer.rows
    }

    /// A template's rules as they are in use.
    public func clashTemplate(_ template: ClashTemplate) async throws -> ClashTemplateRules { try await get(["clash", "templates", template.rawValue]) }

    /// The DNS template's text as it is in use.
    public func clashDNS() async throws -> ClashDNSText { try await get(["clash", "dns"]) }

    // MARK: a profile's own proxy

    /// `proxy` nil: none from now on. Returns every agent's profiles again, and what to say when the proxy was kept
    /// but where it lets traffic out is not known.
    public func setProfileProxy(agent: String, id: String, proxy: ProxyRequest?) async throws -> ProfileProxyReply {
        if let proxy { return try await send("PUT", ["profiles", agent, id, "proxy"], body: proxy, timeout: 40) }
        return try await send("PUT", ["profiles", agent, id, "proxy"], body: NoProxy(), timeout: 40)
    }

    /// Where a profile's proxy lets traffic out, asked now.
    public func checkProfileExit(agent: String, id: String) async throws -> ProfileProxyReply {
        try await perform("POST", ["profiles", agent, id, "check"], query: [], body: nil, timeout: 40)
    }

    // MARK: the shared browser's proxy

    public func browserProxy() async throws -> BrowserProxyState? {
        do { return try await get(["browser", "identity"]) } catch APIError.http(let status, _) where status == 403 || status == 404 { return nil }
    }

    /// `proxy` nil: direct from now on.
    public func setBrowserProxy(_ proxy: ProxyRequest?) async throws -> BrowserProxyState {
        try await send("PUT", ["browser", "identity"], body: BrowserProxyChange(proxy: proxy), timeout: 40)
    }

    /// The browser again, so a time zone that changed with the proxy is in force; its tabs come back.
    public func restartBrowser() async throws -> BrowserProxyState {
        try await perform("POST", ["browser", "identity", "restart"], query: [], body: nil, timeout: 60)
    }
}

/// Every agent's profiles after a proxy was set or asked, and what there is to say about its exit.
public struct ProfileProxyReply: Decodable, Sendable {
    public let agents: [String: ProfileChoices]
    public let problem: String?
}

struct ClashSelection: Encodable {
    let service: String
    let node: String?

    private enum CodingKeys: String, CodingKey { case service, node }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(service, forKey: .service)
        try c.encode(node, forKey: .node)   // null is said, not left out
    }
}

struct NoProxy: Encodable {
    private enum CodingKeys: String, CodingKey { case server }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeNil(forKey: .server)
    }
}

struct BrowserProxyChange: Encodable {
    let proxy: ProxyRequest?

    private enum CodingKeys: String, CodingKey { case proxy }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(proxy, forKey: .proxy)   // null is said: direct
    }
}
