import Foundation

/// The Browser page when the browser's tabs have windows of their own (docs/browser-v0.md §7.2; design page
/// `docs/design/implemented/browser-window.html`): the page is the list of tabs and what AgentSwitch adds to the one
/// selected — whose it is, what an agent does in it, taking over and handing back, Fill Ciphertext. The page itself
/// is in the window.
public enum BrowserWindowText {
    public enum State: Sendable, Equatable {
        /// A tab of yours.
        case yours
        /// An agent's, in its hands.
        case agent
        /// An agent's that you acted in: yours until you hand it back (or two minutes pass without input).
        case steppedIn
        /// Held by another screen (a phone): its window has that screen's size meanwhile.
        case elsewhere
    }

    public enum Action: Sendable, Equatable {
        case show, fill, handBack, copy, close
    }

    public static func state(_ tab: BrowserTab) -> State {
        if tab.heldBy == BrowserDefaults.windowScreen { return tab.owner.isAgent ? .steppedIn : .yours }
        if tab.heldBy != nil, tab.heldBy != BrowserDefaults.screen { return .elsewhere }
        return tab.owner.isAgent ? .agent : .yours
    }

    /// Whose the tab is now: `You`, the agent's label, `You · Taken Over from Codex`.
    public static func who(_ tab: BrowserTab) -> String {
        switch state(tab) {
        case .steppedIn: BrowserTabText.heldHere(tab)
        default: BrowserTabText.group(tab.owner)
        }
    }

    /// What goes on in it, beside whose it is: the agent's last step or what it waits for; where it is held.
    public static func doing(_ tab: BrowserTab) -> String? {
        switch state(tab) {
        case .elsewhere: return holder(tab.heldBy ?? "", sized: true)
        case .agent:
            if let waiting = BrowserTabText.waiting(tab) { return waiting }
            let said = tab.action.map { $0.description.isEmpty ? $0.tool : $0.description } ?? ""
            return said.isEmpty ? nil : said
        default: return nil
        }
    }

    /// The buttons, in order; `primary` is the one drawn as the main one.
    public static func buttons(_ tab: BrowserTab) -> [Action] {
        switch state(tab) {
        case .yours: BrowserFillText.offered(on: tab) ? [.show, .fill, .copy, .close] : [.show, .copy, .close]
        case .agent: [.show, .copy, .close]
        case .steppedIn: [.handBack, .show, .copy]
        case .elsewhere: [.show, .copy]
        }
    }

    public static func primary(_ tab: BrowserTab) -> Action {
        state(tab) == .steppedIn ? .handBack : .show
    }

    public static func word(_ action: Action) -> String {
        switch action {
        case .show: "Show Window"
        case .fill: "Fill Ciphertext"
        case .handBack: "Hand Back"
        case .copy: "Copy URL"
        case .close: "Close Tab"
        }
    }

    /// The sentence under the buttons.
    public static func hint(_ tab: BrowserTab) -> String {
        switch state(tab) {
        case .yours: BrowserFillText.offered(on: tab) ? "Fill Ciphertext 填入该窗口中当前的焦点输入框，仅限密码与验证码输入框。" : ""
        case .agent: "在它的窗口里操作即视为接手。接手期间输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签中输入。"
        case .steppedIn: "2 分钟无操作将自动交还。agent 排队等待的操作在交还后继续。"
        case .elsewhere: (tab.heldBy ?? "").hasPrefix("phone") ? "正在 iPhone 上使用。手机交还后窗口恢复原来的大小。" : "正在其他设备上使用。交还后窗口恢复原来的大小。"
        }
    }

    /// The word at the end of the tab's row for who holds it: `You` once you stepped in, `On iPhone`; nil for nobody.
    public static func tag(_ tab: BrowserTab) -> String? {
        switch state(tab) {
        case .steppedIn: "You"
        case .elsewhere: holder(tab.heldBy ?? "", sized: false)
        default: nil
        }
    }

    private static func holder(_ id: String, sized: Bool) -> String {
        id.hasPrefix("phone") ? (sized ? "On iPhone · Phone Size" : "On iPhone") : "On Another Device"
    }
}

/// Where the browser engine's files are on this Mac (the daemon's `src/browser/engine/store.ts`).
public enum BrowserEngineLocation {
    /// Camoufox's app as installed: the running one is brought before other apps by this path.
    public static func camoufoxApp(agentswitchHome: URL) -> URL {
        agentswitchHome.appendingPathComponent("browser/engine/camoufox/current/Camoufox.app")
    }
}

/// The browser's app comes to the front of the Mac by itself when the service starts it (docs/browser-v0.md §7.3 窗口).
/// Unless the person asked for its window here a moment ago, the app that was in front gets its place back.
public enum BrowserFrontPolicy {
    /// A browser seen for the first time less than this ago came forward because it was just started (it takes about
    /// ten seconds to show its first window, longer with tabs to bring back).
    public static let startWindow: TimeInterval = 30
    /// A mouse button pressed less than this before the browser came forward: the person clicked it forward.
    public static let clickWindow: TimeInterval = 0.6
    /// After `Show Window`, or a tab opened on the Browser page, the browser coming forward is what was asked for.
    public static let askedWindow: TimeInterval = 8
    /// A person who brings the browser forward again right after it was sent back means it: no more than this many
    /// times for one start.
    public static let attempts = 2

    public static func givesBack(sinceStarted: TimeInterval?, sinceAsked: TimeInterval?, sinceClick: TimeInterval? = nil, hasPrevious: Bool, done: Int) -> Bool {
        guard hasPrevious, done < attempts, let sinceStarted, sinceStarted < startWindow else { return false }
        if let sinceAsked, sinceAsked < askedWindow { return false }
        if let sinceClick, sinceClick < clickWindow { return false }
        return true
    }
}
