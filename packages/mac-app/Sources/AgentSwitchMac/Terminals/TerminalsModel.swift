import AgentSwitchMacCore
import AppKit
import SwiftUI

/// A row of the list as something to open: a terminal, or an earlier session to go on with.
enum TerminalRowItem: Equatable {
    case terminal(String)
    case session(SessionSummary)
}

/// A question the page asks before it acts (closing a running terminal, deleting a session's record, a session open
/// elsewhere, a session whose folder is gone): a sentence, and the action as a word. `check`: a box to tick; `folder`:
/// a folder line with what the Mac offers.
struct TerminalSheet: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let body: String
    let confirm: String
    var destructive = false
    var check: String?
    var offers: [String]?

    struct Answer {
        let ok: Bool
        let checked: Bool
        let folder: String
    }
}

/// The Terminals page, natively (docs/terminal-v0.md §1 Mac, 2026-10-05; user: terminal全都改成原生): everything the
/// daemon's terminal page did in a web view. The terminals, the earlier sessions and the folders' git come from the
/// service every few seconds while the page is seen; the area is laid out in panes (TerminalPanes), each with a native
/// screen (TerminalPaneState); the list is the directory tree (TerminalTree → TerminalListRows). What it remembers — the
/// panes, the list's width, the folders folded, what was picked for a new terminal — is kept in the app's defaults.
@MainActor
@Observable
final class TerminalsModel {
    @ObservationIgnored let client: () -> DaemonClient
    @ObservationIgnored let defaults: UserDefaults?

    // MARK: what the service says
    private(set) var terminals: [TerminalInfo] = []
    private(set) var sessions: [SessionSummary] = []
    /// The version of the list `sessions` came from, to ask with next time.
    @ObservationIgnored private var sessionsVersion: String?
    private(set) var gits: [String: FolderGit] = [:]
    private(set) var agents: [String] = []
    private(set) var models: [String: [TerminalModelOption]] = [:]
    private(set) var modelDefaults: [String: String] = [:]
    /// The first list has come: from now on a terminal that goes takes its pane with it.
    private(set) var settled = false
    /// A count a terminal, raised each time it starts waiting for you or ends with an error: its row flashes once.
    private(set) var flashes: [String: Int] = [:]

    // MARK: the panes
    var layout = TerminalPanes.single()
    var focusPane = 1
    var zoomed = false
    private(set) var panes: [Int: TerminalPaneState] = [:]
    /// The panes' area as it was laid out last: whether a pane has room to be split, which pane is next door.
    @ObservationIgnored var area = CGSize(width: 900, height: 600)
    /// A line between panes is being dragged: each pane says its grid.
    var sizing = false

    // MARK: the list
    var sideClosed: Bool { didSet { defaults?.set(sideClosed, forKey: Keys.sideClosed) } }
    var sideWidth: CGFloat { didSet { defaults?.set(Double(sideWidth), forKey: Keys.sideWidth) } }
    var collapsed: Set<String> { didSet { defaults?.set(collapsed.sorted(), forKey: Keys.collapsed) } }
    /// Folders showing all their sessions (`More` asked for).
    var expanded: Set<String> = []
    var query = "" { didSet { if query != oldValue { searchChanged() } } }
    /// The sessions whose words matched (`harness:id` → the words around the match), for the query `saidFor`.
    private(set) var said: [String: String] = [:]
    private(set) var saidFor = ""
    /// The terminal whose name is being changed, and what the field holds.
    var renaming: String?
    var renameText = ""
    /// The session being continued (its row is dimmed until it is open).
    var opening: String?
    var searchFocus = 0
    var renameFocus = 0

    // MARK: a new terminal
    var creating = false
    var pickedAgent: String { didSet { defaults?.set(pickedAgent, forKey: Keys.agent) } }
    var pickedModels: [String: String] { didSet { defaults?.set(pickedModels, forKey: Keys.models) } }
    var pickedMode: String { didSet { defaults?.set(pickedMode, forKey: Keys.mode) } }
    var folderText = ""
    var createError = ""
    var starting = false
    var folderFocus = 0

    // MARK: windows, questions, notices
    /// The terminals out in windows of their own: not shown here too.
    private(set) var detached: Set<String> = []
    var sheet: TerminalSheet?
    var sheetChecked = false
    var sheetFolder = ""
    @ObservationIgnored var sheetDone: CheckedContinuation<TerminalSheet.Answer, Never>?
    private(set) var notice: String?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    /// A row on its way to a pane, and where it would land.
    var dragging: TerminalRowItem?
    var dropTarget: (pane: Int, drop: TerminalPanes.Drop)?

    // MARK: the window's side
    @ObservationIgnored var onDetach: (String) -> Void = { _ in }
    @ObservationIgnored var onAttach: (String) -> Void = { _ in }
    @ObservationIgnored var onRaise: (String) -> Void = { _ in }
    /// The keyboard to a pane's screen (nil: off whatever field has it).
    @ObservationIgnored var onFocusScreen: (Int) -> Void = { _ in }
    @ObservationIgnored var onGround: (NSColor) -> Void = { _ in }
    /// The window's page is being drawn in (each screen's own refresh gives way to it).
    @ObservationIgnored var pageRefreshing: () -> Bool = { false }
    /// The terminal's own ground (its theme's), the page's with it.
    var ground = NSColor.black
    /// A key the screen hands over (⌘T, ⌘W, ⌘1–9 …), as the page's key.
    @ObservationIgnored var onScreenKey: (_ key: String, _ shift: Bool, _ alt: Bool) -> Void = { _, _, _ in }
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var active = false
    /// A terminal to show once the first list has come (the Live Activity's card, the menu).
    @ObservationIgnored private var wanted: String?

    enum Keys {
        static let last = "terminals.last", panes = "terminals.panes", focus = "terminals.focus", collapsed = "terminals.collapsed"
        static let sideWidth = "terminals.sideWidth", sideClosed = "terminals.sideClosed"
        static let agent = "terminals.agent", models = "terminals.models", mode = "terminals.mode", folder = "terminals.folder"
    }

    enum Side {
        static let width: CGFloat = 290, min: CGFloat = 220, max: CGFloat = 560, closeBelow: CGFloat = 120
        /// What the panes keep beside the list.
        static let room: CGFloat = 420
    }

    static let pollEvery: Duration = .seconds(3)
    static let noticeFor: Duration = .seconds(6)

    init(client: @escaping () -> DaemonClient, defaults: UserDefaults? = .standard) {
        self.client = client
        self.defaults = defaults
        sideClosed = defaults?.bool(forKey: Keys.sideClosed) ?? false
        let width = defaults?.double(forKey: Keys.sideWidth) ?? 0
        sideWidth = width >= Double(Side.min) ? CGFloat(width) : Side.width
        collapsed = Set(defaults?.stringArray(forKey: Keys.collapsed) ?? [])
        pickedAgent = defaults?.string(forKey: Keys.agent) ?? "claude-code"
        pickedModels = defaults?.dictionary(forKey: Keys.models) as? [String: String] ?? [:]
        pickedMode = defaults?.string(forKey: Keys.mode) ?? ""
        folderText = defaults?.string(forKey: Keys.folder) ?? ""
        if let root = TerminalPanes.restore(defaults?.data(forKey: Keys.panes)) {
            layout = root
            let focus = defaults?.integer(forKey: Keys.focus) ?? 0
            focusPane = TerminalPanes.pane(root, focus) != nil ? focus : TerminalPanes.panes(of: root)[0].id
        }
    }

    // MARK: what is on screen

    var paneList: [TerminalPane] { TerminalPanes.panes(of: layout) }
    var many: Bool { paneList.count > 1 }

    func terminal(_ id: String?) -> TerminalInfo? {
        guard let id else { return nil }
        return terminals.first { $0.id == id }
    }

    /// The terminal of the pane in focus; none while one is being made there.
    var current: TerminalInfo? { creating ? nil : terminal(TerminalPanes.pane(layout, focusPane)?.term) }
    /// The pane in focus's screen and terminal model.
    var focused: TerminalPaneState? { panes[focusPane] }
    var order: [String] { TerminalListRows.order(terminals) }
    func here(_ id: String) -> Bool { !detached.contains(id) }

    var tree: [TerminalTree.Folder] { TerminalTree.build(terminals: terminals, sessions: sessions, git: gits) }

    /// The list's rows: the tree, or what a search left of it.
    var rows: [TerminalListRow] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            return TerminalListRows.build(tree, git: gits, collapsed: collapsed, expanded: expanded, current: current?.id, order: order)
        }
        let words = saidFor == q.lowercased() ? said : [:]
        return TerminalListRows.found(TerminalSearch.run(tree, query: q, said: words), query: q, order: order)
    }

    /// The panes placed in `size`: all of them, or the one in focus alone while it is zoomed.
    func placed(in size: CGSize) -> (panes: [TerminalPanes.Placed], lines: [TerminalPanes.Line]) {
        let box = CGRect(origin: .zero, size: size)
        if zoomed, many, let pane = TerminalPanes.pane(layout, focusPane) {
            return ([TerminalPanes.Placed(id: pane.id, term: pane.term, rect: box)], [])
        }
        return TerminalPanes.place(layout, in: box)
    }

    // MARK: following the service

    /// The page is seen (shown in a window on screen) or not: out of sight nothing is asked for; it is read again as it
    /// comes back.
    func setActive(_ on: Bool) {
        guard on != active else { return }
        active = on
        polling?.cancel()
        polling = nil
        guard on else { return }
        polling = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                await self?.refresh()
                // The earlier sessions every twenty seconds or so, the folders' git every six.
                if tick % 7 == 0 { await self?.refreshSessions() }
                if tick % 2 == 0 { await self?.refreshGit() }
                tick += 1
                try? await Task.sleep(for: Self.pollEvery)
            }
        }
    }

    func stop() {
        setActive(false)
        searchTask?.cancel()
        noticeTask?.cancel()
        answerSheet(ok: false)
        for pane in panes.values { pane.stop() }
        panes = [:]
    }

    func refresh() async {
        guard let list = try? await client().terminals() else { return }
        take(list)
    }

    /// The list as the service has it now: the panes follow (a terminal that went takes its pane with it, or leaves it
    /// empty with its session to go on with), then what the page shows.
    func take(_ list: TerminalList) {
        let before = Dictionary(terminals.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
        for terminal in list.terminals {
            guard let was = before[terminal.id], was != terminal.status else { continue }
            if terminal.status == "waiting" || (terminal.status == "exited" && (terminal.exitCode ?? 0) != 0) {
                flashes = flashes.merging([terminal.id: (flashes[terminal.id] ?? 0) + 1]) { _, new in new }
            }
        }
        if terminals != list.terminals { terminals = list.terminals }
        if agents != list.agents { agents = list.agents }
        if models != list.models { models = list.models }
        if modelDefaults != list.defaults { modelDefaults = list.defaults }
        let next = TerminalPanes.settle(layout, terminals, closing: settled)
        if next != layout { setLayout(next) }
        let first = !settled
        settled = true
        if first { begin() }
        syncPanes()
    }

    func refreshSessions() async {
        // Nothing while the list is the one already here (the service says so without sending it).
        guard let listed = try? await client().sessions(unless: sessionsVersion) else { return }
        sessionsVersion = listed.version
        // A record listed twice over is one row.
        var seen: Set<String> = []
        let all = listed.value.filter { seen.insert($0.recordID).inserted }
        if sessions != all { sessions = all }
    }

    func refreshGit() async {
        guard let all = try? await client().folderGit() else { return }
        if gits != all {
            gits = all
            syncPanes()
        }
    }

    /// The first list: the terminal asked for, else what the panes held, else the one shown last, else the first; with
    /// none, the new-terminal panel.
    private func begin() {
        leaveDetached()
        let last = wanted ?? defaults?.string(forKey: Keys.last)
        wanted = nil
        if let last, here(last), terminal(last) != nil { return select(last) }
        if let held = TerminalPanes.pane(layout, focusPane)?.term, terminal(held) != nil { return select(held) }
        if many { return focus(pane: focusPane, force: true) }
        if let first = order.first(where: here) { return select(first) }
        showCreate()
    }

    /// One terminal on screen (the Live Activity's card): the list read again first, it may be new.
    func show(terminal id: String) {
        guard settled else { wanted = id; return }
        Task {
            await refresh()
            if terminal(id) != nil { select(id) }
        }
    }

    // MARK: the panes' screens

    func setLayout(_ next: PaneNode) {
        layout = next
        if TerminalPanes.pane(next, focusPane) == nil { focusPane = TerminalPanes.panes(of: next)[0].id }
        if !many { zoomed = false }
        defaults?.set(TerminalPanes.kept(next), forKey: Keys.panes)
        defaults?.set(focusPane, forKey: Keys.focus)
    }

    /// Each pane's screen on its terminal, the screens of panes that are gone taken away (their streams end, and with
    /// them their hold on the size).
    func syncPanes() {
        let all = paneList
        for pane in all {
            let state = panes[pane.id] ?? makePane(pane.id)
            let shown = terminal(pane.term).flatMap { here($0.id) ? $0 : nil }
            state.show(shown, git: shown.flatMap { gits[$0.workdir] })
        }
        for (id, state) in panes where !all.contains(where: { $0.id == id }) {
            state.stop()
            panes[id] = nil
        }
    }

    private func makePane(_ id: Int) -> TerminalPaneState {
        let state = TerminalPaneState(id: id, client: client)
        state.onClick = { [weak self] in self?.focus(pane: id) }
        state.screen.pageRefreshing = { [weak self] in self?.pageRefreshing() ?? false }
        state.onGround = { [weak self] color in
            guard let self else { return }
            if self.ground != color { self.ground = color }
            self.onGround(color)
        }
        // Deleted elsewhere (the phone, the terminal's own window): the list again, then what the pane shows next.
        state.onGone = { [weak self] in
            Task {
                await self?.refresh()
                self?.afterRemoval()
            }
        }
        state.onShortcut = { [weak self] key, shift, alt in self?.onScreenKey(key, shift, alt) }
        state.onFocusScreen = { [weak self] in self?.onFocusScreen(id) }
        panes[id] = state
        return state
    }

    /// The grid a new terminal starts at: the pane in focus's.
    var gridHere: (cols: Int, rows: Int)? { focused?.grid }

    // MARK: windows of their own

    /// Which terminals are out in windows of their own: their panes are left (closed among several, emptied when
    /// alone), and the one on screen here, if it went, gives way to the next.
    func setDetached(_ ids: Set<String>) {
        guard ids != detached else { return }
        let went = current.map { ids.contains($0.id) } ?? false
        detached = ids
        guard settled else { return }
        leaveDetached()
        if went, !many {
            if let next = order.first(where: here) { select(next) } else { showCreate() }
        } else {
            syncPanes()
        }
    }

    private func leaveDetached() {
        var next = layout
        for pane in TerminalPanes.panes(of: layout) where pane.term.map({ !here($0) }) ?? false { next = TerminalPanes.close(next, pane.id) }
        if next != layout { setLayout(next) }
    }

    // MARK: a sentence at the foot

    func say(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: Self.noticeFor)
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    static func reason(_ error: Error) -> String { (error as? DaemonError)?.reason ?? error.localizedDescription }

    // MARK: the search

    /// The words only the Mac has, once typing pauses; an answer to an older query is dropped.
    private func searchChanged() {
        searchTask?.cancel()
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            said = [:]
            saidFor = ""
            return
        }
        let c = client()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, let hits = try? await c.searchSessions(q), !Task.isCancelled else { return }
            guard let self, self.query.trimmingCharacters(in: .whitespacesAndNewlines) == q else { return }
            self.said = Dictionary(hits.map { ("\($0.harness):\($0.id)", $0.excerpt) }, uniquingKeysWith: { first, _ in first })
            self.saidFor = q.lowercased()
        }
    }

    // MARK: asking

    /// The sheet up until it is answered.
    func ask(_ sheet: TerminalSheet, folder: String = "") async -> TerminalSheet.Answer {
        answerSheet(ok: false)
        sheetChecked = false
        sheetFolder = folder
        self.sheet = sheet
        return await withCheckedContinuation { sheetDone = $0 }
    }

    func answerSheet(ok: Bool) {
        guard let done = sheetDone else { return }
        sheetDone = nil
        sheet = nil
        done.resume(returning: .init(ok: ok, checked: sheetChecked, folder: sheetFolder.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    #if DEBUG
    /// The design preview's: the page from made-up work, without a service.
    func stage(terminals: [TerminalInfo], sessions: [SessionSummary], gits: [String: FolderGit], agents: [String], models: [String: [TerminalModelOption]] = [:]) {
        self.sessions = sessions
        self.gits = gits
        take(TerminalList(terminals: terminals, agents: agents, models: models))
    }
    #endif
}
