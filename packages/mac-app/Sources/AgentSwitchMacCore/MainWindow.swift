import Foundation

// The Mac's main window (docs/dispatch-v0.md §1): one window `AgentSwitch`, its pages — Dispatch (the phone's home on a
// desk), Terminals (terminal-v0 §1) and Browser (the shared browser, browser-v0 §1) — under one 32 pt bar. What the
// window decides without AppKit is here: the pages, what each has going on (from `GET /live`, the browser's tab list),
// the refresh that draws a page in, its shortcuts and the bar's trouble word.

public enum MainPage: String, CaseIterable, Sendable {
    case dispatch, terminals, browser

    /// The page's word in the bar's page switch.
    public var title: String {
        switch self {
        case .dispatch: "Dispatch"
        case .terminals: "Terminals"
        case .browser: "Browser"
        }
    }

    /// The page after this one in the bar (⌃⇥), the last followed by the first.
    public var next: MainPage {
        let all = MainPage.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }

    /// The page before this one (⌃⇧⇥), the first preceded by the last.
    public var previous: MainPage {
        let all = MainPage.allCases
        return all[(all.firstIndex(of: self)! + all.count - 1) % all.count]
    }

    /// The pages drawn dark whatever the system's look: the terminal window's dark block and the browser's screen.
    public var alwaysDark: Bool { self != .dispatch }

    /// Where the page shown last is kept (UserDefaults).
    public static let storeKey = "mainWindowPage"

    /// The page the window opens on: the one shown last; Dispatch the first time.
    public static func restored(_ stored: String?) -> MainPage {
        stored.flatMap(MainPage.init(rawValue:)) ?? .dispatch
    }
}

/// What a page has going on, from `GET /live`: Dispatch's tasks, Terminals' terminals; the Browser's from its tab list
/// (PageActivity.of(_ list: BrowserTabList)). The page's word carries a mark
/// while it is not the page on screen — amber while anything waits for you, else the spinner while anything is busy —
/// and Dispatch's end of the bar counts both (`⠙1 ▪1`).
public struct PageActivity: Equatable, Sendable {
    public enum Mark: Equatable, Sendable { case none, busy, waiting }

    public let busy: Int
    public let waiting: Int

    public init(busy: Int = 0, waiting: Int = 0) {
        self.busy = busy
        self.waiting = waiting
    }

    public static let none = PageActivity()

    public var mark: Mark { waiting > 0 ? .waiting : busy > 0 ? .busy : .none }

    /// The page's rows of the Live Activity's snapshot (nil: the service is not answering). The browser's tabs are not
    /// in it: `.none` for Browser.
    public static func of(_ page: MainPage, in snapshot: LiveSnapshot?) -> PageActivity {
        let kind: LiveSnapshot.Kind
        switch page {
        case .dispatch: kind = .task
        case .terminals: kind = .terminal
        case .browser: return .none
        }
        let rows = snapshot?.rows.filter { $0.kind == kind } ?? []
        let waiting = rows.filter(\.needsYou).count
        return PageActivity(busy: rows.count - waiting, waiting: waiting)
    }
}

// MARK: - the refresh

/// A screen drawn afresh (ui-v0 §7.4; dispatch-v0 §1 "换页即刷新"): what it shows comes in from the top in even steps, a
/// bright scan line at the edge, the ground below it; `steps()`, no easing — a refresh, not a glitch. The main window's
/// page switch is the phone's and the web terminal's 13 steps in 0.26 s over the area under the bar; switching terminals
/// on the Mac's screen is a quicker 9 in 0.18 s.
public struct ScanRefresh: Equatable, Sendable {
    public let steps: Int
    /// Milliseconds a step.
    public let interval: Int

    public init(steps: Int, interval: Int) {
        self.steps = steps
        self.interval = interval
    }

    /// Changing pages in the main window (Dispatch · Terminals · Browser).
    public static let page = ScanRefresh(steps: 13, interval: 20)
    /// The terminal page's screen showing another terminal.
    public static let terminal = ScanRefresh(steps: 9, interval: 20)

    /// The whole refresh, in milliseconds: then nothing of it is left.
    public var duration: Int { steps * interval }

    /// The step on screen `elapsed` milliseconds in; nil once it is over.
    public func step(at elapsed: Int) -> Int? {
        guard elapsed < duration else { return nil }
        return max(0, elapsed) / interval
    }

    /// How much of `height` has come in at `step`, from the top, in whole points: nothing at the first step, all but the
    /// last step's share at the last (then the refresh is over and all of it shows).
    public func edge(at step: Int, height: Double) -> Double {
        (height * Double(min(max(step, 0), steps)) / Double(steps)).rounded()
    }

    /// The scan line's top at `step`: on the edge, kept inside the height.
    public func line(at step: Int, height: Double, thickness: Double = ScanRefresh.lineThickness) -> Double {
        max(0, min(edge(at: step, height: height), height - thickness))
    }

    /// The scan line, in points.
    public static let lineThickness = 2.0
}

// MARK: - shortcuts

/// The window's own keys (dispatch-v0 §1): ⌘0 Dispatch, ⌘⇧B Browser, ⌃⇥ the next page and ⌃⇧⇥ the one before, ⌘N a
/// new task on Dispatch, ⌘, settings; from Dispatch and Browser ⌘1–9 cross to the terminals and from Dispatch ⌘T (on
/// Terminals they are the terminal page's own, as ⌘B is), and Esc or ⌘[ go back while Dispatch has a page to go back
/// from. On Browser ⌘T is a new tab, ⌘L the address, ⌘R reload, ⌘[ ⌘] back and forward (a browser's keys; the page
/// itself has no use for them). Anything else is the page's.
public enum MainShortcut: Equatable, Sendable {
    case page(MainPage)
    case nextPage
    case previousPage
    case terminal(Int)
    case newTask
    case newTerminal
    case back
    case settings
    case browser(BrowserShortcut)

    /// The Browser page's own keys.
    public enum BrowserShortcut: Equatable, Sendable {
        case newTab, address, reload, back, forward
    }

    /// A key as AppKit reports it: the characters without modifiers (lowercased), its key code, the modifiers held.
    public struct Press: Equatable, Sendable {
        public var key: String
        public var keyCode: UInt16
        public var command: Bool
        public var control: Bool
        public var option: Bool
        public var shift: Bool

        public init(key: String, keyCode: UInt16, command: Bool, control: Bool, option: Bool, shift: Bool) {
            self.key = key
            self.keyCode = keyCode
            self.command = command
            self.control = control
            self.option = option
            self.shift = shift
        }
    }

    public static let escape: UInt16 = 53
    public static let tab: UInt16 = 48

    /// `page`: the one the bar shows; `canGoBack`: Dispatch shows `‹`; `composing`: an input method has marked text
    /// (its Esc cancels the composition).
    public static func action(for press: Press, on page: MainPage, canGoBack: Bool, composing: Bool = false) -> MainShortcut? {
        if press.keyCode == tab, press.control, !press.command, !press.option { return press.shift ? .previousPage : .nextPage }
        if press.keyCode == escape, !press.command, !press.control, !press.option, !press.shift {
            return page == .dispatch && canGoBack && !composing ? .back : nil
        }
        if press.command, press.shift, !press.control, !press.option, press.key == "b" { return .page(.browser) }
        guard press.command, !press.control, !press.option, !press.shift else { return nil }
        switch press.key {
        case "0": return .page(.dispatch)
        case "n": return .newTask
        case ",": return .settings
        case "[":
            if page == .browser { return .browser(.back) }
            return page == .dispatch && canGoBack ? .back : nil
        case "]": return page == .browser ? .browser(.forward) : nil
        case "l": return page == .browser ? .browser(.address) : nil
        case "r": return page == .browser ? .browser(.reload) : nil
        case "t":
            switch page {
            case .dispatch: return .newTerminal
            case .browser: return .browser(.newTab)
            case .terminals: return nil
            }
        case "1", "2", "3", "4", "5", "6", "7", "8", "9": return page != .terminals ? Int(press.key).map(MainShortcut.terminal) : nil
        default: return nil
        }
    }
}

// MARK: - trouble

/// The word before Dispatch's counts while the service or the credential gateway is down (`■ Gateway Down`, red); none
/// while both are up or starting.
public enum ServiceTrouble {
    public static func word(service: StatusLine, gateway: StatusLine) -> String? {
        if down(service) { return "Service Down" }
        if down(gateway) { return "Gateway Down" }
        return nil
    }

    static func down(_ line: StatusLine) -> Bool { line.level == .off || line.level >= .warning }
}
