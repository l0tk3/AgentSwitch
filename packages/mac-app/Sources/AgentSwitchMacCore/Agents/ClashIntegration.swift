import Foundation

/// Clash Integration (docs/clash-v0.md §7): the subscription AgentSwitch works from, the nodes chosen for Claude and
/// for OpenAI in their order, the addresses that go direct — and what the service found of Clash Verge and of the
/// core it runs: whether it is on AgentSwitch's subscription, and what each service's group uses now.
public enum ClashService: String, CaseIterable, Sendable {
    case claude, openai

    public var title: String { self == .claude ? "Claude" : "OpenAI" }
}

public struct ClashServiceNodes: Codable, Equatable, Sendable {
    /// Nodes by name, the first preferred.
    public var nodes: [String]

    public init(nodes: [String] = []) { self.nodes = nodes }
}

/// A rule template (docs/clash-v0.md §7.7): a set of rules that go one way, put on with a switch.
public enum ClashTemplate: String, CaseIterable, Sendable {
    /// Domestic and local traffic goes direct.
    case domestic
    /// Ads and trackers are rejected.
    case block

    public var title: String { self == .domestic ? "Domestic & Local Direct" : "Block Ads & Trackers" }
}

public struct ClashTemplateSetting: Codable, Equatable, Sendable {
    public var on: Bool
    /// The user's own rules, a line each; nil: the template as it is built in.
    public var rules: [String]?

    public init(on: Bool = false, rules: [String]? = nil) {
        self.on = on
        self.rules = rules
    }

    private enum CodingKeys: String, CodingKey { case on, rules }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(on, forKey: .on)
        try c.encode(rules, forKey: .rules)   // null is said, not left out
    }
}

public struct ClashTemplates: Codable, Equatable, Sendable {
    public var domestic: ClashTemplateSetting
    public var block: ClashTemplateSetting

    public init(domestic: ClashTemplateSetting = .init(), block: ClashTemplateSetting = .init()) {
        self.domestic = domestic
        self.block = block
    }

    public subscript(template: ClashTemplate) -> ClashTemplateSetting {
        get { template == .domestic ? domestic : block }
        set { if template == .domestic { domestic = newValue } else { block = newValue } }
    }
}

/// The DNS template (docs/clash-v0.md §7.8): on, the subscription handed over has it under `dns:` in place of its own.
public struct ClashDNSSetting: Codable, Equatable, Sendable {
    public var on: Bool
    /// The user's own text (YAML, what goes under `dns:`); nil: the built-in one.
    public var text: String?

    public init(on: Bool = false, text: String? = nil) {
        self.on = on
        self.text = text
    }

    private enum CodingKeys: String, CodingKey { case on, text }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(on, forKey: .on)
        try c.encode(text, forKey: .text)   // null is said, not left out
    }
}

/// The DNS template as it stands: on or off, whether its text is the user's own, and whether Clash Verge has its own
/// DNS settings on — the core then takes those, and this changes nothing.
public struct ClashDNSState: Decodable, Equatable, Sendable {
    public let on: Bool
    public let custom: Bool
    public let overridden: Bool
}

/// The DNS template's text as it is in use, to edit it.
public struct ClashDNSText: Decodable, Equatable, Sendable {
    public let text: String
    public let custom: Bool

    public init(text: String, custom: Bool) {
        self.text = text
        self.custom = custom
    }
}

public struct ClashSettings: Codable, Equatable, Sendable {
    public var claude: ClashServiceNodes
    public var openai: ClashServiceNodes
    public var direct: [String]
    /// The subscription is fetched again after this many hours; 0: only when asked.
    public var autoUpdateHours: Int
    public var templates: ClashTemplates
    /// The subscription's default group is called `Manual` in what Clash Verge is handed.
    public var renameDefault: Bool
    public var dns: ClashDNSSetting
    /// What Clash Verge is handed keeps the subscription's nodes alone: AgentSwitch's groups and rules are all there is,
    /// and the domestic template is on while this is (docs/clash-v0.md §7.11).
    public var ownRules: Bool
    /// A change to the subscription's text is loaded into the running core by AgentSwitch itself, without waiting for
    /// Clash Verge to fetch it (docs/clash-v0.md §7.12).
    public var applyNow: Bool

    /// The intervals offered (the service takes no other).
    public static let updateHours = [0, 1, 6, 12, 24]

    public init(claude: ClashServiceNodes = .init(), openai: ClashServiceNodes = .init(), direct: [String] = [], autoUpdateHours: Int = 24,
                templates: ClashTemplates = .init(), renameDefault: Bool = false, dns: ClashDNSSetting = .init(), ownRules: Bool = false, applyNow: Bool = false) {
        self.claude = claude
        self.openai = openai
        self.direct = direct
        self.autoUpdateHours = autoUpdateHours
        self.templates = templates
        self.renameDefault = renameDefault
        self.dns = dns
        self.ownRules = ownRules
        self.applyNow = applyNow
    }

    private enum CodingKeys: String, CodingKey { case claude, openai, direct, autoUpdateHours, templates, renameDefault, dns, ownRules, applyNow }

    /// A service from before §7.11 (another node not yet updated) says nothing of `ownRules`, one from before §7.12
    /// nothing of `applyNow`: off.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(claude: try c.decode(ClashServiceNodes.self, forKey: .claude), openai: try c.decode(ClashServiceNodes.self, forKey: .openai),
                  direct: try c.decode([String].self, forKey: .direct), autoUpdateHours: try c.decode(Int.self, forKey: .autoUpdateHours),
                  templates: try c.decode(ClashTemplates.self, forKey: .templates), renameDefault: try c.decode(Bool.self, forKey: .renameDefault),
                  dns: try c.decode(ClashDNSSetting.self, forKey: .dns), ownRules: try c.decodeIfPresent(Bool.self, forKey: .ownRules) ?? false,
                  applyNow: try c.decodeIfPresent(Bool.self, forKey: .applyNow) ?? false)
    }

    public subscript(service: ClashService) -> ClashServiceNodes {
        get { service == .claude ? claude : openai }
        set { if service == .claude { claude = newValue } else { openai = newValue } }
    }
}

/// A node set the subscription names by link, which AgentSwitch fetches too.
public struct ClashSourceProvider: Decodable, Equatable, Sendable {
    public let name: String
    public let host: String
    public let nodes: Int
    public let error: String?
}

public struct ClashTraffic: Decodable, Equatable, Sendable {
    /// Bytes used, of how many; when it ends (ms), if the subscription service says.
    public let used: Double
    public let total: Double
    public let expire: Double?
}

public struct ClashSource: Decodable, Equatable, Sendable {
    /// `link` or `file`.
    public let kind: String
    public let name: String
    /// Where a link goes (its host; the rest is never told).
    public let host: String?
    public let updatedAt: Double
    public let nodes: Int
    public let providers: [ClashSourceProvider]
    /// The last fetch did not work; what is kept is the one before.
    public let error: String?
    public let traffic: ClashTraffic?
}

/// One of the subscriptions worked from (docs/clash-v0.md §10): a link or a file with its own name and its own
/// interval.
public struct ClashSubscription: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    /// `link` or `file`.
    public let kind: String
    public let name: String
    public let host: String?
    public let updatedAt: Double
    public let nodes: Int
    public let providers: [ClashSourceProvider]
    public let error: String?
    public let traffic: ClashTraffic?
    /// Fetched again after this many hours; 0: only when asked.
    public let hours: Int

    public init(id: String, kind: String, name: String, host: String? = nil, updatedAt: Double, nodes: Int, providers: [ClashSourceProvider] = [],
                error: String? = nil, traffic: ClashTraffic? = nil, hours: Int) {
        self.id = id
        self.kind = kind
        self.name = name
        self.host = host
        self.updatedAt = updatedAt
        self.nodes = nodes
        self.providers = providers
        self.error = error
        self.traffic = traffic
        self.hours = hours
    }

    /// Where it comes from, in a word: a link's host, `File` for a file.
    public var origin: String { kind == "link" ? (host ?? name) : "File" }
}

/// A node in the table of them all: its name as Clash has it, the subscription it is of, whether it is switched off.
public struct ClashNode: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let sub: String
    public let type: String
    public let off: Bool
    public var id: String { name }

    public init(name: String, sub: String, type: String, off: Bool) {
        self.name = name
        self.sub = sub
        self.type = type
        self.off = off
    }
}

public struct ClashServiceState: Decodable, Equatable, Sendable {
    /// Its two groups by the names they have in Clash.
    public let group: String
    public let auto: String
    /// The core has this service's groups from AgentSwitch: what its group uses can be picked from here.
    public let live: Bool
    /// What its group uses now (a node, or the automatic group's name), and what the automatic one uses.
    public let now: String?
    public let autoNow: String?
    /// Chosen nodes the subscription no longer has.
    public let missing: [String]

    /// The group follows the automatic one.
    public var automatic: Bool { live && now == auto }
}

/// A rule template as it stands: on or off, whether its rules are the user's own, how many are in use.
public struct ClashTemplateState: Decodable, Equatable, Sendable {
    public let on: Bool
    public let custom: Bool
    public let count: Int
}

/// A template's rules as they are in use, to edit them.
public struct ClashTemplateRules: Decodable, Equatable, Sendable {
    public let rules: [String]
    public let custom: Bool

    public init(rules: [String], custom: Bool) {
        self.rules = rules
        self.custom = custom
    }
}

/// One line of the routing check (docs/clash-v0.md §7.9): a kind of traffic, the name tried for it, what it should do
/// and what the running core did with it.
public struct ClashCheckRow: Decodable, Equatable, Sendable, Identifiable {
    public struct Expect: Decodable, Equatable, Sendable {
        /// `group`, `direct` or `reject`.
        public let kind: String
        public let group: String?
    }

    public struct Exit: Decodable, Equatable, Sendable {
        public let ip: String
        public let loc: String
    }

    public struct Observed: Decodable, Equatable, Sendable {
        /// `proxied`, `direct`, `rejected`, or `unknown` (the core listed nothing: the node did not answer).
        public let outcome: String
        /// The rule that matched, as the core names it.
        public let rule: String?
        /// The way out, from the group the rule names down to the node.
        public let path: [String]
        /// Where the far end saw it come from, where that was asked.
        public let exit: Exit?
        public let ms: Int?
    }

    public let id: String
    public let title: String
    public let host: String
    /// nil: nothing is asked of this kind here (its template is off); it is shown for what it is.
    public let expect: Expect?
    public let observed: Observed
    public let ok: Bool?

    /// What happened, in a line: `RuleSet as-claude → Claude → Claude自动选择 → 日本家宽-02`, `Rejected`, `No Answer`.
    public var route: String {
        switch observed.outcome {
        case "rejected": return "Rejected"
        case "unknown": return "No Answer"
        default: return ([observed.rule].compactMap { $0 } + observed.path).joined(separator: " → ")
        }
    }

    /// Where the far end saw it come from and how long it took: `JP 126.36.1.2 · 362 ms`; nil where it was not asked.
    public var seen: String? {
        guard let exit = observed.exit else { return nil }
        return ([exit.loc, exit.ip].filter { !$0.isEmpty }.joined(separator: " ")) + (observed.ms.map { " · \($0) ms" } ?? "")
    }

    /// What it should have done, said when it did not; nil when it did, or nothing was asked.
    public var problem: String? {
        guard ok == false, let expect else { return nil }
        let should = expect.kind == "group" ? "应该走 \(expect.group ?? "") 这一组" : expect.kind == "direct" ? "应该直连" : "应该被拦截"
        return observed.outcome == "unknown" ? "\(should)，但内核没有列出这条连接（节点没有回应，或没有连上）。" : "\(should)，实际不是。"
    }
}

public struct ClashProfile: Decodable, Equatable, Sendable, Identifiable {
    public let uid: String
    public let name: String
    public let type: String
    public var id: String { uid }
}

public struct ClashView: Decodable, Equatable, Sendable {
    /// Clash Verge is on this Mac; its core answers.
    public let found: Bool
    public let running: Bool
    public let version: String?
    public let tun: Bool?
    public let source: ClashSource?
    /// Every node that can be used, by name.
    public let nodes: [String]
    /// Each subscription, every node of them with the ones switched off, and whether there are several (§10). nil
    /// from a service that knows of one subscription alone (another node not yet updated).
    public let subscriptions: [ClashSubscription]?
    public let table: [ClashNode]?
    public let together: Bool?
    /// Clash Verge's own subscriptions, to import one.
    public let profiles: [ClashProfile]
    public let settings: ClashSettings
    private let services: [String: ClashServiceState]
    private let templates: [String: ClashTemplateState]
    /// The subscription's default group, which can be called `Manual`; nil: it has none such, or has a `Manual`.
    public let defaultGroup: String?
    public let dns: ClashDNSState
    /// The core runs the subscription AgentSwitch makes; it is the one made now (else Clash Verge fetches it again).
    public let active: Bool
    public let upToDate: Bool
    /// The link Clash Verge takes the subscription by.
    public let install: String
    /// When Clash Verge last fetched it (ms); nil: not since the service started.
    public let fetchedAt: Double?
    /// With `applyNow` on: what the core said of the subscription it would not load; nil: it took it, or there was
    /// nothing to load (and a service from before §7.12 says nothing).
    public let applyProblem: String?

    public func state(_ service: ClashService) -> ClashServiceState? { services[service.rawValue] }

    /// The service keeps several subscriptions (§10); one that does not has the one, replaced or removed.
    public var keepsSeveral: Bool { subscriptions != nil }

    /// The subscriptions to show: as the service lists them, or the only one of a service that knows of one (its id
    /// is empty: there is nothing to call it by).
    public var listed: [ClashSubscription] {
        if let subscriptions { return subscriptions }
        guard let source else { return [] }
        return [ClashSubscription(id: "", kind: source.kind, name: source.name, host: source.host, updatedAt: source.updatedAt, nodes: source.nodes,
                                  providers: source.providers, error: source.error, traffic: source.traffic, hours: settings.autoUpdateHours)]
    }

    /// The groups and the rules are AgentSwitch's alone: asked for, or there are several subscriptions.
    public var ownRules: Bool { settings.ownRules || together == true }

    public func state(_ template: ClashTemplate) -> ClashTemplateState? { templates[template.rawValue] }

    /// What is still to do, in order; empty when nothing is.
    public var todo: [String] {
        guard found else { return ["这台 Mac 上没有找到 Clash Verge。"] }
        guard running else { return ["Clash Verge 没有在运行：打开它。"] }
        var steps: [String] = []
        if source == nil { steps.append("先添加一份订阅：一条链接、一个文件，或者从 Clash Verge 导入。") }
        else if !active { steps.append("在 Clash Verge 里添加并切换到 AgentSwitch 订阅。") }
        else if !upToDate {
            if let applyProblem { steps.append("内核没有接受新的订阅：\(applyProblem)") }
            else { steps.append("订阅有改动，Clash Verge 还没有取到：在那里更新一次 AgentSwitch 订阅，或者等它每小时自己来取。") }
        }
        if tun == false { steps.append("打开 Clash Verge 的 TUN 模式。") }
        return steps
    }
}

/// The page's short words (docs/ui-v0.md §7.2.7: a unit that starts with a digit is written as it is).
public enum ClashText {
    /// How long a call that fetches from the subscription service may take (the service gives each fetch 30 s).
    static let fetchTimeout: TimeInterval = 100

    /// `428 ms`; `Timeout` for a node that did not answer; nothing for one not tried.
    public static func delay(_ tried: Int??) -> String {
        guard let tried else { return "" }
        return tried.map { "\($0) ms" } ?? "Timeout"
    }

    /// `12.3 / 100 GB`, and when it ends if that is said.
    public static func traffic(_ traffic: ClashTraffic, calendar: Calendar = .current) -> String {
        let gb = 1_073_741_824.0
        let number = { (bytes: Double) -> String in
            let value = bytes / gb
            return value >= 100 || value == value.rounded() ? String(Int(value.rounded())) : String(format: "%.1f", value)
        }
        var text = "\(number(traffic.used)) / \(number(traffic.total)) GB"
        if let expire = traffic.expire {
            let day = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: expire / 1000))
            text += " · Expires \(day.year ?? 0)/\(day.month ?? 0)/\(day.day ?? 0)"
        }
        return text
    }

    /// `1 h`, `24 h`; `Off` for never.
    public static func interval(hours: Int) -> String { hours == 0 ? "Off" : "\(hours) h" }

    /// `42 Nodes`, `1 Node`.
    public static func nodes(_ count: Int) -> String { count == 1 ? "1 Node" : "\(count) Nodes" }

    /// What the table of nodes shows: one subscription's alone where one is picked (nil: all), and those whose name has
    /// what is searched for, whatever its case.
    public static func filtered(_ table: [ClashNode], subscription: String?, search: String) -> [ClashNode] {
        let wanted = search.trimmingCharacters(in: .whitespaces)
        return table.filter { node in
            (subscription == nil || node.sub == subscription) && (wanted.isEmpty || node.name.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive]) != nil)
        }
    }

    /// `47 Nodes`, and how many are switched off when any is: `47 Nodes · 3 Off`.
    public static func nodeCount(shown: Int, off: Int) -> String { nodes(shown) + (off > 0 ? " · \(off) Off" : "") }

    /// `169 Rules`, `1 Rule`.
    public static func rules(_ count: Int) -> String { count == 1 ? "1 Rule" : "\(count) Rules" }

    /// The lines of an edited template, as they go to the service (which says which of them is not a rule).
    public static func lines(_ text: String) -> [String] { text.components(separatedBy: .newlines) }

    /// Where the subscription comes from, in a line: a link's host, a file's name.
    public static func origin(_ source: ClashSource) -> String {
        source.kind == "link" ? (source.host ?? source.name) : source.name
    }
}

extension DaemonClient {
    public func clash() async throws -> ClashView { try decode(ClashView.self, try await call("GET", "/clash")) }

    public func saveClash(_ settings: ClashSettings) async throws -> ClashView {
        try decode(ClashView.self, try await call("PUT", "/clash/settings", body: try JSONEncoder().encode(settings), timeout: 20))
    }

    /// Work from this link from now on (fetched now).
    public func setClashSource(link: String) async throws -> ClashView { try await clashSource(["link": link]) }

    /// Work from this file's text.
    public func setClashSource(yaml: String, name: String) async throws -> ClashView { try await clashSource(["yaml": yaml, "name": name]) }

    /// Take one of Clash Verge's own subscriptions in.
    public func setClashSource(verge uid: String) async throws -> ClashView { try await clashSource(["verge": uid]) }

    /// The routing check: a connection of each kind through the running core, and what the core did with it.
    public func checkClash() async throws -> [ClashCheckRow] {
        struct Answer: Decodable { let rows: [ClashCheckRow] }
        return try decode(Answer.self, try await call("POST", "/clash/check", timeout: 40)).rows
    }

    /// The DNS template's text as it is in use.
    public func clashDNS() async throws -> ClashDNSText { try decode(ClashDNSText.self, try await call("GET", "/clash/dns")) }

    /// A template's rules as they are in use.
    public func clashTemplate(_ template: ClashTemplate) async throws -> ClashTemplateRules {
        try decode(ClashTemplateRules.self, try await call("GET", "/clash/templates/\(template.rawValue)"))
    }

    public func removeClashSource() async throws -> ClashView { try decode(ClashView.self, try await call("DELETE", "/clash/source")) }

    /// The subscription fetched again now.
    public func updateClash() async throws -> ClashView { try decode(ClashView.self, try await call("POST", "/clash/update", timeout: ClashText.fetchTimeout)) }

    /// A service's group uses `node` from now on; nil: its automatic group.
    public func selectClash(_ service: ClashService, node: String?) async throws -> ClashView {
        let body: [String: Any] = ["service": service.rawValue, "node": node ?? NSNull()]
        return try decode(ClashView.self, try await call("POST", "/clash/select", body: try JSONSerialization.data(withJSONObject: body), timeout: 20))
    }

    /// One more subscription to work from (docs/clash-v0.md §10): a link, a file's text, or one of Clash Verge's.
    public func addClashSubscription(link: String) async throws -> ClashView { try await clashSubscription(["link": link]) }
    public func addClashSubscription(yaml: String, name: String) async throws -> ClashView { try await clashSubscription(["yaml": yaml, "name": name]) }
    public func addClashSubscription(verge uid: String) async throws -> ClashView { try await clashSubscription(["verge": uid]) }

    /// A subscription's name, or how often it is fetched again.
    public func editClashSubscription(_ id: String, name: String? = nil, hours: Int? = nil) async throws -> ClashView {
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let hours { body["hours"] = hours }
        return try decode(ClashView.self, try await call("PATCH", "/clash/subscriptions/\(id)", body: try JSONSerialization.data(withJSONObject: body), timeout: 20))
    }

    public func removeClashSubscription(_ id: String) async throws -> ClashView {
        try decode(ClashView.self, try await call("DELETE", "/clash/subscriptions/\(id)", timeout: 20))
    }

    /// One subscription fetched again now.
    public func updateClashSubscription(_ id: String) async throws -> ClashView {
        try decode(ClashView.self, try await call("POST", "/clash/subscriptions/\(id)/update", timeout: ClashText.fetchTimeout))
    }

    /// A node is left out of everything from now on, or is back.
    public func setClashNode(_ name: String, off: Bool) async throws -> ClashView {
        try decode(ClashView.self, try await call("POST", "/clash/node", body: try JSONSerialization.data(withJSONObject: ["name": name, "off": off]), timeout: 20))
    }

    /// How long every node takes to answer, in ms (nil: no answer), whatever it is used for.
    public func clashDelays() async throws -> [String: Int?] {
        struct Answer: Decodable { let delays: [String: Int?] }
        let body = try JSONSerialization.data(withJSONObject: ["service": "any", "scope": "all"])
        return try decode(Answer.self, try await call("POST", "/clash/delays", body: body, timeout: 30)).delays
    }

    private func clashSubscription(_ body: [String: String]) async throws -> ClashView {
        try decode(ClashView.self, try await call("POST", "/clash/subscriptions", body: try JSONSerialization.data(withJSONObject: body), timeout: ClashText.fetchTimeout))
    }

    /// How long each node takes to reach the service, in ms (nil: no answer): the chosen ones, or every node.
    public func clashDelays(_ service: ClashService, all: Bool) async throws -> [String: Int?] {
        struct Answer: Decodable { let delays: [String: Int?] }
        let body = try JSONSerialization.data(withJSONObject: ["service": service.rawValue, "scope": all ? "all" : "chosen"])
        return try decode(Answer.self, try await call("POST", "/clash/delays", body: body, timeout: 20)).delays
    }

    private func clashSource(_ body: [String: String]) async throws -> ClashView {
        try decode(ClashView.self, try await call("POST", "/clash/source", body: try JSONSerialization.data(withJSONObject: body), timeout: ClashText.fetchTimeout))
    }
}
