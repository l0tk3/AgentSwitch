import Foundation

// docs/mesh-v0.md: the other nodes this Mac uses, as its own service keeps them, and the rows Settings › Nodes shows.

/// A node this Mac uses (`GET /nodes`): where it is, how it is doing, and the two devices that make the pair.
public struct NodeStatus: Decodable, Equatable, Identifiable, Sendable {
    /// `revoked`: it answers, and no longer knows this Mac's device (removed there).
    public enum State: String, Sendable { case online, offline, revoked }

    /// The start of its certificate's fingerprint: what `/nodes/<id>/…` names it by.
    public let id: String
    public let name: String
    /// `mac` | `linux` as it says itself; nil until asked.
    public let kind: String?
    public let fingerprint: String
    public let port: Int
    public let lan: [String]
    public let tailnet: [String]
    public let state: State
    /// The address it answers at now.
    public let address: String?
    /// What waits for the user there, as its own Live Activity counts it; nil when it does not say.
    public let waiting: Int?
    /// This Mac's device at that node.
    public let deviceId: String
    /// That node's device here, when the pair goes both ways.
    public let inbound: String?

    public init(id: String, name: String, kind: String? = "mac", fingerprint: String = "", port: Int = 4713, lan: [String] = [], tailnet: [String] = [],
                state: State = .online, address: String? = nil, waiting: Int? = nil, deviceId: String = "", inbound: String? = nil) {
        self.id = id; self.name = name; self.kind = kind; self.fingerprint = fingerprint; self.port = port; self.lan = lan; self.tailnet = tailnet
        self.state = state; self.address = address; self.waiting = waiting; self.deviceId = deviceId; self.inbound = inbound
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = try c.require(String.self, "id")
        name = c.first(String.self, "name") ?? id
        kind = c.first(String.self, "kind")
        fingerprint = c.first(String.self, "fingerprint") ?? ""
        port = c.first(Int.self, "port") ?? 0
        lan = c.first([String].self, "lan") ?? []
        tailnet = c.first([String].self, "tailnet") ?? []
        // A node just paired is told without its state: it answered a moment ago.
        state = c.first(String.self, "state").flatMap(State.init(rawValue:)) ?? .online
        address = c.first(String.self, "address")
        waiting = c.first(Int.self, "waiting")
        deviceId = c.first(String.self, "deviceId") ?? ""
        inbound = c.first(String.self, "inbound")
    }
}

/// This Mac as a node (`GET /nodes` → `self`).
public struct NodeSelf: Decodable, Equatable, Sendable {
    public let name: String
    public let kind: String
    public let fingerprint: String?
    public let port: Int?
    /// Its remote listener is on: other nodes and phones can pair with it.
    public let listening: Bool

    public init(name: String, kind: String = "mac", fingerprint: String? = nil, port: Int? = nil, listening: Bool = true) {
        self.name = name; self.kind = kind; self.fingerprint = fingerprint; self.port = port; self.listening = listening
    }
}

public struct NodeList: Decodable, Equatable, Sendable {
    public let own: NodeSelf
    public let nodes: [NodeStatus]

    public init(own: NodeSelf, nodes: [NodeStatus]) {
        self.own = own
        self.nodes = nodes
    }

    private enum CodingKeys: String, CodingKey { case own = "self", nodes }
}

/// What a node says of itself (`GET /node`; through `/nodes/<id>/node`, another node's): the screens show only what it
/// has, and a path in its home folder as `~/…`.
public struct NodeInfo: Decodable, Equatable, Sendable {
    public let name: String
    public let kind: String
    public let version: String
    public let home: String
    public let has: [String]

    public init(name: String, kind: String = "mac", version: String = "", home: String = "", has: [String] = []) {
        self.name = name; self.kind = kind; self.version = version; self.home = home; self.has = has
    }

    public func has(_ what: String) -> Bool { has.contains(what) }
}

/// `POST /nodes` → the node paired, and how the way back went.
public struct NodeAdded: Decodable, Equatable, Sendable {
    /// `paired`: both ways. `none`: this Mac did not offer itself. `declined`: the other node did not take it.
    /// `failed`: it tried and could not reach this Mac.
    public enum Back: String, Sendable { case paired, failed, declined, none }

    public let node: NodeStatus
    public let back: Back

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        node = try c.require(NodeStatus.self, "node")
        back = c.first(String.self, "back").flatMap(Back.init(rawValue:)) ?? .none
    }
}

/// What paired nodes may do here beyond the remote list's own rules (`GET|PUT /settings/mesh`).
public struct MeshSettings: Codable, Equatable, Sendable {
    /// A paired node may type into a terminal here with a real keyboard (its keystrokes as they are).
    public var keyboard: Bool
    /// Paired devices may read this Mac's files, each inside its own scope (docs/files-v0.md §7.5).
    public var files: Bool
    /// Paired devices may change them where they may read them: new folders and files, renames, the Trash, files sent
    /// from a phone (docs/files-v0.md §12.5).
    public var changes: Bool
    /// A paired node (not a phone) may open a tool terminal (yazi) beside a terminal here (docs/yazi-v0.md §3, mesh.json
    /// `tools`); nil from a service that does not know it, and left out of what is sent then.
    public var tools: Bool?

    public init(keyboard: Bool = true, files: Bool = true, changes: Bool = true, tools: Bool? = nil) {
        self.keyboard = keyboard
        self.files = files
        self.changes = changes
        self.tools = tools
    }

    private enum Keys: String, CodingKey { case keyboard, files, changes, tools }

    /// A service from before the Files column says nothing of files, one from before §12 nothing of changes: on, as a
    /// new one is.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        keyboard = (try? c.decode(Bool.self, forKey: .keyboard)) ?? true
        files = (try? c.decode(Bool.self, forKey: .files)) ?? true
        changes = (try? c.decode(Bool.self, forKey: .changes)) ?? true
        tools = (try? c.decodeIfPresent(Bool.self, forKey: .tools)) ?? nil
    }
}

extension DaemonClient {
    /// `GET /nodes`: this Mac as a node, and the nodes it uses. Always this Mac's own service.
    public func nodes() async throws -> NodeList {
        try decode(NodeList.self, try await onNode(nil).call("GET", "/nodes"))
    }

    /// `POST /nodes {link, back}`: pair with the node a link names. The service waits for that node, and for the way
    /// back when one is offered.
    public func addNode(link: String, back: Bool) async throws -> NodeAdded {
        struct Body: Encodable { let link: String; let back: Bool }
        return try decode(NodeAdded.self, try await onNode(nil).call("POST", "/nodes", body: try JSONEncoder().encode(Body(link: link, back: back)), timeout: 40))
    }

    /// `DELETE /nodes/<id>`: stop using a node (it is told). `both`: its device here is revoked too.
    public func removeNode(id: String, both: Bool) async throws {
        _ = try await onNode(nil).call("DELETE", "/nodes/\(Self.segment(id))" + (both ? "?both=1" : ""), timeout: 15)
    }

    /// `GET /node`: what the node this client is on says of itself.
    public func nodeInfo() async throws -> NodeInfo {
        try decode(NodeInfo.self, try await call("GET", "/node"))
    }

    public func meshSettings() async throws -> MeshSettings {
        try decode(MeshSettings.self, try await onNode(nil).call("GET", "/settings/mesh"))
    }

    public func saveMeshSettings(_ settings: MeshSettings) async throws -> MeshSettings {
        try decode(MeshSettings.self, try await onNode(nil).call("PUT", "/settings/mesh", body: try JSONEncoder().encode(settings)))
    }
}

/// One row of Settings › Nodes: a node or a phone paired with this Mac, and which way the pair goes.
public struct NodeRow: Equatable, Identifiable, Sendable {
    public enum Kind: Equatable, Sendable { case mac, linux, phone }

    public let id: String
    public let name: String
    public let kind: Kind
    /// This Mac uses it: the node as this Mac's service keeps it.
    public let node: NodeStatus?
    /// It uses this Mac: its device here.
    public let device: Device?

    public var uses: Bool { node != nil }
    public var usedBy: Bool { device != nil }
    /// A phone has no service: it uses, and is never used.
    public var canBeUsed: Bool { kind != .phone }

    /// `Online · 192.168.1.30`, `Offline`, `Removed There`; for a row that only uses this Mac, its device's presence.
    public var line: String {
        if let node {
            switch node.state {
            case .online: return ["Online", node.address].compactMap { $0 }.joined(separator: " · ")
            case .offline: return "Offline"
            case .revoked: return "Removed There"
            }
        }
        return device?.online == true ? "Online" : "Offline"
    }

    public var reachable: Bool { node?.state == .online }
}

public enum NodeRows {
    /// The nodes this Mac uses first, by name, each with its device here when the pair goes both ways; then the nodes
    /// that only use this Mac; then the phones. A revoked device is not a row.
    public static func build(nodes: [NodeStatus], devices: [Device]) -> [NodeRow] {
        let active = devices.filter { !$0.isRevoked }
        let byId = Dictionary(active.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let taken = Set(nodes.compactMap(\.inbound))
        let used = nodes.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }.map { node in
            NodeRow(id: node.id, name: node.name, kind: node.kind == "linux" ? .linux : .mac, node: node, device: node.inbound.flatMap { byId[$0] })
        }
        let rest = active.filter { !taken.contains($0.id) }.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
        let kind: (Device) -> NodeRow.Kind = { $0.platform == "macos" ? .mac : $0.platform == "linux" ? .linux : .phone }
        let others = rest.map { NodeRow(id: "device-\($0.id)", name: $0.name, kind: kind($0), node: nil, device: $0) }
        return used + others.filter { $0.kind != .phone } + others.filter { $0.kind == .phone }
    }
}

/// The node menu's and the strip's words.
public enum NodeText {
    /// `LAN`, `Tailscale`: which way a node is reached, from the address that answers.
    public static func path(_ address: String?) -> String? {
        guard let address else { return nil }
        if address.hasSuffix(".ts.net") || address.hasPrefix("100.") || address.lowercased().hasPrefix("fd7a:") { return "Tailscale" }
        return "LAN"
    }

    /// The menu item's right: `2 Waiting`, `Offline`, `Removed There`.
    public static func menuDetail(_ node: NodeStatus) -> String {
        switch node.state {
        case .offline: return "Offline"
        case .revoked: return "Removed There"
        case .online: return (node.waiting ?? 0) > 0 ? "\(node.waiting ?? 0) Waiting" : path(node.address) ?? ""
        }
    }

    /// How a pairing ended, for the sheet's last line.
    public static func paired(_ added: NodeAdded) -> String {
        switch added.back {
        case .paired: return "已与 \(added.node.name) 配对，双向可用。"
        case .none: return "已与 \(added.node.name) 配对：这台 Mac 可以使用它。"
        case .declined: return "已与 \(added.node.name) 配对：这台 Mac 可以使用它；对方没有接受反向。"
        case .failed: return "已与 \(added.node.name) 配对：这台 Mac 可以使用它；对方连不上这台 Mac，反向未建立。"
        }
    }

    /// A path on a node, its home folder as `~`.
    public static func tilde(_ path: String, home: String) -> String {
        guard !home.isEmpty, path == home || path.hasPrefix(home + "/") else { return path }
        return "~" + path.dropFirst(home.count)
    }
}
