import CoreGraphics
import Foundation

// The shared browser (docs/browser-v0.md §5): the tabs `GET /browser/tabs` lists, what a tab's stream brings and what a
// screen may send. Unknown fields and values decode leniently, so a newer Mac never empties the list.

/// Who a tab belongs to: a person (`you`), an agent in a terminal, or a dispatched task.
public struct BrowserTabOwner: Decodable, Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        case you, terminal, task
        case other(String)

        init(rawValue: String) {
            switch rawValue {
            case "you": self = .you
            case "terminal": self = .terminal
            case "task": self = .task
            default: self = .other(rawValue)
            }
        }
    }

    public let kind: Kind
    public let id: String
    /// `You`, the terminal's name (`codex · AgentSwitch`), or the task's title.
    public let label: String

    public init(kind: Kind, id: String, label: String) {
        self.kind = kind
        self.id = id
        self.label = label
    }

    public static let you = BrowserTabOwner(kind: .you, id: "you", label: "You")

    /// An agent's tab: people drive it only once they have taken it over.
    public var isAgent: Bool { kind != .you }

    private enum CodingKeys: String, CodingKey { case kind, id, label }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = Kind(rawValue: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "you")
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
    }

    /// The agent named first in a label (`codex · AgentSwitch` → `codex`), when the label says one.
    public var namedHarness: String? {
        let first = label.components(separatedBy: " · ").first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        return ["claude code": "claude-code", "claude": "claude-code", "codex": "codex", "opencode": "opencode", "pi": "pi"][first]
    }

    /// The agent as people call it (`Codex`, `Claude Code`), for the holder line and sentences: `harness` (the terminal's
    /// or the task's, when known) or the one the label names, by its proper name (ModelName); else the label's first part.
    public func agentName(harness: String? = nil) -> String {
        if let id = harness ?? namedHarness { return ModelName.harness(id) }
        return label.components(separatedBy: " · ").first ?? label
    }
}

/// `busy`: an agent is operating the tab; `waiting`: it waits for the user (a code, a login, a confirmation).
public enum BrowserTabStatus: Sendable, Hashable, Decodable {
    case idle, busy, waiting
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "idle": self = .idle
        case "busy": self = .busy
        case "waiting": self = .waiting
        default: self = .other(rawValue)
        }
    }

    public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }

    /// The word on screen (docs/ui-v0.md §7.2.7, as the terminals: Busy · Waiting · Idle).
    public var label: String {
        switch self {
        case .idle: return "Idle"
        case .busy: return "Busy"
        case .waiting: return "Waiting"
        case .other(let s): return s
        }
    }
}

/// What kind of place a tab shows: a site, a file of the Mac's, a local server, nothing.
public enum BrowserPlaceKind: String, Sendable, Hashable, Decodable {
    case web, file, local, blank

    public init(from decoder: Decoder) throws {
        self = BrowserPlaceKind(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .web
    }
}

/// A rectangle in the page's CSS pixels (the viewport's).
public struct BrowserBox: Decodable, Sendable, Hashable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

/// What an agent just did, for the outline over the screen (`codex · click "Merge"`).
public struct BrowserAgentAction: Decodable, Sendable, Hashable {
    public let tool: String
    public let description: String
    public let box: BrowserBox?
    public let at: Int64

    public init(tool: String, description: String, box: BrowserBox? = nil, at: Int64 = 0) {
        self.tool = tool
        self.description = description
        self.box = box
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case tool, description, box, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? ""
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        box = try? c.decodeIfPresent(BrowserBox.self, forKey: .box)
        at = (try? c.decodeIfPresent(Int64.self, forKey: .at)) ?? 0
    }

    /// What the outline's label says: the agent and what it did.
    public func said(by agent: String) -> String {
        let what = description.isEmpty ? tool : description
        return agent.isEmpty ? what : "\(agent) · \(what)"
    }
}

/// The page's size in CSS pixels, its device pixel ratio, whether it is a phone's, and the screen that set it (nil:
/// the default, 1280 × 800).
public struct BrowserViewport: Decodable, Sendable, Hashable {
    public let width: Double
    public let height: Double
    public let scale: Double
    public let mobile: Bool
    public let by: String?

    public init(width: Double, height: Double, scale: Double = 1, mobile: Bool = false, by: String? = nil) {
        self.width = width
        self.height = height
        self.scale = scale
        self.mobile = mobile
        self.by = by
    }

    public static let standard = BrowserViewport(width: 1280, height: 800)

    private enum CodingKeys: String, CodingKey { case width, height, scale, mobile, by }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        width = (try? c.decodeIfPresent(Double.self, forKey: .width)) ?? 1280
        height = (try? c.decodeIfPresent(Double.self, forKey: .height)) ?? 800
        scale = (try? c.decodeIfPresent(Double.self, forKey: .scale)) ?? 1
        mobile = (try? c.decodeIfPresent(Bool.self, forKey: .mobile)) ?? false
        by = try? c.decodeIfPresent(String.self, forKey: .by)
    }
}

/// One tab of the browser on the Mac.
public struct BrowserTabInfo: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let owner: BrowserTabOwner
    public let title: String
    public let url: String
    /// The list's second line: the host, the file's path (`~/x/mesh.html`) or `localhost:5173`.
    public let site: String
    public let kind: BrowserPlaceKind
    public let status: BrowserTabStatus
    public let loading: Bool
    /// The screen (or paired device) that has taken it over; nil while nobody holds it.
    public let heldBy: String?
    public let action: BrowserAgentAction?
    public let viewport: BrowserViewport
    public let openedAt: Int64

    public init(id: String, owner: BrowserTabOwner = .you, title: String = "", url: String = "about:blank", site: String = "",
                kind: BrowserPlaceKind = .web, status: BrowserTabStatus = .idle, loading: Bool = false, heldBy: String? = nil,
                action: BrowserAgentAction? = nil, viewport: BrowserViewport = .standard, openedAt: Int64 = 0) {
        self.id = id
        self.owner = owner
        self.title = title
        self.url = url
        self.site = site
        self.kind = kind
        self.status = status
        self.loading = loading
        self.heldBy = heldBy
        self.action = action
        self.viewport = viewport
        self.openedAt = openedAt
    }

    private enum CodingKeys: String, CodingKey { case id, owner, title, url, site, kind, status, loading, heldBy, action, viewport, openedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        owner = (try? c.decodeIfPresent(BrowserTabOwner.self, forKey: .owner)) ?? .you
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? ""
        site = (try? c.decodeIfPresent(String.self, forKey: .site)) ?? ""
        kind = (try? c.decodeIfPresent(BrowserPlaceKind.self, forKey: .kind)) ?? .web
        status = (try? c.decodeIfPresent(BrowserTabStatus.self, forKey: .status)) ?? .idle
        loading = (try? c.decodeIfPresent(Bool.self, forKey: .loading)) ?? false
        heldBy = try? c.decodeIfPresent(String.self, forKey: .heldBy)
        action = try? c.decodeIfPresent(BrowserAgentAction.self, forKey: .action)
        viewport = (try? c.decodeIfPresent(BrowserViewport.self, forKey: .viewport)) ?? .standard
        openedAt = (try? c.decodeIfPresent(Int64.self, forKey: .openedAt)) ?? 0
    }

    /// The title as a row shows it: the page's own, else where it is.
    public var displayTitle: String {
        if !title.isEmpty { return title }
        if !site.isEmpty { return site }
        return url.isEmpty ? "about:blank" : url
    }

    /// Why an agent's tab waits for you, when it said (its last action while waiting).
    public var waitingReason: String? {
        guard status == .waiting, let action, !action.description.isEmpty else { return nil }
        return action.description
    }

    /// `screen` may drive it: it holds it, or nobody does and it is a person's tab (an agent's is taken over first).
    public func drivable(by screen: String) -> Bool {
        heldBy == screen || (heldBy == nil && !owner.isAgent)
    }

    /// The same tab with what a stream event changes.
    public func applying(_ event: BrowserEvent) -> BrowserTabInfo {
        func copy(title: String? = nil, url: String? = nil, site: String? = nil, kind: BrowserPlaceKind? = nil, status: BrowserTabStatus? = nil,
                  loading: Bool? = nil, heldBy: String?? = nil, action: BrowserAgentAction?? = nil, viewport: BrowserViewport? = nil) -> BrowserTabInfo {
            BrowserTabInfo(id: id, owner: owner, title: title ?? self.title, url: url ?? self.url, site: site ?? self.site, kind: kind ?? self.kind,
                           status: status ?? self.status, loading: loading ?? self.loading, heldBy: heldBy ?? self.heldBy,
                           action: action ?? self.action, viewport: viewport ?? self.viewport, openedAt: openedAt)
        }
        switch event {
        case .tab(let tab): return tab
        case .url(let url, let site, let kind): return copy(url: url, site: site, kind: kind)
        case .title(let title): return copy(title: title)
        case .loading(let loading): return copy(loading: loading)
        case .status(let status): return copy(status: status)
        case .held(let holder, _): return copy(heldBy: .some(holder))
        case .action(let action): return copy(action: .some(action))
        case .viewport(let viewport): return copy(viewport: viewport)
        case .frame, .closed, .dropped: return self
        }
    }
}

/// The tabs of one owner, in the order they opened.
public struct BrowserTabGroup: Decodable, Sendable, Hashable, Identifiable {
    public let owner: BrowserTabOwner
    public let tabs: [BrowserTabInfo]

    public init(owner: BrowserTabOwner, tabs: [BrowserTabInfo]) {
        self.owner = owner
        self.tabs = tabs
    }

    public var id: String { "\(owner.kind):\(owner.id)" }
}

/// `GET /browser/tabs`: whether Chrome is up, and the tabs by owner (terminals', tasks', then yours).
public struct BrowserTabList: Decodable, Sendable, Hashable {
    public let running: Bool
    public let groups: [BrowserTabGroup]

    public init(running: Bool, groups: [BrowserTabGroup]) {
        self.running = running
        self.groups = groups
    }

    private enum CodingKeys: String, CodingKey { case running, groups }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        running = (try? c.decodeIfPresent(Bool.self, forKey: .running)) ?? false
        groups = ((try? c.decodeIfPresent([BrowserTabGroup].self, forKey: .groups)) ?? []).filter { !$0.tabs.isEmpty }
    }

    public var tabs: [BrowserTabInfo] { groups.flatMap(\.tabs) }
    /// Tabs whose agent waits for you: the tab's badge.
    public var waiting: Int { tabs.filter { $0.status == .waiting }.count }

    /// Without one tab (closed here, before the next read).
    public func removing(_ id: String) -> BrowserTabList {
        BrowserTabList(running: running, groups: groups.map { BrowserTabGroup(owner: $0.owner, tabs: $0.tabs.filter { $0.id != id }) }.filter { !$0.tabs.isEmpty })
    }

    /// With a tab of yours just opened, before the next read.
    public func adding(_ tab: BrowserTabInfo) -> BrowserTabList {
        guard !tabs.contains(where: { $0.id == tab.id }) else { return self }
        if let i = groups.firstIndex(where: { $0.owner == tab.owner }) {
            var next = groups
            next[i] = BrowserTabGroup(owner: groups[i].owner, tabs: groups[i].tabs + [tab])
            return BrowserTabList(running: true, groups: next)
        }
        return BrowserTabList(running: true, groups: groups + [BrowserTabGroup(owner: tab.owner, tabs: [tab])])
    }
}

/// A server listening on the Mac (`GET /browser/servers`): offered by the new-tab sheet.
public struct BrowserLocalServer: Decodable, Sendable, Hashable, Identifiable {
    public let port: Int
    /// `loopback` or `all`.
    public let bind: String
    public let pid: Int
    /// A short name: `vite`, `next-server`.
    public let name: String
    public let cwd: String
    public let url: String

    public init(port: Int, bind: String = "loopback", pid: Int = 0, name: String, cwd: String, url: String? = nil) {
        self.port = port
        self.bind = bind
        self.pid = pid
        self.name = name
        self.cwd = cwd
        self.url = url ?? "http://localhost:\(port)/"
    }

    public var id: Int { port }

    private enum CodingKeys: String, CodingKey { case port, bind, pid, name, cwd, url }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        port = try c.decode(Int.self, forKey: .port)
        bind = (try? c.decodeIfPresent(String.self, forKey: .bind)) ?? "loopback"
        pid = (try? c.decodeIfPresent(Int.self, forKey: .pid)) ?? 0
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? "http://localhost:\(port)/"
    }
}

/// One picture of a tab: a JPEG and how its pixels sit on the page (`scale` frame pixels per CSS pixel).
public struct BrowserFrame: Sendable, Equatable {
    public let seq: Int
    public let jpeg: Data
    public let width: Double
    public let height: Double
    public let scale: Double
    /// The page's viewport in CSS pixels when it was drawn.
    public let viewportWidth: Double
    public let viewportHeight: Double

    public init(seq: Int, jpeg: Data, width: Double, height: Double, scale: Double = 1, viewportWidth: Double? = nil, viewportHeight: Double? = nil) {
        self.seq = seq
        self.jpeg = jpeg
        self.width = width
        self.height = height
        self.scale = scale > 0 ? scale : 1
        self.viewportWidth = viewportWidth ?? width
        self.viewportHeight = viewportHeight ?? height
    }

    public var size: CGSize { CGSize(width: width, height: height) }
}

/// Why a hold ended or moved.
public enum BrowserHeldReason: String, Sendable, Hashable {
    case take, handBack = "hand-back", idle
}

/// Why a tab's stream ended.
public enum BrowserClosedReason: Sendable, Hashable {
    case closed, browserExited, shutdown
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "closed": self = .closed
        case "browser-exited": self = .browserExited
        case "shutdown": self = .shutdown
        default: self = .other(rawValue)
        }
    }

    /// What the page says, in formal Chinese (ui-v0 §4.1).
    public var said: String {
        switch self {
        case .closed: return "此标签已关闭。"
        case .browserExited: return "Mac 上的浏览器意外退出，标签已关闭。再次打开标签时浏览器会重新启动。"
        case .shutdown: return "Mac 上的 AgentSwitch 服务已停止，标签已关闭。"
        case .other: return "此标签已关闭。"
        }
    }
}

/// What a tab's stream brings (the SSE event names), plus `dropped`: the connection broke and is being made again
/// (said by the client, never by the Mac).
public enum BrowserEvent: Sendable, Equatable {
    case tab(BrowserTabInfo)
    case frame(BrowserFrame)
    case url(String, site: String, kind: BrowserPlaceKind)
    case title(String)
    case loading(Bool)
    case status(BrowserTabStatus)
    case held(String?, reason: BrowserHeldReason?)
    case action(BrowserAgentAction?)
    case viewport(BrowserViewport)
    case closed(BrowserClosedReason)
    case dropped

    private struct TabBody: Decodable { let tab: BrowserTabInfo }
    private struct FrameBody: Decodable {
        struct Size: Decodable { let width: Double; let height: Double }
        let seq: Int
        let data: String
        let width: Double
        let height: Double
        let scale: Double?
        let viewport: Size?
    }
    private struct URLBody: Decodable { let url: String; let site: String?; let kind: BrowserPlaceKind? }
    private struct TitleBody: Decodable { let title: String }
    private struct LoadingBody: Decodable { let loading: Bool }
    private struct StatusBody: Decodable { let status: BrowserTabStatus }
    private struct HeldBody: Decodable { let heldBy: String?; let reason: String? }
    private struct ActionBody: Decodable { let action: BrowserAgentAction? }
    private struct ViewportBody: Decodable { let viewport: BrowserViewport }
    private struct ClosedBody: Decodable { let reason: String? }

    /// One SSE message; nil for an event this phone does not know or cannot read (skipped, the stream goes on).
    public static func parse(event: String, data: String) -> BrowserEvent? {
        let bytes = Data(data.utf8)
        func read<T: Decodable>(_ type: T.Type) -> T? { try? JSONDecoder().decode(T.self, from: bytes) }
        switch event {
        case "tab": return read(TabBody.self).map { .tab($0.tab) }
        case "frame":
            guard let f = read(FrameBody.self), let jpeg = Data(base64Encoded: f.data), f.width > 0, f.height > 0 else { return nil }
            return .frame(BrowserFrame(seq: f.seq, jpeg: jpeg, width: f.width, height: f.height, scale: f.scale ?? 1,
                                       viewportWidth: f.viewport?.width, viewportHeight: f.viewport?.height))
        case "url": return read(URLBody.self).map { .url($0.url, site: $0.site ?? "", kind: $0.kind ?? .web) }
        case "title": return read(TitleBody.self).map { .title($0.title) }
        case "loading": return read(LoadingBody.self).map { .loading($0.loading) }
        case "status": return read(StatusBody.self).map { .status($0.status) }
        case "held": return read(HeldBody.self).map { .held($0.heldBy, reason: $0.reason.flatMap(BrowserHeldReason.init(rawValue:))) }
        case "action": return read(ActionBody.self).map { .action($0.action) }
        case "viewport": return read(ViewportBody.self).map { .viewport($0.viewport) }
        case "closed": return .closed(BrowserClosedReason(rawValue: read(ClosedBody.self)?.reason ?? "closed"))
        default: return nil
        }
    }
}

/// A named key of the key bar (and the letters, for shortcuts): what `POST /browser/tabs/:id/input` takes.
public enum BrowserKey: String, Sendable, Hashable, Encodable, CaseIterable {
    case escape = "Escape", tab = "Tab", enter = "Enter", backspace = "Backspace", delete = "Delete"
    case arrowLeft = "ArrowLeft", arrowUp = "ArrowUp", arrowRight = "ArrowRight", arrowDown = "ArrowDown"
    case home = "Home", end = "End", pageUp = "PageUp", pageDown = "PageDown"
}

public enum BrowserMouseButton: String, Sendable, Hashable, Encodable {
    case left, right, middle
}

/// One input event, its point in pixels of frame `seq` (the picture it was aimed at).
public enum BrowserInput: Sendable, Equatable, Encodable {
    case click(x: Double, y: Double, button: BrowserMouseButton = .left, clickCount: Int = 1, seq: Int?)
    case wheel(x: Double, y: Double, deltaX: Double, deltaY: Double, seq: Int?)
    /// Inserted as typed (`Input.insertText`): what the system keyboard committed, Chinese included.
    case text(String)
    case key(BrowserKey)

    private enum CodingKeys: String, CodingKey { case type, action, x, y, button, clickCount, deltaX, deltaY, seq, text, key }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .click(let x, let y, let button, let count, let seq):
            try c.encode("mouse", forKey: .type)
            try c.encode("click", forKey: .action)
            try c.encode(Self.rounded(x), forKey: .x)
            try c.encode(Self.rounded(y), forKey: .y)
            try c.encode(button, forKey: .button)
            try c.encode(min(max(count, 1), 3), forKey: .clickCount)
            try c.encodeIfPresent(seq, forKey: .seq)
        case .wheel(let x, let y, let dx, let dy, let seq):
            try c.encode("wheel", forKey: .type)
            try c.encode(Self.rounded(x), forKey: .x)
            try c.encode(Self.rounded(y), forKey: .y)
            try c.encode(Self.rounded(dx), forKey: .deltaX)
            try c.encode(Self.rounded(dy), forKey: .deltaY)
            try c.encodeIfPresent(seq, forKey: .seq)
        case .text(let text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case .key(let key):
            try c.encode("key", forKey: .type)
            try c.encode(key, forKey: .key)
        }
    }

    /// Whole tenths, and never a value JSON cannot carry.
    static func rounded(_ v: Double) -> Double { v.isFinite ? (v * 10).rounded() / 10 : 0 }
}

/// Input waiting to be sent, in order: consecutive wheel turns become one (the sum of their deltas, at the last point),
/// so a drag sends a few requests rather than one per touch move.
public struct BrowserInputQueue: Sendable, Equatable {
    public private(set) var events: [BrowserInput] = []

    public init() {}

    /// The most one request carries (the Mac takes 50).
    public static let batch = 50

    public mutating func append(_ event: BrowserInput) {
        if case .wheel(let x, let y, let dx, let dy, let seq) = event, case .wheel(_, _, let pdx, let pdy, _)? = events.last {
            events[events.count - 1] = .wheel(x: x, y: y, deltaX: pdx + dx, deltaY: pdy + dy, seq: seq)
        } else {
            events.append(event)
        }
    }

    public var isEmpty: Bool { events.isEmpty }

    /// The next request's events, taken off the queue.
    public mutating func next() -> [BrowserInput] {
        let out = Array(events.prefix(Self.batch))
        events.removeFirst(out.count)
        return out
    }

    public mutating func removeAll() { events.removeAll() }
}

/// What a person opens: what was typed in the address bar, a path of the Mac's, or a local port.
public enum BrowserTarget: Sendable, Hashable, Encodable {
    case url(String)
    case path(String)
    case port(Int)

    private enum CodingKeys: String, CodingKey { case url, path, port }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .url(let s): try c.encode(s, forKey: .url)
        case .path(let s): try c.encode(s, forKey: .path)
        case .port(let p): try c.encode(p, forKey: .port)
        }
    }
}

public enum BrowserHistoryAction: String, Sendable, Hashable, Encodable {
    case back, forward, reload
}
