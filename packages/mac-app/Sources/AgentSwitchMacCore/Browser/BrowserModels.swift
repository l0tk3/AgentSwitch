import Foundation

// The shared browser's vocabulary as the daemon sends it (docs/browser-v0.md §5; packages/daemon/src/browser/types.ts):
// who a tab belongs to, what a screen sees of it, the Mac's local servers. Decoding is tolerant: a field the daemon adds
// or leaves out never fails the whole list, an unknown word falls back to the plain case.

/// `you`: opened by a person; `terminal` / `task`: an agent's (browser-v0 §2).
public enum BrowserOwnerKind: String, Sendable, Equatable, Decodable {
    case you, terminal, task

    public init(from decoder: Decoder) throws {
        self = BrowserOwnerKind(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .you
    }
}

/// A tab's owner: `{kind, id, label}` — `You`, `codex · AgentSwitch` (a terminal's name), a task's title.
public struct BrowserOwner: Sendable, Equatable, Decodable {
    public let kind: BrowserOwnerKind
    public let id: String
    public let label: String

    public init(kind: BrowserOwnerKind, id: String, label: String) {
        self.kind = kind
        self.id = id
        self.label = label
    }

    public static let you = BrowserOwner(kind: .you, id: "you", label: "You")

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        kind = c.first(BrowserOwnerKind.self, "kind") ?? .you
        id = c.first(String.self, "id") ?? kind.rawValue
        label = c.first(String.self, "label") ?? (kind == .you ? "You" : "")
    }

    /// An agent's tab (Take Over before driving it).
    public var isAgent: Bool { kind != .you }

    /// The agent the label starts with (`codex · AgentSwitch` → `codex`), as a key of `PixelArt.agents`; nil for you
    /// and for a label that names no agent the app draws.
    public var harness: String? {
        guard isAgent else { return nil }
        let first = label.components(separatedBy: " · ").first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        let key: String = switch first {
        case "claude", "claude code", "claude-code": "claude-code"
        default: first
        }
        return PixelArt.agents[key] != nil ? key : nil
    }

    /// The agent's name alone (`codex`), for the screen's label over its last action; the label when it names none.
    public var agentName: String {
        guard isAgent else { return label }
        return label.components(separatedBy: " · ").first?.trimmingCharacters(in: .whitespaces) ?? label
    }

    /// The agent as people call it (`Codex`, `Claude Code` for the label's `claude`), for a sentence or the holder line.
    public var agentTitle: String { HarnessName.display(agentName) }
}

/// `busy`: an agent is operating the tab; `waiting`: an agent waits for you (a code, a login, a confirmation).
public enum BrowserTabStatus: String, Sendable, Equatable, Decodable {
    case idle, busy, waiting

    public init(from decoder: Decoder) throws {
        self = BrowserTabStatus(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .idle
    }
}

/// What kind of place a tab shows: a site, a file of the Mac's, a local server, nothing.
public enum BrowserPlaceKind: String, Sendable, Equatable, Decodable {
    case web, file, local, blank

    public init(from decoder: Decoder) throws {
        self = BrowserPlaceKind(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .web
    }
}

/// A rectangle in the page's CSS pixels (the viewport's, not the frame's).
public struct BrowserBox: Sendable, Equatable, Decodable {
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

/// What an agent just did, for the overlay on the screen (`codex · click "Merge"`); set by the agent bridge.
public struct BrowserAction: Sendable, Equatable, Decodable {
    public let tool: String
    public let description: String
    public let box: BrowserBox?
    public let at: Date?

    public init(tool: String, description: String, box: BrowserBox? = nil, at: Date? = nil) {
        self.tool = tool
        self.description = description
        self.box = box
        self.at = at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        tool = c.first(String.self, "tool") ?? ""
        description = c.first(String.self, "description") ?? ""
        box = c.first(BrowserBox.self, "box")
        at = c.date("at")
    }
}

/// The page's size in CSS pixels, its device pixel ratio, whether it is emulated as a phone, and the holding screen
/// that set it (nil: the default).
public struct BrowserViewport: Sendable, Equatable, Decodable {
    public let width: Int
    public let height: Int
    public let scale: Double
    public let mobile: Bool
    public let by: String?

    public init(width: Int, height: Int, scale: Double = 1, mobile: Bool = false, by: String? = nil) {
        self.width = width
        self.height = height
        self.scale = scale
        self.mobile = mobile
        self.by = by
    }

    /// Every tab's size until a screen that holds it sets its own (daemon DEFAULT_VIEWPORT).
    public static let standard = BrowserViewport(width: 1280, height: 800)

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        width = c.first(Int.self, "width") ?? c.first(Double.self, "width").map { Int($0) } ?? Self.standard.width
        height = c.first(Int.self, "height") ?? c.first(Double.self, "height").map { Int($0) } ?? Self.standard.height
        scale = c.first(Double.self, "scale") ?? 1
        mobile = c.first(Bool.self, "mobile") ?? false
        by = c.first(String.self, "by")
    }
}

/// One tab as the list and the screens see it (`GET /browser/tabs`, a stream's `tab` event).
public struct BrowserTab: Sendable, Equatable, Identifiable, Decodable {
    public let id: String
    public let owner: BrowserOwner
    public let title: String
    public let url: String
    /// The list's second line: the host (`github.com`), the path (`~/x/mesh.html`) or `localhost:5173`.
    public let site: String
    public let kind: BrowserPlaceKind
    public let status: BrowserTabStatus
    public let loading: Bool
    /// The screen (or paired device) that has taken the tab over; nil while nobody holds it.
    public let heldBy: String?
    public let action: BrowserAction?
    public let viewport: BrowserViewport
    public let openedAt: Date?

    public init(id: String, owner: BrowserOwner = .you, title: String = "", url: String = "", site: String = "",
                kind: BrowserPlaceKind = .web, status: BrowserTabStatus = .idle, loading: Bool = false, heldBy: String? = nil,
                action: BrowserAction? = nil, viewport: BrowserViewport = .standard, openedAt: Date? = nil) {
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

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = try c.require(String.self, "id")
        owner = c.first(BrowserOwner.self, "owner") ?? .you
        title = c.first(String.self, "title") ?? ""
        url = c.first(String.self, "url") ?? ""
        site = c.first(String.self, "site") ?? ""
        kind = c.first(BrowserPlaceKind.self, "kind") ?? .web
        status = c.first(BrowserTabStatus.self, "status") ?? .idle
        loading = c.first(Bool.self, "loading") ?? false
        heldBy = c.first(String.self, "heldBy", "held_by")
        action = c.first(BrowserAction.self, "action")
        viewport = c.first(BrowserViewport.self, "viewport") ?? .standard
        openedAt = c.date("openedAt", "opened_at")
    }

    /// A copy with some fields changed (the stream's events change one at a time); the rest kept.
    public func with(title: String? = nil, url: String? = nil, site: String? = nil, kind: BrowserPlaceKind? = nil,
                     status: BrowserTabStatus? = nil, loading: Bool? = nil, heldBy: String?? = nil, action: BrowserAction?? = nil,
                     viewport: BrowserViewport? = nil) -> BrowserTab {
        BrowserTab(id: id, owner: owner, title: title ?? self.title, url: url ?? self.url, site: site ?? self.site,
                   kind: kind ?? self.kind, status: status ?? self.status, loading: loading ?? self.loading,
                   heldBy: heldBy ?? self.heldBy, action: action ?? self.action, viewport: viewport ?? self.viewport,
                   openedAt: openedAt)
    }
}

/// One owner's tabs, in the order they opened.
public struct BrowserTabGroup: Sendable, Equatable, Decodable {
    public let owner: BrowserOwner
    public let tabs: [BrowserTab]

    public init(owner: BrowserOwner, tabs: [BrowserTab]) {
        self.owner = owner
        self.tabs = tabs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let tabs = (c.first([LossyTab].self, "tabs") ?? []).compactMap(\.tab)
        self.tabs = tabs
        owner = c.first(BrowserOwner.self, "owner") ?? tabs.first?.owner ?? .you
    }
}

/// `GET /browser/tabs`: whether Chrome is up and the tabs by owner (terminals' agents, tasks, then yours).
public struct BrowserTabList: Sendable, Equatable, Decodable {
    public let running: Bool
    public let groups: [BrowserTabGroup]

    public init(running: Bool = false, groups: [BrowserTabGroup] = []) {
        self.running = running
        self.groups = groups
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        running = c.first(Bool.self, "running") ?? false
        groups = (c.first([BrowserTabGroup].self, "groups") ?? []).filter { !$0.tabs.isEmpty }
    }

    public static let empty = BrowserTabList()

    /// Every tab, in the list's order.
    public var tabs: [BrowserTab] { groups.flatMap(\.tabs) }

    public func tab(_ id: String?) -> BrowserTab? {
        guard let id else { return nil }
        return tabs.first { $0.id == id }
    }

    /// The list with one tab replaced by a newer copy (a stream's event came before the next poll); unchanged when the
    /// tab is not in it.
    public func replacing(_ tab: BrowserTab) -> BrowserTabList {
        BrowserTabList(running: running, groups: groups.map { group in
            BrowserTabGroup(owner: group.owner, tabs: group.tabs.map { $0.id == tab.id ? tab : $0 })
        })
    }

    /// The list without a tab (closed); a group left empty goes too.
    public func removing(_ id: String) -> BrowserTabList {
        BrowserTabList(running: running, groups: groups.compactMap { group in
            let tabs = group.tabs.filter { $0.id != id }
            return tabs.isEmpty ? nil : BrowserTabGroup(owner: group.owner, tabs: tabs)
        })
    }

    /// The tab to show: `wanted` while it is still there, else the one at the same place in the list (the next one,
    /// or the last when it was the last), else the first; nil for an empty list.
    public func selection(keeping wanted: String?, previous: BrowserTabList? = nil) -> String? {
        let all = tabs
        if let wanted, all.contains(where: { $0.id == wanted }) { return wanted }
        if let wanted, let before = previous?.tabs, let index = before.firstIndex(where: { $0.id == wanted }) {
            // The tabs that came after it, then before it: the nearest still open.
            let after = before[(index + 1)...].map(\.id), earlier = before[..<index].reversed().map(\.id)
            if let next = (after + earlier).first(where: { id in all.contains { $0.id == id } }) { return next }
        }
        return all.first?.id
    }
}

/// A tab that does not decode is left out of its group rather than failing the list.
private struct LossyTab: Decodable {
    let tab: BrowserTab?
    init(from decoder: Decoder) throws { tab = try? BrowserTab(from: decoder) }
}

/// One of the Mac's local servers a new tab offers (`GET /browser/servers`).
public struct BrowserLocalServer: Sendable, Equatable, Identifiable, Decodable {
    public let port: Int
    /// `loopback` (127.0.0.1 / ::1) or `all` (every interface).
    public let bind: String
    public let pid: Int
    /// A short name: `vite`, `next-server`, `python3 -m http.server`.
    public let name: String
    public let cwd: String
    public let url: String

    public var id: Int { port }

    public init(port: Int, bind: String = "loopback", pid: Int = 0, name: String = "", cwd: String = "", url: String? = nil) {
        self.port = port
        self.bind = bind
        self.pid = pid
        self.name = name
        self.cwd = cwd
        self.url = url ?? "http://localhost:\(port)/"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        port = try c.require(Int.self, "port")
        bind = c.first(String.self, "bind") ?? "loopback"
        pid = c.first(Int.self, "pid") ?? 0
        name = c.first(String.self, "name") ?? ""
        cwd = c.first(String.self, "cwd") ?? ""
        url = c.first(String.self, "url") ?? "http://localhost:\(port)/"
    }
}

/// `{servers: [...]}`, a server that does not decode left out.
struct BrowserServerList: Decodable {
    let servers: [BrowserLocalServer]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        servers = (c.first([LossyServer].self, "servers") ?? []).compactMap(\.server)
    }

    private struct LossyServer: Decodable {
        let server: BrowserLocalServer?
        init(from decoder: Decoder) throws { server = try? BrowserLocalServer(from: decoder) }
    }
}

/// `{tab}`: the answer of opening, navigating, taking over, handing back and resizing.
struct BrowserTabReply: Decodable {
    let tab: BrowserTab
}
