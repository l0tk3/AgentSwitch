import Foundation

// What the Browser page writes (docs/browser-v0.md §1, demo docs/design/implemented/browser.html): the address bar's text,
// the list's rows and group labels, the footer's owner, the recent addresses a new tab offers, and what the bar counts.
// Short words in English, sentences in formal Chinese (ui-v0 §4.1, §7.2.7).

public enum BrowserAddress {
    /// The address bar at rest: https without its scheme (the lock says it), a local server as `localhost:5173/path`,
    /// a file as its `file://` URL with the path readable, nothing for a blank tab; anything else as it is.
    public static func display(_ raw: String) -> String {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return raw }
        switch scheme {
        case "about":
            return raw == "about:blank" ? "" : raw
        case "file":
            return "file://" + (url.path.isEmpty ? "/" : url.path)
        case "https", "http":
            let host = url.host ?? ""
            if isLocal(host) {
                let port = url.port ?? (scheme == "https" ? 443 : 80)
                return "localhost:\(port)" + rest(of: url)
            }
            let shown = host + (url.port.map { ":\($0)" } ?? "") + rest(of: url)
            return scheme == "https" ? shown : "http://" + shown
        default:
            return raw
        }
    }

    /// The address bar while it is edited: the whole URL, readable (percent escapes of a path decoded); empty for a
    /// blank tab.
    public static func editing(_ raw: String) -> String {
        if raw.isEmpty || raw == "about:blank" { return "" }
        if raw.lowercased().hasPrefix("file:") { return raw.removingPercentEncoding ?? raw }
        return raw
    }

    /// The lock: an https page.
    public static func isSecure(_ raw: String) -> Bool { raw.lowercased().hasPrefix("https://") }

    /// The path, query and fragment after the host, readable; nothing for the bare `/`.
    static func rest(of url: URL) -> String {
        let path = url.path.isEmpty || url.path == "/" ? (url.query == nil && url.fragment == nil ? "" : "/") : url.path
        let query = url.query.map { "?" + ($0.removingPercentEncoding ?? $0) } ?? ""
        let fragment = url.fragment.map { "#" + $0 } ?? ""
        return path + query + fragment
    }

    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return h == "localhost" || h.hasSuffix(".localhost") || h == "127.0.0.1" || h == "::1" || h == "0.0.0.0"
    }
}

/// The recent addresses a new tab offers, newest first, kept in the app's preferences. Only where a page is — scheme,
/// host, port and path — is kept: the query, the fragment and any user name or password are dropped (they can carry
/// tokens, as the daemon's audit drops them). Blank tabs are not kept.
public enum BrowserRecents {
    public static let storeKey = "browserRecent"
    public static let limit = 8

    /// What is kept of a tab's URL; nil for one not worth keeping.
    public static func entry(for raw: String) -> String? {
        guard var parts = URLComponents(string: raw), let scheme = parts.scheme?.lowercased() else { return nil }
        switch scheme {
        case "http", "https":
            guard let host = parts.host, !host.isEmpty else { return nil }
        case "file":
            guard !parts.path.isEmpty else { return nil }
        default:
            return nil
        }
        parts.user = nil
        parts.password = nil
        parts.query = nil
        parts.fragment = nil
        return parts.string
    }

    /// `entry` in front of `list`, once, at most `limit`.
    public static func adding(_ entry: String, to list: [String]) -> [String] {
        Array(([entry] + list.filter { $0 != entry }).prefix(limit))
    }
}

public enum BrowserTabText {
    /// The row's and the bar's title: the page's title, else where it is, else `New Tab`.
    public static func title(_ tab: BrowserTab) -> String {
        let title = tab.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !title.isEmpty, title != "about:blank" { return title }
        return tab.site.isEmpty ? "New Tab" : tab.site
    }

    /// The row's second line: where it is (host, path, `localhost:5173`); `Blank` for a blank tab.
    public static func place(_ tab: BrowserTab) -> String {
        tab.kind == .blank || tab.site.isEmpty ? "Blank" : tab.site
    }

    /// What the agent waits for, in its own words (its last action's description), else `Waiting`; nil unless waiting.
    public static func waiting(_ tab: BrowserTab) -> String? {
        guard tab.status == .waiting else { return nil }
        let said = tab.action?.description.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return said.isEmpty ? "Waiting" : said
    }

    /// A group's label after `// `: the owner's label (`codex · AgentSwitch`, a task's title, `You`).
    public static func group(_ owner: BrowserOwner) -> String {
        owner.kind == .you ? "You" : (owner.label.isEmpty ? (owner.kind == .terminal ? "Terminal" : "Task") : owner.label)
    }

    /// The label over the agent's last action on the screen: `codex · click "Merge"`.
    public static func actionLabel(_ action: BrowserAction, owner: BrowserOwner) -> String {
        let said = action.description.isEmpty ? action.tool : action.description
        let name = owner.agentName
        return name.isEmpty ? said : "\(name) · \(said)"
    }

    /// A local server's row: `localhost:5173 · vite · ~/Projects/site`.
    public static func server(_ server: BrowserLocalServer, home: String) -> String {
        var parts = ["localhost:\(server.port)"]
        if !server.name.isEmpty { parts.append(server.name) }
        if !server.cwd.isEmpty { parts.append(DisplayPath.short(server.cwd, home: home)) }
        return parts.joined(separator: " · ")
    }

    /// Who holds the tab, from this Mac's point of view: nil while nobody does.
    public static func holder(_ tab: BrowserTab, screen: String) -> BrowserHolder? {
        guard let held = tab.heldBy else { return nil }
        return held == screen ? .thisMac : .elsewhere(held)
    }

    /// The footer's owner while this Mac holds the tab: `You · Taken Over from Codex` (the agent by its name), or
    /// `You · Taken Over` for your own.
    public static func heldHere(_ tab: BrowserTab) -> String {
        tab.owner.isAgent ? "You · Taken Over from \(tab.owner.agentTitle)" : "You · Taken Over"
    }

    /// What the footer says when this Mac's hold ends (`held` on the stream): two idle minutes, another screen taking
    /// it; nothing for this Mac's own `[ Hand Back ]`.
    public static func holdEnded(reason: BrowserHeldReason?, heldBy: String?) -> String? {
        switch reason {
        case .idle?: return idleHandBack
        case .take? where heldBy != nil: return "此标签已由其他屏幕接手。"
        default: return nil
        }
    }

    /// Two minutes without input gave the tab back (the same words on the iPhone).
    public static let idleHandBack = "2 分钟无操作，已自动交还。"

    /// Said once when a person takes over an agent's tab: what is typed stays on the page for the agent to see after
    /// the hand-back, and Fill Ciphertext is only on one's own tabs (docs/browser-v0.md §2 安全, §6).
    public static let takeOverNotice = "接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。"
}

/// A tab's holder as the Mac sees it.
public enum BrowserHolder: Sendable, Equatable {
    case thisMac
    /// Another screen (a phone, the web) or a paired device, by its id.
    case elsewhere(String)
}

extension PageActivity {
    /// The Browser page's tabs: agents operating them (busy), agents waiting for you.
    public static func of(_ list: BrowserTabList) -> PageActivity {
        let tabs = list.tabs
        return PageActivity(busy: tabs.filter { $0.status == .busy }.count, waiting: tabs.filter { $0.status == .waiting }.count)
    }
}

/// When the page follows a tab's stream again after the daemon refused it (an answer that is neither a dropped
/// connection, which the stream reconnects itself, nor 404): not at every poll but backing off, 2 s doubling to a minute,
/// and the reason said once, at the first refusal, until the stream works again or another tab is on screen.
public struct BrowserStreamRetry: Sendable, Equatable {
    public private(set) var id: String?
    public private(set) var failures = 0
    private var notBefore: ContinuousClock.Instant?

    public static let policy = DispatchReconnectPolicy(initial: .seconds(2), maximum: .seconds(60))

    public init() {}

    /// Whether the stream of `id` may be followed again now.
    public func allows(_ id: String, at now: ContinuousClock.Instant) -> Bool {
        guard self.id == id, let notBefore else { return true }
        return now >= notBefore
    }

    /// `id`'s stream was refused at `now`: true when this is the first refusal in a row (the reason is said then).
    public mutating func failed(_ id: String, at now: ContinuousClock.Instant) -> Bool {
        if self.id != id { self = BrowserStreamRetry(); self.id = id }
        failures += 1
        notBefore = now.advanced(by: Self.policy.delay(afterFailures: failures))
        return failures == 1
    }

    /// The stream of `id` works (or another tab is on screen: `reset()`).
    public mutating func succeeded(_ id: String) { if self.id == id { self = BrowserStreamRetry() } }
    public mutating func reset() { self = BrowserStreamRetry() }
}

/// The Browser page's defaults (docs/browser-v0.md §5).
public enum BrowserDefaults {
    /// This Mac's main window as a screen: the holder id it takes tabs over with.
    public static let screen = "mac-main"
    /// The tab list is polled this often while the page is on screen (the daemon has no list stream yet).
    public static let pollInterval: Duration = .seconds(2)
    /// And this often while the window is visible on another page, for the bar's mark on `Browser`.
    public static let backgroundPollInterval: Duration = .seconds(6)
    /// The stream asked for: the screen is on this Mac, so the daemon's 15 frames and a little more quality.
    public static let streamQuality = 80
    public static let streamFPS = 15
    /// Moves and the wheel are sent at most this often (others at once).
    public static let motionInterval: Duration = .milliseconds(33)
    /// A held tab's size follows the screen once it has stopped changing this long.
    public static let resizeDelay: Duration = .milliseconds(300)
}
