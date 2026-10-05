import Foundation

// The Mac's main window (docs/dispatch-v0.md §1): one window `AgentSwitch`, its pages — Dispatch (the phone's home on a
// desk), Terminals (terminal-v0 §1) and Browser (the shared browser, browser-v0 §1) — chosen in the rail on the left,
// under one 32 pt bar that is the page's own, over one status bar across the window (2026-10-03, proposal B,
// `implemented/window-bars.html`; its words are MainStatus.swift). What the window decides without AppKit is here: the
// pages, what each has going on (from `GET /live`, the browser's tab list), the refresh that draws a page in, its
// shortcuts and the trouble word.

public enum MainPage: String, CaseIterable, Sendable {
    case dispatch, terminals, browser

    /// The page's name (the rail's, the menus').
    public var title: String {
        switch self {
        case .dispatch: "Dispatch"
        case .terminals: "Terminals"
        case .browser: "Browser"
        }
    }

    /// The page after this one in the rail (⌃⇥), the last followed by the first.
    public var next: MainPage {
        let all = MainPage.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }

    /// The page before this one (⌃⇧⇥), the first preceded by the last.
    public var previous: MainPage {
        let all = MainPage.allCases
        return all[(all.firstIndex(of: self)! + all.count - 1) % all.count]
    }

    /// The rail's help under the pointer: the page and the key that goes there (⌘1–9 go to a terminal).
    public var railHelp: String {
        switch self {
        case .dispatch: "Dispatch ⌘0"
        case .terminals: "Terminals ⌘1–9"
        case .browser: "Browser ⌘⇧B"
        }
    }

    /// The page has a list beside it (Terminals' terminals, Browser's tabs): the bar's list button acts there, and is
    /// dimmed in place elsewhere.
    public var hasList: Bool { self != .dispatch }

    /// The pages drawn dark whatever the system's look: the terminal window's dark block, the browser's screen, and
    /// since 2026-10-03 Dispatch too (user: 首页白色的，其他地方黑色的太突兀了，这个dispatcher也改成默认黑色的) — a
    /// light page between two dark ones made every page change a flash. The settings window still follows the system.
    public var alwaysDark: Bool { true }

    /// Where the page shown last is kept (UserDefaults).
    public static let storeKey = "mainWindowPage"

    /// The page the window opens on: the one shown last; Dispatch the first time.
    public static func restored(_ stored: String?) -> MainPage {
        stored.flatMap(MainPage.init(rawValue:)) ?? .dispatch
    }
}

/// What a page has going on, from `GET /live`: Dispatch's tasks, Terminals' terminals; the Browser's from its tab list
/// (PageActivity.of(_ list: BrowserTabList)). The page's icon in the rail carries a mark off its corner, the page on
/// screen too — amber while anything waits for you, else the spinner while anything is busy.
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

// MARK: - the rail, put away

/// The rail can be put away (docs/dispatch-v0.md §1 图标栏可以收起, 2026-10-04; user: 左边这个侧栏找找是不是可以作成可以收缩的？
/// 然后收缩之后对应位置留下一个颜色条，如果有动态就变呼吸灯样式). It leaves no column: the page runs to the window's edge, and
/// half a pill stands out of the edge where an icon was (`RailBar`; the user chose it of three drawn after other apps'
/// — Discord's server list: A 贴边半圆条). The pointer on the window's edge brings the rail out over the page, as a hidden
/// Dock comes out, and it goes back when the pointer leaves; a bar clicked goes to its page. The rail is put away and
/// brought back by its edge (dragged, or clicked twice), by its empty part clicked twice, by its menu under a right
/// click, and by ⌥⌘B.
public enum MainRailLayout {
    /// The rail, in points.
    public static let width = 44.0
    /// The strip along the window's edge that takes the pointer and holds the bars, over the page's first points.
    public static let stripWidth = 8.0
    /// A bar: how far it stands out of the edge, and its height for the page on screen and for the others.
    public static let barWidth = 3.0
    public static let longBar = 20.0
    public static let shortBar = 8.0
    /// The pointer rests on the strip this long before the rail comes out, and has left the rail this long before it
    /// goes back (milliseconds).
    public static let comeOutAfter = 120
    public static let goBackAfter = 280
    /// The edge dragged this far puts the rail away or brings it back.
    public static let dragDistance = 12.0

    /// Where it is kept that the rail is put away (UserDefaults).
    public static let hiddenKey = "mainWindowRailHidden"

    /// The rail is shown until it has been put away.
    public static func hidden(_ stored: Bool?) -> Bool { stored ?? false }

    /// The menu's word and the edge's help, with the key.
    public static func help(hidden: Bool) -> String { hidden ? "Show Rail ⌥⌘B" : "Hide Rail ⌥⌘B" }
}

/// A page's bar on the edge of a window whose rail is put away. Three things, each said one way (2026-10-04, user, of
/// bars where the page on screen was white and a page at work the accent's blue: 当前选中颜色和其他的颜色有冲突，换一套配色
/// 逻辑吧; demo `docs/design/concepts/rail-strip.html`):
/// - its colour: amber for what waits for you, wherever it is; else the colour of what is selected for the page on
///   screen (the accent; the signal in the pixel look — what its icon in the rail has); else ink.
/// - its length: long for the page on screen, short for the others.
/// - its motion: it breathes only while something goes on — slowly at work, quicker while it waits for you.
/// A page that is not on screen and has nothing going on has no bar.
public struct RailBar: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case selected, ink, waiting }
    public enum Pace: Equatable, Sendable { case still, slow, quick }

    public let long: Bool
    public let tone: Tone
    public let pace: Pace

    public init(long: Bool, tone: Tone, pace: Pace) {
        self.long = long
        self.tone = tone
        self.pace = pace
    }

    public static func of(current: Bool, activity: PageActivity.Mark) -> RailBar? {
        switch activity {
        case .waiting: RailBar(long: current, tone: .waiting, pace: .quick)
        case .busy: RailBar(long: current, tone: current ? .selected : .ink, pace: .slow)
        case .none: current ? RailBar(long: true, tone: .selected, pace: .still) : nil
        }
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
/// itself has no use for them), ⌘B opens and closes the tab list (as on Terminals, docs/browser-v0.md §1 Mac,
/// 2026-10-03), ⌘⇧T takes the tab over or hands it back (the status bar's `[ Take Over ]` / `[ Hand Back ]`: what is
/// in a bottom bar is to be had elsewhere too, 2026-10-03), and ⌘+ (⌘= too, with shift or without, and the keypad's +)
/// zooms the page in, ⌘− out (the status bar's `−` `100%` `+`, docs/browser-v0.md §1 页面缩放, 2026-10-03; ⌘0 stays
/// Dispatch, so going back to 100 % has no key). ⌥⌘B puts the rail away and brings it back on every page (2026-10-04).
/// Anything else is the page's.
public enum MainShortcut: Equatable, Sendable {
    case page(MainPage)
    case nextPage
    case previousPage
    case terminal(Int)
    case newTask
    case newTerminal
    case back
    case settings
    /// ⌥⌘B: the rail put away or brought back (MainRailLayout).
    case toggleRail
    case browser(BrowserShortcut)

    /// The Browser page's own keys.
    public enum BrowserShortcut: Equatable, Sendable {
        case newTab, address, reload, back, forward, toggleList
        /// `[ Take Over ]` or `[ Hand Back ]`, whichever the status bar shows.
        case hold
        /// The page's zoom a step up or down, as the status bar's `+` and `−`.
        case zoomIn, zoomOut
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
        if press.command, press.option, !press.control, !press.shift, press.key == "b" { return .toggleRail }
        if press.command, press.shift, !press.control, !press.option, press.key == "b" { return .page(.browser) }
        if press.command, press.shift, !press.control, !press.option, press.key == "t" { return page == .browser ? .browser(.hold) : nil }
        // With shift or without: `+` is ⇧= on most layouts and a key of its own on others and on the keypad.
        if page == .browser, press.command, !press.control, !press.option, let zoom = zoom(press.key) { return .browser(zoom) }
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
        case "b": return page == .browser ? .browser(.toggleList) : nil
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

    /// The Browser page's zoom keys by what they write: `=` or `+` in, `-` out (the keypad's write the same).
    private static func zoom(_ key: String) -> BrowserShortcut? {
        switch key {
        case "=", "+": .zoomIn
        case "-": .zoomOut
        default: nil
        }
    }
}

// MARK: - trouble

/// The status bar's word while the service or the credential gateway is down (`■ Gateway Down`, red); none while both
/// are up or starting.
public enum ServiceTrouble {
    public static func word(service: StatusLine, gateway: StatusLine) -> String? {
        if down(service) { return "Service Down" }
        if down(gateway) { return "Gateway Down" }
        return nil
    }

    static func down(_ line: StatusLine) -> Bool { line.level == .off || line.level >= .warning }
}
