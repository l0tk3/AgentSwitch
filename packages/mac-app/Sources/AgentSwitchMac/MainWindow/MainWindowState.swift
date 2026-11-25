import AgentSwitchMacCore
import Observation
import SwiftUI

/// The main window's state (docs/dispatch-v0.md §1), shared by the window, its bars and its pages. Lives as long as
/// the app (the window's content does not: closing the window lets it go).
///
/// What the window says: the page on screen, whether the window is key and visible, whether text is being typed in it
/// (`editingText`), and what the terminals have going on (`GET /live`).
///
/// What the pages say: the Browser page (BrowserPageModel) its tabs' activity for the rail's mark on the globe and the
/// tab on screen as the bar's title (`browserChanged`); the Chat Room page and the Dispatch page (the 调度台 room) what
/// waits for you and their status bar's words (`roomsChanged`, `deskChanged`).
@MainActor
@Observable
final class MainWindowState {
    // MARK: pages

    /// The page on screen (and the rail's current icon): a change goes in at once, then is drawn in from the top.
    private(set) var page: MainPage
    /// Dispatch is the page on screen.
    var dispatchShown: Bool { page == .dispatch }

    // MARK: the window says

    /// The window is the key window of the active app.
    private(set) var windowKey = false
    /// The window is on screen (open, not minimised, not entirely covered).
    private(set) var windowVisible = false
    /// The window's keyboard is in a field that takes text (a page's input, a sheet's field).
    private(set) var editingText = false
    /// Something on the Dispatch page waits for you (`deskChanged`).
    private(set) var dispatchActivity = PageActivity.none
    /// The terminals, as the Live Activity last heard them.
    private(set) var terminalsActivity = PageActivity.none
    /// The browser's tabs (agents operating them, agents waiting for you), from the Browser page's poll.
    private(set) var browserActivity = PageActivity.none
    /// The bar's centre on Browser: the tab on screen's mark and title; nil without a tab.
    private(set) var browserTitle: BarTitle?
    // MARK: the Chat Room page says, and is asked (docs/chatroom-v0.md §10)

    /// Rooms with something for the user: the rail's amber mark.
    private(set) var roomsActivity = PageActivity.none
    /// The status bar's words on Chat Room.
    private(set) var roomsStatus: [String] = []
    /// The room on screen, beside the page's name in the bar.
    private(set) var roomsTitle: String?
    /// The members' list is shown (the bar's button; kept).
    var roomsMembers: Bool = UserDefaults.standard.object(forKey: "roomsMembersShown") as? Bool ?? true {
        didSet { UserDefaults.standard.set(roomsMembers, forKey: "roomsMembersShown") }
    }
    /// The bar's `New Room` was pressed: the page opens its sheet when this changes.
    private(set) var newRoomRequests = 0
    func askNewRoom() { newRoomRequests += 1 }

    /// The status bar's right on Dispatch: how it stands.
    private(set) var deskStatus: [String] = []

    /// The Dispatch page (the 调度台 room) was read: how the dispatch stands, and whether something there waits for you.
    func deskChanged(status: [String], waiting: Bool) {
        if status != deskStatus { deskStatus = status }
        let activity = PageActivity(waiting: waiting ? 1 : 0)
        if activity != dispatchActivity { dispatchActivity = activity }
    }

    func roomsChanged(activity: PageActivity, status: [String], title: String?) {
        if activity != roomsActivity { roomsActivity = activity }
        if status != roomsStatus { roomsStatus = status }
        if title != roomsTitle { roomsTitle = title }
    }

    // MARK: the node (docs/mesh-v0.md §5.2)

    /// The node the window's pages are of; nil: this Mac's own service.
    private(set) var node: NodeStatus?
    var nodeId: String? { node?.id }
    /// What the node the window is on says it has (`GET /node`); empty until it has answered, and on this Mac.
    private(set) var nodeHas: Set<String> = []
    /// The pages the rail offers: every one on this Mac; on another node Clash only once that node has said it has it
    /// (Clash Verge is there).
    var pages: [MainPage] { node == nil ? MainPage.allCases : MainPage.allCases.filter { $0 != .clash || nodeHas.contains("clash") } }

    /// The node on screen said what it has.
    func nodeSaid(_ info: NodeInfo) {
        let has = Set(info.has)
        if has != nodeHas { nodeHas = has }
    }

    /// The pages are another node's from now on: what the ones before put in the bars is gone with them.
    func use(node: NodeStatus?) {
        guard node?.id != self.node?.id else { return }
        self.node = node
        nodeHas = []
        browserTitle = nil
        dispatchActivity = .none
        terminalsActivity = .none
        browserActivity = .none
        roomsActivity = .none
        roomsStatus = []
        roomsTitle = nil
    }

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
    /// A page asks for a terminal of this window's node to be shown (the Chat Room page: a member's own terminal).
    @ObservationIgnored var onShowTerminal: (String) -> Void = { _ in }
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
        case .clash: .none
        case .rooms: roomsActivity
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

    // MARK: the window (MainWindowController)

    func show(_ page: MainPage) {
        if self.page != page { self.page = page }
    }

    /// The window closed: its pages are gone, and with them what they put in the bar.
    func windowClosed() {
        showRail(out: false)
        pointerOnStrip = false
        pointerOnRail = false
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

    /// The Browser page's tabs changed (a poll, a stream's event).
    func browserChanged(activity: PageActivity, title: BarTitle?) {
        if activity != browserActivity { browserActivity = activity }
        if title != browserTitle { browserTitle = title }
    }

    func liveChanged(_ snapshot: LiveSnapshot?) {
        let terminals = PageActivity.terminals(in: snapshot)
        if terminals != terminalsActivity { terminalsActivity = terminals }
    }
}

/// The bar's centre: a status mark and a title (the Browser's tab on screen, a page's name).
struct BarTitle: Equatable {
    enum Mark: Equatable {
        /// No mark.
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
