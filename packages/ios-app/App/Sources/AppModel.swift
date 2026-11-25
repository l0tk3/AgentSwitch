import AgentSwitchKit
import SwiftUI
import UIKit

/// The entries (docs/terminal-v0.md §1, browser-v0 §1): terminals, the dispatch desk (a Chat Room), the rooms, the
/// browser on the Mac, and the settings.
enum MainTab: Hashable {
    case terminals, dispatch, rooms, browser, settings
}

/// The one sheet shown over the tabs at a time.
enum HomeSheet: String, Identifiable {
    case addMac
    var id: String { rawValue }
}

/// App-wide state: the paired Macs and the current one, the live connection, the terminals, rooms and browser. Views read it from the
/// environment; everything network-bound goes through `api`, which is pinned to the paired certificate.
@MainActor
@Observable
final class AppModel {
    /// Every paired Mac; the app talks to the current one only (app-v0 §5 多台 Mac).
    private(set) var macs = PairedMacs()
    var profile: ServerProfile? { macs.current }
    private(set) var connection: ConnectionState = .idle
    /// How the attempts went since the last connection: the tiers of the connection line (control-v0 §5).
    private(set) var connectionProgress = ConnectionProgress()
    private(set) var api: AgentSwitchAPI?
    /// `api` for the Browser tab: its browser routes are those of the browser the tab shows (docs/profiles-v0.md §5.4).
    var browserAPI: AgentSwitchAPI? { browser.scoped(api) }
    private(set) var me: Me?
    /// How each address fared in the last route choice (settings › Mac), for "why can't it connect".
    private(set) var routeReport: (at: Date, reports: [ProbeReport])?
    let speaker = Speaker()
    let feedback = Feedback()
    let live = LiveActivities()
    /// Syncs one after another: two at once could each start an activity.
    @ObservationIgnored private var liveSync: Task<Void, Never>?
    private var terminalCues = TerminalCueTracker()
    private var terminalDone = TerminalDoneTracker()
    /// The phone's own notifications (Live/Notifier.swift).
    let notifier = Notifier()
    /// The terminal whose page is on screen: nothing is notified of it while the app is in front.
    var viewedTerminal: String? { didSet { if let viewedTerminal { notifier.clear(terminal: viewedTerminal) } } }
    /// The app is in front (the scene is active).
    var inFront = true
    var sheet: HomeSheet?
    /// The app opens on the terminals (2026-10-07, user: 手机默认进入 terminal 页吧): what the phone is used for most.
    var tab: MainTab = .terminals
    /// The terminals tab (its list, the Mac's other sessions, the colours).
    let terminals = TerminalsStore()
    /// A terminal to open on the terminals tab (a demo screen); the tab takes it.
    var openTerminalRequest: String?
    /// The Browser tab (the Mac's tabs, its local servers, the addresses typed here).
    let browser = BrowserStore()
    /// The Files page across its visits (docs/files-v0.md §5).
    let files = FilesStore()
    /// The Files page is up: a sheet from the Terminals page's top bar (docs/chatroom-v0.md §10, 2026-11-22: Files left
    /// the tab bar for Rooms), over whatever tab is shown.
    var filesShown = false
    /// The Rooms tab (docs/chatroom-v0.md): the rooms on the Mac shown.
    let rooms = RoomsStore()
    /// A room to open on the Rooms tab (a demo screen, a terminal's room); the tab takes it.
    var openRoomRequest: String?
    /// Where in that room (a notification of 等你处理): the task, the message, the member's card.
    var openRoomAt: RoomRoute.Open?
    /// Where the Mac's files are read from: the API, or the demo screens' made-up disk.
    var fileSource: (any MacFileSource)? { api ?? demoFiles }
    /// The demo screens' made-up disk (`-uiDemo YES`); nil otherwise.
    var demoFiles: (any MacFileSource)?
    /// A browser tab to open (a demo screen), or "new"; the Browser tab takes it.
    var openBrowserRequest: String?
    /// The page of a link tapped outside the Browser tab, shown over where the link was until `Done` (LinkOpener,
    /// `LinkedPage`); it is one of the Browser tab's tabs too, and stays one.
    var linkedPage: BrowserTabInfo?
    /// A pairing link from a tap or a scan, waiting for the user to confirm.
    var incomingPairingLink: String?
    var banner: String?

    private let store: LocalStore?
    private let vault: any TokenVault
    private var manager: ConnectionManager?
    /// Bumped whenever the current Mac changes: an answer that arrives later from the one before is dropped.
    private var session = 0
    private var watcher: Task<Void, Never>?

    init(store: LocalStore?, vault: any TokenVault) {
        self.store = store
        self.vault = vault
        loadSaved()
        rooms.newAttention = { [weak self] items in self?.tellAttention(items) }
    }

    static func live() -> AppModel {
        let store = try? LocalStore.standard()
        let model = AppModel(store: store, vault: KeychainTokenVault())
        if store == nil { model.banner = "无法打开本地存储，配对信息将无法保存。" }
        return model
    }

    var isPaired: Bool { !macs.isEmpty }

    // MARK: - pairing

    func receivePairingLink(_ text: String) {
        incomingPairingLink = text
    }

    /// Pairs with the Mac in `payload` and makes it the current one: a Mac paired before is renewed in place, a new
    /// one is added. Nothing saved changes unless the pairing succeeded.
    func pair(_ payload: PairingPayload, deviceName: String) async throws {
        let transport = PinnedSessionTransport(fingerprint: payload.fp)
        let outcome = try await PairingService(transport: transport, discovery: BonjourDiscovery()).pair(payload, deviceName: deviceName)
        try vault.save(outcome.token, account: outcome.profile.tokenAccount)
        stopConnection()
        resetSession()
        save(macs.adding(outcome.profile))
        connect(token: outcome.token, transport: transport)
    }

    /// Talk to another paired Mac: what came from the current one goes.
    func switchTo(_ fingerprint: String) {
        guard fingerprint != profile?.fingerprint, macs.server(fingerprint) != nil else { return }
        stopConnection()
        resetSession()
        save(macs.activating(fingerprint))
        connectCurrent()
    }

    /// Removes the current Mac (its token, its details and everything fetched from it) and moves to the next one, or
    /// back to pairing when none is left.
    func forget() {
        guard let old = profile else { return }
        stopConnection()
        resetSession()
        try? vault.delete(account: old.tokenAccount)
        save(macs.removing(old.fingerprint))
        sheet = nil
        connectCurrent()
    }

    /// The Mac no longer knows this phone: scan its QR code again (pairing renews it in place).
    func pairAgain() {
        sheet = .addMac
    }

    /// `body`'s answer, or nil when the current Mac changed while waiting for it (or it failed: `handle` then).
    private func fetch<T>(_ body: (AgentSwitchAPI) async throws -> T, quiet: Bool = false) async -> T? {
        guard let api else { return nil }
        let asked = session
        do {
            let value = try await body(api)
            return asked == session ? value : nil
        } catch {
            if asked == session && !quiet { handle(error) }
            return nil
        }
    }

    private func save(_ next: PairedMacs) {
        macs = next
        do { try store?.saveMacs(next) } catch { banner = error.localizedDescription }
    }

    /// Clears what was fetched from the current Mac, before switching or removing it.
    private func resetSession() {
        session += 1
        connection = .idle
        connectionProgress = ConnectionProgress()
        routeReport = nil
        api = nil
        me = nil
        terminalCues = TerminalCueTracker()
        terminalDone = TerminalDoneTracker()
        terminals.reset()
        browser.reset()
        rooms.reset()
        syncLive()
    }

    // MARK: - connection

    private func loadSaved() {
        do { macs = try store?.loadMacs() ?? PairedMacs() } catch { banner = error.localizedDescription }
        connectCurrent()
    }

    /// Connects to the current Mac with its saved token; without one it is shown as no longer paired.
    private func connectCurrent() {
        guard let current = profile else { return }
        guard let token = try? vault.load(account: current.tokenAccount) else {
            connection = .unauthorized
            return
        }
        connect(token: token, transport: PinnedSessionTransport(fingerprint: current.fingerprint))
    }

    private func connect(token: String, transport: PinnedSessionTransport) {
        guard let profile else { return }
        stopConnection()
        let manager = ConnectionManager(book: profile, token: token, discovery: BonjourDiscovery(),
                                        prober: HTTPEndpointProber(transport: transport))
        self.manager = manager
        api = AgentSwitchAPI(endpoints: manager, transport: transport, token: token)
        watcher = Task { [weak self] in
            await manager.startMonitoring(NetworkPathMonitor())
            for await state in await manager.states() {
                self?.connectionChanged(state)
            }
        }
        Task { await manager.reselect() }
    }

    private func stopConnection() {
        watcher?.cancel()
        watcher = nil
        if let manager { Task { await manager.stop() } }
        manager = nil
    }

    private func connectionChanged(_ state: ConnectionState) {
        let wasConnected = connection.endpoint != nil
        connection = state
        connectionProgress = connectionProgress.after(state)
        if state != .selecting, let manager { Task { self.routeReport = await manager.lastReport } }
        if state.endpoint != nil && !wasConnected {
            Task {
                await refreshAddresses()
                if let who = await fetch({ try await $0.me() }, quiet: true) { me = who }
            }
        }
    }

    /// What the connection line says now (连接中 · 重连中 · 无法连接（第 N 次）· 未找到 Mac · 配对已失效).
    var connectionPhase: ConnectionPhase { connectionProgress.phase(connection) }

    /// Back in the foreground (control-v0 §5): the address in use is checked at once, since it may have gone while the
    /// phone slept (another Wi-Fi, Tailscale off), and a new one chosen if it does not answer. A connection that comes
    /// back reads the Mac's addresses by itself (connectionChanged).
    func resume() {
        guard let manager, connection != .unauthorized else { return }
        let before = connection.endpoint
        Task {
            let state = await manager.verify()
            if let endpoint = state.endpoint, endpoint == before { await refreshAddresses() }
        }
    }

    func reconnect() {
        guard let manager else { return }
        Task { await manager.reselect() }
    }

    // MARK: - data

    /// The Live Activity follows the terminals at work and the ones waiting for you (assistant-v0 §4).
    func syncLive() {
        let state = LiveSummary.state(terminals: terminals.terminals)
        let mac = profile?.name ?? "Mac"
        let live = live
        let previous = liveSync
        liveSync = Task {
            await previous?.value
            await live.sync(state, macName: mac)
        }
    }

    /// A folder on the Files page (a terminal row's `Show in Files`): the sheet comes up at it.
    func showInFiles(_ path: String) {
        sheet = nil
        files.openRequest = path
        filesShown = true
    }

    /// What newly waits in a room (等你处理), told while the app is not in front: one notification each.
    private func tellAttention(_ items: [RoomAttentionItem]) {
        guard !inFront else { return }
        for item in items {
            let at = RoomAttentionPage.where(item)
            notifier.post(room: item.room, id: item.id, title: item.roomName.isEmpty ? "等你处理" : item.roomName,
                          body: "等你处理：" + item.noticeLine, task: at.task, seq: at.seq, card: at.card)
        }
    }

    /// From a notification: the Rooms tab opens the room, at the task, the message or the member's card.
    func openRoom(_ id: String, at: RoomRoute.Open? = nil) {
        sheet = nil
        filesShown = false
        tab = .rooms
        openRoomAt = at
        openRoomRequest = id
    }

    /// From a Live Activity: the terminals tab opens the terminal.
    func openTerminal(_ id: String) {
        sheet = nil
        filesShown = false
        tab = .terminals
        openTerminalRequest = id
    }

    /// The terminals' list, from any tab (terminal-v0 §1): the tab's badge, the Live Activity, and the "needs you" cue
    /// for a terminal that newly waits (read aloud in voice mode). `sessions`:
    /// the Mac's other sessions too (the tab's own refresh).
    func refreshTerminals(sessions: Bool = false) async {
        guard let api else { return }
        let asked = session
        await terminals.refreshList(api)
        if sessions {
            await terminals.refreshSessions(api)
            await terminals.refreshGit(api)
        }
        guard asked == session else { return }
        let fresh = terminalCues.newlyWaiting(terminals.terminals)
        if !fresh.isEmpty {
            feedback.play(.needsYou, speaking: speaker.isSpeaking)
            if feedback.settings.voiceMode { speaker.say(fresh.map(\.spokenWait).joined(separator: "。"), key: "terminals:" + fresh.map(\.id).joined(separator: ",")) }
        }
        // A notification for each that newly waits and each whose turn ended — not for the one on screen in front.
        let seen = inFront ? viewedTerminal : nil
        for terminal in fresh where terminal.id != seen { notifier.post(terminal: terminal.id, title: "\(terminal.noticeName) · Needs You", body: terminal.noticeWait) }
        for terminal in terminalDone.newlyDone(terminals.terminals) where terminal.id != seen {
            notifier.post(terminal: terminal.id, title: "\(terminal.noticeName) · Done", body: "这一轮结束了")
        }
        syncLive()
    }

    /// While connected the Mac is asked for its addresses again this often (app-v0 §5): it may move to another network
    /// while the phone stays connected over Tailscale, and the phone should hold the new address before it next has
    /// to find the Mac without it.
    static let addressRefreshInterval: Duration = .seconds(300)

    /// The Mac's current addresses into the saved profile and the address choice, so a phone paired while Tailscale was
    /// off (or before the Mac's LAN address changed) still finds it elsewhere next time. Asked when a connection is
    /// made, when the app comes back to the front, and every `addressRefreshInterval` while connected.
    func refreshAddresses() async {
        guard let api, let profile, let now = try? await api.addresses(), let updated = profile.updated(with: now),
              updated.fingerprint == self.profile?.fingerprint else { return }
        save(macs.updating(updated))
        await manager?.update(book: updated)
    }

    /// Central error funnel: a 401 anywhere means this phone is no longer paired. A network failure is left to the
    /// connection line (无法连接（第 N 次）…), which says it better and goes away by itself once the Mac is back.
    func handle(_ error: Error) {
        if error is CancellationError { return }
        if let api = error as? APIError, api == .unauthorized {
            connection = .unauthorized
            banner = api.localizedDescription
            return
        }
        if let api = error as? APIError, api.isNetworkFailure { return }
        banner = error.localizedDescription
    }

}

#if DEBUG
extension AppModel {
    /// The sample screens (`-uiDemo YES`): a paired Mac, the demo terminals, rooms and browser, no network. `offline`: the
    /// Mac has not answered for three tries in a row, the last route choice found nothing.
    static func demo(offline: Bool = false) -> AppModel {
        let model = preview()
        // `terminalprofiles`, `newterminalprofile`, `terminalmenuprofile`: Claude Code with more than the Mac's own
        // sign-in (docs/profiles-v0.md §3.3) — a `Profile` row in the new-terminal sheet, `Resume As` in a session's menu.
        let screen = UserDefaults.standard.string(forKey: "uiDemoScreen") ?? ""
        let profiles: [String: ProfileChoices] = screen.contains("profile") ? ["claude-code": ProfileChoices(current: "abc123def0", profiles: [
            ProfileChoice(id: "default", name: "Default", account: "me@example.com"), ProfileChoice(id: "abc123def0", name: "cwork1", account: "work@example.com", color: .violet),
            ProfileChoice(id: "abc123def1", name: "side", color: .sand)])] : [:]
        // `terminalsconnecting`: the first connection still being made, nothing read yet (the Terminals tab's one line).
        if screen != "terminalsconnecting" { model.terminals.setDemo(DemoData.terminalList, sessions: DemoData.sessions, git: DemoData.git, profiles: profiles) }
        model.rooms.show(DemoRooms.list, attention: DemoRooms.attention)
        model.browser.setDemo(DemoBrowser.list, servers: DemoBrowser.servers, recent: DemoBrowser.recent, zoom: DemoBrowser.zoom,
                              browsers: UserDefaults.standard.string(forKey: "uiDemoScreen") == "browserprofiles"
                                ? [.shared, BrowserChoice(key: "claude-code.abc123def0", name: "cwork1", exit: .init(ip: "203.0.113.9", place: "Tokyo"), running: true)] : nil)
        model.routeReport = (Date().addingTimeInterval(-40), DemoData.routeReport)
        model.demoFiles = DemoFiles(scope: screen == "filesscoped" ? DemoFiles.scopeFolder : nil)
        model.connectionProgress = ConnectionProgress().after(model.connection)
        if screen == "terminalsconnecting" {
            model.connection = .selecting
            model.connectionProgress = ConnectionProgress()
        }
        if offline {
            let start = Date().addingTimeInterval(-150)
            model.connection = .unreachable
            model.connectionProgress = (0..<3).reduce(model.connectionProgress) { p, i in p.after(.unreachable, at: start.addingTimeInterval(Double(i) * 30)) }
            model.routeReport = (Date().addingTimeInterval(-20), DemoData.routeReport.map { ProbeReport(endpoint: $0.endpoint, outcome: .unreachable("请求超时。"), seconds: 4) })
        }
        return model
    }
}
#endif

extension AppModel {
    /// Sample state for SwiftUI previews only.
    static func preview() -> AppModel {
        let model = AppModel(store: nil, vault: MemoryTokenVault())
        let payload = PairingPayload(name: "Mac mini", port: 4713, fp: String(repeating: "ab", count: 32), code: "7K3M-9QZX",
                                     lan: ["192.168.1.5"], tailnet: ["100.101.102.103"], bonjour: "AgentSwitch on Mac mini")
        model.macs = PairedMacs(servers: [ServerProfile(payload: payload, deviceId: "dev-preview"),
                                          ServerProfile(name: "MacBook Pro", port: 4713, fingerprint: String(repeating: "cd", count: 32),
                                                        lan: ["192.168.1.8"], tailnet: [], bonjour: "AgentSwitch on MacBook Pro",
                                                        deviceId: "dev-preview-2", pairedAt: Date())])
        model.connection = .connected(APIEndpoint(host: "192.168.1.5", port: 4713, kind: .bonjour))
        return model
    }
}
