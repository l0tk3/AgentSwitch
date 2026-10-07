import AgentSwitchMacCore
import Observation
import SwiftUI

/// The main window's state (docs/dispatch-v0.md §1), shared by the window, its bar and the Dispatch page. Lives as long
/// as the app (the window's content does not: closing the window lets it go), and is in the Dispatch page's environment:
/// `@Environment(MainWindowState.self) private var window`.
///
/// What the Dispatch page tells the window:
/// - `dispatchTitle`: the bar's centre — nil on the conversation; a task or topic page's status mark and title.
/// - `dispatchRouter`, `dispatchTopics`: the status bar's right on Dispatch (`dispatchChanged`).
/// - `showsBack`: `‹` before the title; Esc and ⌘[ go back too. The page pops when `backRequests` changes.
/// - `openTask`: the task whose page is open (nil elsewhere): the Live Activity keeps quiet about it while the window is
///   in use (`watchingTask`).
///
/// What the window asks of the Dispatch page (each a value to watch with `onChange`):
/// - `backRequests`: go back one page (`‹`, Esc, ⌘[, a click on the current `Dispatch`).
/// - `focusRequests`: put the keyboard in the input (⌘N).
/// - `requestedTask`: open this task's page (the Live Activity); the page calls `takeRequestedTask()` when it does. Also
///   read it on appear: the window may have been opened for it.
///
/// What the window says: the page on screen (`dispatchShown`: the page polls and follows only while it is shown and the
/// window visible), whether the window is key, whether text is being typed in it (`editingText`: the boxes leave ⌘↩ /
/// ⌘⌫ to the field), and what Dispatch's tasks and the terminals have going on (`GET /live`).
///
/// What the Browser page says (BrowserPageModel): its tabs' activity for the rail's mark on the globe, and the tab on
/// screen as the bar's title (`browserChanged`).
@MainActor
@Observable
final class MainWindowState {
    // MARK: pages

    /// The page on screen (and the rail's current icon): a change goes in at once, then is drawn in from the top.
    private(set) var page: MainPage
    /// Dispatch is the page on screen.
    var dispatchShown: Bool { page == .dispatch }

    // MARK: the Dispatch page says

    /// The bar's title on Dispatch; nil on the conversation (the window is on its own Mac: no name there).
    var dispatchTitle: BarTitle?
    /// A page to go back from is open: `‹` shows, Esc and ⌘[ act.
    var showsBack = false
    /// The task whose page is open on Dispatch.
    var openTask: String?
    /// The router's model and the open topics, for the status bar.
    private(set) var dispatchRouter: String?
    private(set) var dispatchTopics = 0

    // MARK: the window asks the Dispatch page

    private(set) var backRequests = 0
    private(set) var focusRequests = 0
    private(set) var requestedTask: String?

    // MARK: the window says

    /// The window is the key window of the active app.
    private(set) var windowKey = false
    /// The window is on screen (open, not minimised, not entirely covered).
    private(set) var windowVisible = false
    /// The window's keyboard is in a field that takes text (the input, a question's answer, a sheet's field).
    private(set) var editingText = false
    /// Dispatch's tasks and the terminals, as the Live Activity last heard them.
    private(set) var dispatchActivity = PageActivity.none
    private(set) var terminalsActivity = PageActivity.none
    /// The browser's tabs (agents operating them, agents waiting for you), from the Browser page's poll.
    private(set) var browserActivity = PageActivity.none
    /// The bar's centre on Browser: the tab on screen's mark and title; nil without a tab.
    private(set) var browserTitle: BarTitle?
    /// The task you are looking at: its result needs no telling (the Live Activity).
    var watchingTask: String? { dispatchShown && windowKey && windowVisible ? openTask : nil }

    // MARK: the bar's row

    /// The title bar's height (the bar fills that row) and where the traffic lights start and end.
    var barHeight: CGFloat = 32
    var lightsStart: CGFloat = 20
    var lightsEnd: CGFloat = 70
    /// The window is full screen: macOS hides its traffic lights until the pointer reaches the top, and the bar draws
    /// its own in their place (FullScreenLights).
    var fullScreen = false

    // MARK: the rail

    /// The rail is put away (MainRailLayout): a strip of bars stands in its place.
    private(set) var railHidden: Bool
    /// The put-away rail is out over the page's edge, the pointer on it.
    private(set) var railOut = false
    /// Told when the rail is put away or brought back (the window keeps it).
    @ObservationIgnored var onRailHidden: (Bool) -> Void = { _ in }
    @ObservationIgnored private var pointerOnStrip = false
    @ObservationIgnored private var pointerOnRail = false
    @ObservationIgnored private var railTimer: Task<Void, Never>?

    init(page: MainPage, railHidden: Bool = false) {
        self.page = page
        self.railHidden = railHidden
    }

    func activity(of page: MainPage) -> PageActivity {
        switch page {
        case .dispatch: dispatchActivity
        case .terminals: terminalsActivity
        case .browser: browserActivity
        }
    }

    // MARK: the rail (its edge, its menu, ⌥⌘B; the pointer)

    /// Put away or brought back; brought back it stays, put away it is gone at once (the pointer is where it was).
    func setRail(hidden: Bool) {
        railTimer?.cancel()
        pointerOnStrip = false
        pointerOnRail = false
        if railOut { railOut = false }
        guard hidden != railHidden else { return }
        railHidden = hidden
        onRailHidden(hidden)
    }

    func toggleRail() { setRail(hidden: !railHidden) }

    /// The pointer came onto or left the strip (`strip`) or the rail that is out (`rail`): out once it has rested on
    /// the strip, back once it has left both.
    func railPointer(strip: Bool? = nil, rail: Bool? = nil) {
        if let strip { pointerOnStrip = strip }
        if let rail { pointerOnRail = rail }
        railTimer?.cancel()
        let wanted = railHidden && (pointerOnStrip || pointerOnRail)
        guard wanted != railOut else { return }
        let wait = wanted ? MainRailLayout.comeOutAfter : MainRailLayout.goBackAfter
        railTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(wait))
            guard !Task.isCancelled, let self, self.railHidden || !wanted else { return }
            self.railOut = wanted
        }
    }

    /// The put-away rail out or back at once (a picture of it).
    func showRail(out: Bool) {
        railTimer?.cancel()
        railOut = out && railHidden
    }

    // MARK: asking the Dispatch page

    func requestBack() { backRequests += 1 }
    func requestFocus() { focusRequests += 1 }
    func request(task id: String) { requestedTask = id }

    /// The Dispatch page opens the requested task: it is no longer asked for.
    @discardableResult
    func takeRequestedTask() -> String? {
        defer { requestedTask = nil }
        return requestedTask
    }

    // MARK: the window (MainWindowController)

    func show(_ page: MainPage) {
        if self.page != page { self.page = page }
    }

    /// The window closed: its Dispatch page is gone, and with it what it put in the bar.
    func windowClosed() {
        showRail(out: false)
        pointerOnStrip = false
        pointerOnRail = false
        dispatchTitle = nil
        showsBack = false
        openTask = nil
        browserTitle = nil
        // A window closed while full screen is not heard leaving it (its observers go as it closes); the next window
        // opens as an ordinary one, with the system's own traffic lights.
        fullScreen = false
        windowChanged(key: false, visible: false)
        editingChanged(false)
    }

    func windowChanged(key: Bool, visible: Bool) {
        if windowKey != key { windowKey = key }
        if windowVisible != visible { windowVisible = visible }
    }

    func editingChanged(_ editing: Bool) {
        if editingText != editing { editingText = editing }
    }

    /// The Dispatch page's router or topics changed.
    func dispatchChanged(router: String?, topics: Int) {
        if dispatchRouter != router { dispatchRouter = router }
        if dispatchTopics != topics { dispatchTopics = topics }
    }

    /// The Browser page's tabs changed (a poll, a stream's event).
    func browserChanged(activity: PageActivity, title: BarTitle?) {
        if activity != browserActivity { browserActivity = activity }
        if title != browserTitle { browserTitle = title }
    }

    func liveChanged(_ snapshot: LiveSnapshot?) {
        let dispatch = PageActivity.of(.dispatch, in: snapshot), terminals = PageActivity.of(.terminals, in: snapshot)
        if dispatch != dispatchActivity { dispatchActivity = dispatch }
        if terminals != terminalsActivity { terminalsActivity = terminals }
    }
}

/// The bar's centre on Dispatch: a status mark and a title (a task's, a topic's).
struct BarTitle: Equatable {
    enum Mark: Equatable {
        /// No mark (a topic page).
        case none
        /// The spinner.
        case busy
        /// The amber square, blinking as everything that waits for you does.
        case waiting
        /// Green.
        case done
        /// Red (incomplete, failed).
        case failed
        /// Hollow (queued, cancelled).
        case off
    }

    var mark: Mark
    var text: String

    init(_ text: String, mark: Mark = .none) {
        self.text = text
        self.mark = mark
    }
}
