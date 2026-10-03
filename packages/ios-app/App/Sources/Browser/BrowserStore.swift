import AgentSwitchKit
import Foundation
import Observation

/// The Browser tab's data (docs/browser-v0.md §1): the Mac's tabs by owner (read from every tab: the badge counts the
/// agents waiting for you; more often while the Browser tab is on screen — there is no list stream yet), the servers
/// listening on the Mac, and the addresses typed on this phone. One tab's page follows its own stream.
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
    /// Bumped by `reset` (another Mac): a read that started before it is dropped.
    @ObservationIgnored private var generation = 0

    static let recentKey = "browser.recent"
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

    /// Another Mac (or none): nothing of this one's stays (the typed addresses do: they are this phone's).
    func reset() {
        generation += 1
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

    /// The server listening on a port, for a local tab's line.
    func server(port: Int) -> BrowserLocalServer? { servers.first { $0.port == port } }

    #if DEBUG
    func setDemo(_ list: BrowserTabList, servers: [BrowserLocalServer], recent: [String]) {
        self.list = list
        self.servers = servers
        self.recent = recent
    }
    #endif
}
