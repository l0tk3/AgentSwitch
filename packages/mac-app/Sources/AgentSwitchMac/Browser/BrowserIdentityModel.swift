import AgentSwitchMacCore
import AppKit
import Observation

/// The browser's identity and engine on the Browser page (docs/browser-v0.md §7.2 第 5、6 条; design page
/// `docs/design/implemented/browser-window.html`, states identity / update / missing): what the status bar's right end
/// says and what its box changes — the fingerprint (a restart), the proxy (at once; its password sealed by this Mac's
/// gate before anything is sent) and the engine (download, update, cancel).
@MainActor
@Observable
final class BrowserIdentityModel {
    enum Work: Equatable { case fingerprint, proxy, restart, engine }

    private(set) var identity: BrowserIdentity?
    private(set) var engine: BrowserEngine?
    /// The engine the service runs its browser with now (`camoufox`; `chrome` until Camoufox is installed).
    private(set) var engineInUse = "chrome"
    /// The box is open.
    var open = false { didSet { if open != oldValue { openChanged() } } }
    private(set) var working: Work?
    private(set) var checking = false
    private(set) var problem: String?
    /// The proxy's fields as typed.
    var draft = BrowserProxyDraft()

    @ObservationIgnored private let service: () -> (any BrowserIdentityService)?
    @ObservationIgnored private let sealer: BrowserSealer?
    @ObservationIgnored private var followTask: Task<Void, Never>?
    /// How often an update under way is read.
    private static let followInterval: Duration = .seconds(1)

    init(service: @escaping () -> (any BrowserIdentityService)?, sealer: BrowserSealer?) {
        self.service = service
        self.sealer = sealer
    }

    /// Camoufox runs: there is an identity to show and change.
    var hasIdentity: Bool { engineInUse == "camoufox" }
    var statusWord: String { BrowserIdentityText.status(identity, engine: engineInUse) }
    var engineWord: String? { BrowserEngineText.status(engine) }
    var updating: Bool { engine?.update.running == true }
    var canSeal: Bool { sealer != nil }

    /// The tab list said which engine runs; a change (Camoufox just installed) is read again.
    func engineChanged(_ name: String) {
        guard name != engineInUse else { return }
        engineInUse = name
        Task { await refresh() }
    }

    /// One read of both. A service without them (an older one) shows nothing.
    func refresh() async {
        guard let service = service() else { return }
        if let fresh = try? await service.browserEngine(check: false) { take(fresh) }
        guard hasIdentity, let fresh = try? await service.browserIdentity() else { return }
        take(fresh, resetDraft: !open)
    }

    private func take(_ fresh: BrowserIdentity, resetDraft: Bool) {
        if identity != fresh { identity = fresh }
        if resetDraft { draft = BrowserProxyDraft(fresh.proxy) }
    }

    private func take(_ fresh: BrowserEngine) {
        if engine != fresh { engine = fresh }
        if fresh.update.running { follow() }
    }

    private func openChanged() {
        problem = nil
        guard open else { return }
        draft = BrowserProxyDraft(identity?.proxy)
        Task {
            await refresh()
            draft = BrowserProxyDraft(identity?.proxy)
            // Not installed yet: what there is to download, and how large.
            if engine?.camoufox == nil, engine?.available == nil, !updating { await check() }
        }
    }

    // MARK: fingerprint

    func newFingerprint() {
        run(.fingerprint) { [self] service in take(try await service.newFingerprint(), resetDraft: false) }
    }

    /// A JSON file of Camoufox's properties, picked by the person.
    func importFingerprint() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.message = "选择一份指纹（Camoufox 属性的 JSON）"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let data = try? Data(contentsOf: url), data.count <= 256 * 1024 else { problem = "无法读取所选文件，或文件过大。"; return }
        run(.fingerprint) { [self] service in take(try await service.importFingerprint(json: data), resetDraft: false) }
    }

    /// The browser again, so the exit's time zone is in force.
    func restartBrowser() {
        run(.restart) { [self] service in take(try await service.restartBrowser(), resetDraft: false) }
    }

    // MARK: proxy

    /// `Apply`: a typed password is sealed by this Mac's gate for the proxy's own host, and the ciphertext sent.
    func applyProxy() {
        guard draft.canApply, let site = BrowserIdentityText.proxySite(draft.server) else { return }
        let draft = draft, current = identity?.proxy, sealer = sealer
        run(.proxy) { [self] service in
            var ciphertext: String?
            if !draft.password.isEmpty {
                guard let sealer else { throw CommandError("此 Mac 的凭据网关不可用，无法保存代理密码。") }
                ciphertext = try await sealer(GateSealRequest(label: BrowserIdentityText.proxyLabel, sites: site, value: draft.password))
            }
            take(try await service.setProxy(draft.request(ciphertext: ciphertext, current: current)), resetDraft: true)
        }
    }

    /// `Direct`: no proxy from now on.
    func direct() {
        run(.proxy) { [self] service in take(try await service.setProxy(nil), resetDraft: true) }
    }

    // MARK: engine

    /// Asks what could be installed.
    func check() async {
        guard let service = service(), !checking else { return }
        checking = true
        defer { checking = false }
        do { take(try await service.browserEngine(check: true)) } catch { problem = BrowserPageModel.describe(error) }
    }

    /// `Download` / `Update`: the newest build for the Firefox in use.
    func updateEngine() {
        run(.engine) { [self] service in
            try await service.updateEngine(camoufox: "latest")
            take(try await service.browserEngine(check: false))
        }
    }

    func cancelUpdate() {
        run(.engine) { [self] service in
            try await service.cancelEngineUpdate()
            take(try await service.browserEngine(check: false))
        }
    }

    /// Reads an update under way until it is over, then what the browser now is.
    private func follow() {
        guard followTask == nil else { return }
        followTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.followInterval)
                guard let self, let service = self.service() else { break }
                guard let fresh = try? await service.browserEngine(check: false) else { continue }
                if self.engine != fresh { self.engine = fresh }
                if !fresh.update.running { break }
            }
            self?.followTask = nil
            await self?.refresh()
        }
    }

    private func run(_ work: Work, _ body: @escaping @MainActor (any BrowserIdentityService) async throws -> Void) {
        guard working == nil, let service = service() else { return }
        working = work
        problem = nil
        Task {
            defer { working = nil }
            do { try await body(service) } catch { problem = BrowserPageModel.describe(error) }
        }
    }

    /// The design preview: what the box shows, without a service.
    func preview(identity: BrowserIdentity?, engine: BrowserEngine?, inUse: String, open: Bool) {
        self.identity = identity
        self.engine = engine
        engineInUse = inUse
        draft = BrowserProxyDraft(identity?.proxy)
        self.open = open
    }
}
