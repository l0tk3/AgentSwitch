import AgentSwitchKit
import Foundation
import Observation

/// The Browser tab's data (docs/browser-v0.md §1): the Mac's tabs by owner (read from every tab: the badge counts the
/// agents waiting for you; more often while the Browser tab is on screen — there is no list stream yet), the servers
/// listening on the Mac, the addresses typed on this phone and the page zoom it remembers by site. One tab's page
/// follows its own stream.
@MainActor
@Observable
final class BrowserStore {
    private(set) var list: BrowserTabList?
    private(set) var servers: [BrowserLocalServer] = []
    /// The Mac has no browser: an AgentSwitch that predates it, or one with the browser switched off (404).
    private(set) var unsupported = false
    /// The last read failed (the kept list is shown); cleared by the next good one.
    var error: String?
    /// This Mac cannot fill ciphertexts into a page yet (its fill route answered 404): the key is not offered.
    var fillUnavailable = false
    /// Addresses typed on this phone, newest first.
    private(set) var recent: [String] = UserDefaults.standard.stringArray(forKey: BrowserStore.recentKey) ?? []
    /// The page zoom this phone remembers, a site at a time (browser-v0 §1 页面缩放, 2026-10-03; user: 然后我发现
    /// agentswitch的浏览器页没有放大缩小的选项，加上 用来调节大小): the phone's own — the Mac keeps another.
    private(set) var zoomMemory: BrowserZoomMemory = BrowserStore.keptZoom()
    /// Bumped by `reset` (another Mac): a read that started before it is dropped.
    @ObservationIgnored private var generation = 0
    /// The link's speed last measured, and over which address (browser-v0 §1 iPhone, 2026-10-03): used again on the
    /// same address for a minute; another address is measured afresh.
    @ObservationIgnored private var measured: (endpoint: APIEndpoint, mbps: Double?, at: Date)?
    /// A measure under way: a page opened meanwhile waits for it rather than measuring alongside.
    @ObservationIgnored private var measuring: (endpoint: APIEndpoint, task: Task<Double?, Never>)?

    static let recentKey = "browser.recent"
    static let zoomKey = "browser.zoom"
    /// The list while the Browser tab is on screen, and from the other tabs (the badge).
    static let pollInterval: Duration = .seconds(2)
    static let backgroundInterval: Duration = .seconds(8)
    /// A Mac without the browser is asked again now and then (it may be updated meanwhile).
    static let unsupportedInterval: Duration = .seconds(60)

    var tabs: [BrowserTabInfo] { list?.tabs ?? [] }
    var waiting: Int { list?.waiting ?? 0 }

    func refreshList(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        let asked = generation
        do {
            let fresh = try await api.browserTabs()
            guard asked == generation else { return }
            if fresh != list { list = fresh }
            unsupported = false
            error = nil
        } catch APIError.http(status: 404, message: _) {
            guard asked == generation else { return }
            unsupported = true
            list = nil
        } catch {
            if asked == generation { self.error = error.localizedDescription }
        }
    }

    /// The Mac's local servers; a failed read keeps the last.
    func refreshServers(_ api: AgentSwitchAPI?) async {
        guard let api, !unsupported else { return }
        let asked = generation
        if let fresh = try? await api.browserServers(), asked == generation, fresh != servers { servers = fresh }
    }

    /// The speed measured over `endpoint` in the last minute, if any (megabits a second; a measure that told nothing is
    /// nil inside).
    func knownSpeed(on endpoint: APIEndpoint?) -> Double?? {
        guard let measured, measured.endpoint == endpoint, Date().timeIntervalSince(measured.at) < BrowserSpeed.fresh else { return nil }
        return .some(measured.mbps)
    }

    /// The link's speed over `endpoint` for a tab's picture: the measure from the last minute on that address, else a
    /// new one (`GET /browser/speed`, at most `BrowserSpeed.limit`). Nil when not known: an address not measured (the
    /// local network), an older Mac, too little came.
    func speed(_ api: AgentSwitchAPI?, on endpoint: APIEndpoint?) async -> Double? {
        if let known = knownSpeed(on: endpoint) { return known }
        guard let api, let endpoint, BrowserStreamPolicy.measures(endpoint.kind) else { return nil }
        if let measuring, measuring.endpoint == endpoint { return await measuring.task.value }
        let asked = generation
        let task = Task { await api.browserSpeed() }
        measuring = (endpoint, task)
        let mbps = await task.value
        if measuring?.endpoint == endpoint { measuring = nil }
        if asked == generation { measured = (endpoint, mbps, Date()) }
        return mbps
    }

    /// Another Mac (or none): nothing of this one's stays (the typed addresses and the page zoom do: they are this
    /// phone's).
    func reset() {
        generation += 1
        measured = nil
        measuring = nil
        list = nil
        servers = []
        unsupported = false
        error = nil
        fillUnavailable = false
    }

    /// A tab just opened here: listed at once, before the next read.
    func add(_ tab: BrowserTabInfo) {
        list = (list ?? BrowserTabList(running: true, groups: [])).adding(tab)
    }

    func remove(_ id: String) {
        list = list?.removing(id)
    }

    func remember(_ typed: String) {
        recent = BrowserAddress.remember(typed, in: recent)
        UserDefaults.standard.set(recent, forKey: Self.recentKey)
    }

    /// A site's pages at `percent` on this phone from now on (100% forgets the site; a blank tab is not kept), across
    /// launches. Throws when it cannot be written down: it then holds until the app is closed.
    func rememberZoom(_ percent: Int, for site: String) throws {
        let next = zoomMemory.setting(percent, for: site)
        guard next != zoomMemory else { return }
        zoomMemory = next
        UserDefaults.standard.set(try JSONEncoder().encode(next), forKey: Self.zoomKey)
    }

    /// What was kept under `zoomKey`; nothing there, or something this version cannot read, is nothing remembered
    /// (the next zoom writes it afresh).
    private static func keptZoom() -> BrowserZoomMemory {
        guard let data = UserDefaults.standard.data(forKey: zoomKey) else { return BrowserZoomMemory() }
        return (try? JSONDecoder().decode(BrowserZoomMemory.self, from: data)) ?? BrowserZoomMemory()
    }

    /// The server listening on a port, for a local tab's line.
    func server(port: Int) -> BrowserLocalServer? { servers.first { $0.port == port } }

    #if DEBUG
    func setDemo(_ list: BrowserTabList, servers: [BrowserLocalServer], recent: [String], zoom: BrowserZoomMemory) {
        self.list = list
        self.servers = servers
        self.recent = recent
        zoomMemory = zoom
    }
    #endif
}
