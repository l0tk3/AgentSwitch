import Foundation

public struct ProfileHealth: Decodable, Sendable {
    public struct Window: Decodable, Sendable {
        public let label: String
        public let usedPercent: Double
        public let resetsAt: Double?
        public var summary: String {
            let used = String(format: "%.0f", usedPercent)
            let reset = resetsAt.map { " · 重置 " + Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .shortened) } ?? ""
            return "\(label) · 已用 \(used)%\(reset)"
        }
    }
    public let status: String
    public let checkedAt: Double
    public let message: String
    public let windows: [Window]
    public var title: String {
        switch status {
        case "healthy": "Healthy"
        case "warning": "Limited"
        case "unhealthy": "Unhealthy"
        default: "Unknown"
        }
    }
}

extension DaemonClient {
    public func profileGateKey() async throws -> PairingPayload.Gate {
        try decode(PairingPayload.Gate.self, try await call("GET", "/gate/pubkey"))
    }
    public func setCodexAuth(id: String, content: String) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("PUT", "/profiles/codex/\(Self.segment(id))/auth", body: try JSONEncoder().encode(["content": content]))).agents
    }
    public func profileHealthStates() async throws -> [String: ProfileHealth] {
        struct Reply: Decodable { let health: [String: ProfileHealth] }
        return try decode(Reply.self, try await call("GET", "/profiles/health")).health
    }
    public func checkProfileHealth(agent: String, id: String) async throws -> ProfileHealth {
        try decode(ProfileHealth.self, try await call("POST", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/health", timeout: 45))
    }
}

/// Profiles (docs/profiles-v0.md §3): several sign-ins per agent, each started with a folder of its own; `Default` is
/// the Mac's own. The service keeps them (`GET /profiles`).
/// Where a profile's own proxy let traffic out when it was last checked (docs/profiles-v0.md §4).
public struct ProfileExit: Decodable, Equatable, Sendable {
    public let ip: String
    public let place: String?

    public init(ip: String, place: String? = nil) {
        self.ip = ip
        self.place = place
    }

    /// `Tokyo 203.0.113.9`.
    public var text: String { [place, ip].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ") }
}

/// A profile's colour (docs/profiles-v0.md §3.2): the lit dot its terminals are marked with. The service keeps it by
/// name; what each looks like is here. None is a colour a state is said in (busy, waiting, done, failed), the signal
/// or the accent.
public enum ProfileColor: String, CaseIterable, Sendable, Identifiable {
    case violet, sand, mint, orchid, olive, slate

    public var id: String { rawValue }
    /// `Violet`, in a menu.
    public var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }

    /// On a dark ground (the terminals' list and bars are dark in both looks).
    public var dark: UInt32 {
        switch self {
        case .violet: 0xB18CFF
        case .sand: 0xE2C48D
        case .mint: 0x7FE3C0
        case .orchid: 0xE08CE8
        case .olive: 0xC3C95A
        case .slate: 0x9DB2D9
        }
    }

    /// On a light ground (the settings' rows by day).
    public var light: UInt32 {
        switch self {
        case .violet: 0x7A4FE0
        case .sand: 0x9A7B3F
        case .mint: 0x1F9A75
        case .orchid: 0xB043BC
        case .olive: 0x7C8220
        case .slate: 0x5A719F
        }
    }
}

/// How a profile that pays by a key reaches its model (docs/profiles-v0.md §3.6), as the screens are told: where the
/// key is sent when that is not the vendor's own address, the model it starts on. Never the key.
public struct ProfileApiInfo: Decodable, Equatable, Sendable {
    public let baseUrl: String?
    public let model: String?

    public init(baseUrl: String? = nil, model: String? = nil) {
        self.baseUrl = baseUrl
        self.model = model
    }
}

/// A profile that pays by a key, as it is typed (docs/profiles-v0.md §3.6): its name when it is a new one, the key,
/// another address than the vendor's own, a model. The key is sealed by this Mac's gate for the address's site before
/// anything is sent.
public struct ApiKeyDraft: Equatable, Sendable {
    public var name = ""
    public var key = ""
    public var baseUrl = ""
    public var model = ""

    public init(_ info: ProfileApiInfo? = nil) {
        baseUrl = info?.baseUrl ?? ""
        model = info?.model ?? ""
    }

    /// The vendor's own address for each agent that can pay by a key.
    public static func home(_ agent: String) -> String? {
        switch agent {
        case "claude-code": "https://api.anthropic.com"
        case "codex": "https://api.openai.com/v1"
        default: nil
        }
    }

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var cleanKey: String { Self.trimmed(key) }
    public var cleanBaseUrl: String? { Self.trimmed(baseUrl).isEmpty ? nil : Self.trimmed(baseUrl) }
    public var cleanModel: String? { Self.trimmed(model).isEmpty ? nil : Self.trimmed(model) }

    /// The site the key is sealed for: the address it is sent to (`https://relay.example/api` → `https://relay.example/`).
    public func site(agent: String) -> String? {
        guard let said = cleanBaseUrl ?? Self.home(agent), let url = URLComponents(string: said), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", let host = url.host, !host.isEmpty, url.user == nil, url.query == nil else { return nil }
        return "\(scheme)://\(host.lowercased())\(url.port.map { ":\($0)" } ?? "")/"
    }

    /// Why it cannot be saved yet, in the sheet's words; nil when it can, or nothing has been typed that is wrong.
    /// `kept`: the profile has a key already, on `keptSite` — none need be typed while the address stays there.
    public func problem(agent: String, keptSite: String? = nil) -> String? {
        if cleanBaseUrl != nil, site(agent: agent) == nil { return "地址须是 http(s) 地址，不带用户名和参数。" }
        if !cleanKey.isEmpty, cleanKey.count < 8 || cleanKey.contains(where: \.isWhitespace) { return "这不像一个 API key。" }
        if cleanKey.isEmpty, let keptSite, site(agent: agent) != keptSite { return "地址换到了另一个站点：原来的 API key 是为原站点加密的，请一并填入新的。" }
        return nil
    }

    public func canSave(agent: String, new: Bool, keptSite: String? = nil) -> Bool {
        guard problem(agent: agent, keptSite: keptSite) == nil, site(agent: agent) != nil else { return false }
        if new { return !Self.trimmed(name).isEmpty && !cleanKey.isEmpty }
        return !cleanKey.isEmpty || keptSite != nil
    }
}

public struct AgentProfile: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// `subscription` or `api`.
    public let kind: String
    /// Who is signed in, as the agent's own files say; nil: nobody yet.
    public let account: String?
    /// Its own proxy (the password is never told, only that it has one); nil: this Mac's own way out.
    public let proxy: BrowserProxy?
    public let exit: ProfileExit?
    /// Its colour, by name (`ProfileColor`); nil for `Default`, which has none.
    public let color: String?
    /// A claude.ai session key is kept for its own browser (docs/profiles-v0.md §3.4); the key itself is never told.
    public let sessionKey: Bool?
    /// The device Claude Code says it is under this profile (§3.5); nil till it has run there.
    public let device: String?
    /// One that pays by a key (§3.6): where the key is sent, the model it starts on; nil: it signs in with an account.
    public let api: ProfileApiInfo?
    /// `false`: Claude Code's telemetry is off under it (docs/profiles-v0.md §3.7); nil: on.
    public let telemetry: Bool?
    public let isolated: Bool?
    public let workspace: String?
    public var hasSessionKey: Bool { sessionKey == true }
    public var telemetryOff: Bool { telemetry == false }
    public var paysByKey: Bool { kind == "api" }

    public var isDefault: Bool { id == "default" }
    /// Its colour as the screens draw it; nil for none, or one this app does not know yet.
    public var tint: ProfileColor? { color.flatMap(ProfileColor.init(rawValue:)) }

    public init(id: String, name: String, kind: String = "subscription", account: String? = nil, proxy: BrowserProxy? = nil, exit: ProfileExit? = nil, color: String? = nil, sessionKey: Bool? = nil, device: String? = nil, api: ProfileApiInfo? = nil, telemetry: Bool? = nil, isolated: Bool? = nil, workspace: String? = nil) {
        self.isolated = isolated
        self.workspace = workspace
        self.api = api
        self.telemetry = telemetry
        self.sessionKey = sessionKey
        self.device = device
        self.id = id
        self.name = name
        self.kind = kind
        self.account = account
        self.proxy = proxy
        self.exit = exit
        self.color = color
    }

    /// Where what runs under it leaves from, in a few words: `This Mac`; with a proxy of its own, where that proxy
    /// lets traffic out (`Tokyo 203.0.113.9`), or the proxy itself while that is not known (`proxy.example:8080`).
    public var way: String {
        guard let proxy else { return "This Mac" }
        return exit?.text ?? BrowserIdentityText.proxySite(proxy.server) ?? proxy.server
    }
}

/// A profile in a line of a menu, and who is signed in to it.
public enum ProfileWords {
    /// `This Mac’s own` for `Default`, the account once somebody is signed in, `Not Signed In` till then; one that
    /// pays by a key: `API Key`, with where the key is sent when that is not the vendor's own (`API Key · relay.example`).
    public static func who(_ profile: AgentProfile) -> String {
        if profile.paysByKey {
            let host = profile.api?.baseUrl.flatMap { URLComponents(string: $0)?.host }
            return host.map { "API Key · \($0)" } ?? "API Key"
        }
        return profile.account ?? (profile.isDefault ? "This Mac’s own" : "Not Signed In")
    }

    /// `cwork1 — work@example.com`.
    public static func line(_ profile: AgentProfile) -> String { "\(profile.name) — \(who(profile))" }
}

/// A claude.ai session key as it is typed (docs/profiles-v0.md §3.4): `sk-ant-sid01-…`. Pasted as a cookie
/// (`sessionKey=sk-ant-sid01-…`) it is taken down to the key.
public enum SessionKeyText {
    /// The site it is sealed for.
    public static let site = "claude.ai"

    public static func cleaned(_ typed: String) -> String {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("sessionKey=") { text.removeFirst("sessionKey=".count) }
        if let end = text.firstIndex(of: ";") { text = String(text[..<end]) }
        return text.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
    }

    public static func valid(_ typed: String) -> Bool {
        cleaned(typed).range(of: #"^sk-ant-sid\d{2}-[A-Za-z0-9_-]{20,400}$"#, options: .regularExpression) != nil
    }

    /// What is wrong with what is typed so far; nil: nothing yet, or nothing.
    public static func problem(_ typed: String) -> String? {
        let text = cleaned(typed)
        if text.isEmpty || valid(typed) { return nil }
        if text.hasPrefix("sk-ant-api") { return "这是 API key，不是 claude.ai 的 session key。" }
        if text.hasPrefix("sk-ant-oat") { return "这是 claude setup-token 的令牌，不是 claude.ai 的 session key。" }
        // Still being typed: nothing is said until it could not become one.
        if "sk-ant-sid".hasPrefix(text) || (text.hasPrefix("sk-ant-sid") && text.count < 40) { return nil }
        return "Session key 应以 sk-ant-sid 开头。"
    }
}

public struct AgentProfiles: Decodable, Equatable, Sendable {
    /// The one last chosen for a new terminal: what the next new terminal is offered first (docs/profiles-v0.md §3.3).
    public let current: String
    public let profiles: [AgentProfile]
    /// There is something to choose between: more than the Mac's own.
    public var several: Bool { profiles.count > 1 }
    /// What a new terminal is offered first: the one last chosen, while it is still there.
    public var offered: AgentProfile? { profiles.first { $0.id == current } ?? profiles.first }
    /// More than `Default` can be made for this agent.
    public let creatable: Bool
    /// The ways a new profile of this agent can sign in (`subscription`, `api`); nil from a service that does not say
    /// (an older one: an account only).
    public let kinds: [String]?
    public var newKinds: [String] { kinds ?? (creatable ? ["subscription"] : []) }

    public init(current: String, profiles: [AgentProfile], creatable: Bool, kinds: [String]? = nil) {
        self.current = current
        self.profiles = profiles
        self.creatable = creatable
        self.kinds = kinds
    }
}

extension DaemonClient {
    private struct ProfilesReply: Decodable { let agents: [String: AgentProfiles] }

    /// Every agent's profiles, by the agent's id (`claude-code`, `codex`…).
    public func profiles() async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("GET", "/profiles")).agents
    }

    public func setCurrentProfile(agent: String, id: String) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("POST", "/profiles/current", body: try JSONEncoder().encode(["agent": agent, "id": id]))).agents
    }

    /// `telemetry`: false to have Claude Code's telemetry off under it from the start (docs/profiles-v0.md §3.7).
    public func createProfile(agent: String, name: String, kind: String = "subscription", telemetry: Bool = true, sharedSkills: [String] = []) async throws -> [String: AgentProfiles] {
        struct Body: Encodable { let agent: String; let name: String; let kind: String; let telemetry: Bool?; let sharedSkills: [String] }
        return try decode(ProfilesReply.self, try await call("POST", "/profiles", body: try JSONEncoder().encode(Body(agent: agent, name: name, kind: kind, telemetry: telemetry ? nil : false, sharedSkills: sharedSkills)))).agents
    }

    private struct ApiBody: Encodable { let key: String?; let baseUrl: String?; let model: String? }

    /// A new profile that pays by a key (§3.6): `ciphertext` is the key sealed for the site it is sent to.
    public func createKeyProfile(agent: String, name: String, ciphertext: String, baseUrl: String?, model: String?, telemetry: Bool = true, sharedSkills: [String] = []) async throws -> [String: AgentProfiles] {
        struct Body: Encodable { let agent: String; let name: String; let kind = "api"; let api: ApiBody; let telemetry: Bool?; let sharedSkills: [String] }
        return try decode(ProfilesReply.self, try await call("POST", "/profiles", body: try JSONEncoder().encode(Body(agent: agent, name: name, api: ApiBody(key: ciphertext, baseUrl: baseUrl, model: model), telemetry: telemetry ? nil : false, sharedSkills: sharedSkills)))).agents
    }

    /// Claude Code's telemetry under a profile, for the terminals started under it from now on (§3.7).
    public func setProfileTelemetry(agent: String, id: String, on: Bool) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("PUT", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/telemetry", body: try JSONEncoder().encode(["on": on]))).agents
    }

    /// A profile's address and model from now on, and its key when one is given (nil: the one it has).
    public func setProfileApi(agent: String, id: String, ciphertext: String?, baseUrl: String?, model: String?) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("PUT", "/profiles/\(agent)/\(id)/api", body: try JSONEncoder().encode(ApiBody(key: ciphertext, baseUrl: baseUrl, model: model)))).agents
    }

    /// A profile's colour from now on; the terminals open under it change their dot with it.
    public func setProfileColor(agent: String, id: String, color: ProfileColor) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("PUT", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/color", body: try JSONEncoder().encode(["color": color.rawValue]))).agents
    }

    /// A profile's own proxy from now on (nil: none, this Mac's own way out). It is checked at once: `problem` is why it
    /// let nothing out, when it did not — it is kept all the same.
    public func setProfileProxy(agent: String, id: String, proxy: BrowserProxyRequest?) async throws -> (agents: [String: AgentProfiles], problem: String?) {
        struct None: Encodable { let server: String? = nil
            func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Key.self); try c.encodeNil(forKey: .server) }
            enum Key: String, CodingKey { case server } }
        let body = try proxy.map { try JSONEncoder().encode($0) } ?? JSONEncoder().encode(None())
        return try profileExitReply(try await call("PUT", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/proxy", body: body, timeout: 30))
    }

    /// A profile's claude.ai session key from now on, a ciphertext sealed for claude.ai (nil: forgotten). Its own
    /// browser is signed in to claude.ai with it (docs/profiles-v0.md §3.4).
    public func setProfileSessionKey(agent: String, id: String, ciphertext: String?) async throws -> [String: AgentProfiles] {
        struct Body: Encodable { let key: String?
            func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Key.self); try c.encode(key, forKey: .key) }
            enum Key: String, CodingKey { case key } }
        return try decode(ProfilesReply.self, try await call("PUT", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/session-key", body: try JSONEncoder().encode(Body(key: ciphertext)), timeout: 30)).agents
    }

    /// Where a profile's proxy lets traffic out, asked now.
    public func checkProfileExit(agent: String, id: String) async throws -> (agents: [String: AgentProfiles], problem: String?) {
        try profileExitReply(try await call("POST", "/profiles/\(Self.segment(agent))/\(Self.segment(id))/check", timeout: 30))
    }

    private func profileExitReply(_ data: Data) throws -> (agents: [String: AgentProfiles], problem: String?) {
        struct Reply: Decodable { let agents: [String: AgentProfiles]; let problem: String? }
        let reply = try decode(Reply.self, data)
        return (reply.agents, reply.problem)
    }

    public func deleteProfile(agent: String, id: String) async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("DELETE", "/profiles/\(Self.segment(agent))/\(Self.segment(id))")).agents
    }

    public func resetDefaultClaudeIdentity() async throws -> [String: AgentProfiles] {
        try decode(ProfilesReply.self, try await call("POST", "/profiles/claude-code/default/reset-identity")).agents
    }
}
