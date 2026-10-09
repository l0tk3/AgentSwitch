import AgentSwitchKit
import SwiftUI

/// Whose proxy a form sets, as a place to go to from 设置.
enum ProxyTarget: Hashable {
    /// The browser everything shares.
    case browser
    /// One of an agent's profiles (never the Mac's own, which has no proxy of its own).
    case profile(agent: String, profile: ProfileChoice)

    var owner: ProxyOwner {
        switch self {
        case .browser: return .browser
        case .profile(let agent, let profile): return .profile(agent: agent, id: profile.id)
        }
    }

    var title: String {
        switch self {
        case .browser: return "Browser"
        case .profile(_, let profile): return profile.name
        }
    }
}

/// What the Mac has of proxies (docs/clash-v0.md §9, docs/profiles-v0.md §4.2, docs/browser-v0.md §7.6): Clash
/// Integration, the shared browser's proxy, and each profile's own. Nil or empty for what an older Mac keeps to
/// itself; with nothing at all the section is not shown.
struct ProxiesOverview: Equatable {
    struct Owned: Hashable, Identifiable {
        let agent: String
        let profile: ProfileChoice
        var id: String { "\(agent).\(profile.id)" }
    }

    var clash: ClashView?
    var browser: BrowserProxyState?
    var profiles: [String: ProfileChoices] = [:]

    /// Every profile that is not the Mac's own, agents in a fixed order.
    var owned: [Owned] {
        profiles.keys.sorted().flatMap { agent in (profiles[agent]?.profiles ?? []).filter { !$0.isDefault }.map { Owned(agent: agent, profile: $0) } }
    }

    var isEmpty: Bool { clash == nil && browser == nil && owned.isEmpty }

    /// Read again; what does not answer keeps what was last read.
    static func load(_ api: AgentSwitchAPI, keeping last: ProxiesOverview) async -> ProxiesOverview {
        async let clash = try? api.clash()
        async let browser = try? api.browserProxy()
        async let profiles = try? api.profiles()
        let (c, b, p) = await (clash, browser, profiles)
        return ProxiesOverview(clash: c ?? last.clash, browser: b ?? last.browser, profiles: p ?? last.profiles)
    }
}

/// 设置 › Proxies: one row for Clash, one for the shared browser, one for each profile — each with where it stands
/// in a word, and behind each the page that changes it.
struct ProxiesSection: View {
    let overview: ProxiesOverview

    var body: some View {
        Section {
            if let clash = overview.clash {
                NavigationLink(value: SettingsRoute.clash) {
                    LabeledContent("Clash") { Text(clash.word).mono(13).foregroundStyle(clash.todo.isEmpty ? Color.secondary : Theme.waiting) }
                }
            }
            if let browser = overview.browser {
                NavigationLink(value: SettingsRoute.proxy(.browser)) {
                    LabeledContent("Browser") { Text(browser.way).mono(13).lineLimit(1) }
                }
            }
            ForEach(overview.owned) { item in
                NavigationLink(value: SettingsRoute.proxy(.profile(agent: item.agent, profile: item.profile))) {
                    HStack(spacing: Theme.Space.s) {
                        if let color = item.profile.color { ProfileDot(color: color) }
                        Text(item.profile.name).lineLimit(1)
                        Spacer(minLength: Theme.Space.s)
                        Text(item.profile.way).mono(13).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        } header: {
            SectionLabel("Proxies")
        } footer: {
            Text("Clash 为 Claude 和 OpenAI 单独选节点；浏览器和每个配置可以各有自己的代理。右边是它现在从哪里出去。")
        }
    }
}

/// A proxy's form (the Mac's `Proxy…` sheet and the Browser page's identity box, in one): where it is, who asks, the
/// password — sealed on this phone before it is sent — and where it lets traffic out.
struct ProxyFormView: View {
    let target: ProxyTarget
    @Environment(AppModel.self) private var model
    @State private var current: ProxySetting?
    @State private var exit: String?
    @State private var problem: String?
    @State private var restartNeeded = false
    /// The shared browser's fingerprint in a line; a profile's form has none.
    @State private var fingerprint: String?
    @State private var draft = ProxyDraft()
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            if let error { Section { ErrorText(message: $error).id(error) } }
            Section {
                LabeledContent("Exit") { Text(exit ?? none).mono(13).textSelection(.enabled) }
                if let fingerprint { LabeledContent("Fingerprint") { Text(fingerprint).mono(13) } }
                if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.waiting) }
                if current != nil, case .profile = target { Button("Check Exit") { run { try await check($0) } }.disabled(busy) }
            } footer: {
                Text((current == nil ? (isBrowser ? "浏览器现在直接从这台 Mac 出去。" : "这个配置现在从这台 Mac 自己的出口出去。") : "")
                     + (fingerprint == nil ? "" : "指纹在 Mac 上更换。"))
            }
            Section {
                LabeledContent("Server") {
                    TextField("Server", text: $draft.server, prompt: Text("http://host:port"))
                        .code(13).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .multilineTextAlignment(.trailing)
                        .onSubmit { draft = draft.split() }
                }
                LabeledContent("User Name") {
                    TextField("User Name", text: $draft.username, prompt: Text("None"))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().multilineTextAlignment(.trailing)
                }
                LabeledContent("Password") {
                    SecureField("Password", text: $draft.password, prompt: Text(current?.sealed == true ? "Kept" : "None")).multilineTextAlignment(.trailing)
                }
                if let said = draft.split().problem { Text(said).font(.footnote).foregroundStyle(Theme.failed) }
                Button(isBrowser ? "Apply" : "Apply & Check") { run { try await apply($0) } }.disabled(busy || !draft.split().canApply)
                Button(isBrowser ? "Direct" : "No Proxy", role: .destructive) { run { try await clear($0) } }.disabled(busy || current == nil)
            } header: {
                SectionLabel("Proxy")
            } footer: {
                Text("可以把整条代理地址（http://用户名:密码@主机:端口）直接粘进 Server，用户名和密码会自己分到下面两栏。"
                     + (isBrowser ? ProxyText.browserHint : ProxyText.profileHint) + ProxyText.passwordHint)
            }
            if restartNeeded {
                Section {
                    Button("Restart Browser") { run { try await restart($0) } }.disabled(busy)
                } footer: {
                    Text(ProxyText.restartHint + "重新启动后已打开的标签按网址恢复。")
                }
            }
        }
        .navigationTitle(target.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if busy { ToolbarItem(placement: .topBarTrailing) { ProgressView() } } }
        .task { await load() }
        .refreshable { await load() }
    }

    private var isBrowser: Bool { target == .browser }
    private var none: String { isBrowser ? "Direct" : "This Mac" }

    private func load() async {
        guard let api = model.api else {
            #if DEBUG
            show(DemoData.proxyState(target), resetDraft: true)
            #endif
            return
        }
        do {
            switch target {
            case .browser: if let state = try await api.browserProxy() { show(state, resetDraft: current == nil) }
            case .profile(let agent, let profile): show(try await api.profiles()[agent]?.profiles.first { $0.id == profile.id }, problem: nil, resetDraft: current == nil)
            }
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }

    /// One call to the Mac; said to be under way meanwhile, and what went wrong is said.
    private func run(_ work: @escaping (AgentSwitchAPI) async throws -> Void) {
        guard !busy, let api = model.api else { return }
        busy = true
        Task {
            do { try await work(api); error = nil } catch APIError.http(status: 404, message: "not found") {
                // The Mac's listener for phones does not know the route: an AgentSwitch from before proxies were a phone's.
                error = "这台 Mac 上的 AgentSwitch 还不能从手机设代理：在 Mac 上更新 AgentSwitch。"
            } catch {
                model.handle(error)
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    private func apply(_ api: AgentSwitchAPI) async throws {
        let typed = draft.split()
        draft = typed
        var ciphertext: String?
        if let payload = try typed.sealing(label: target.owner.sealLabel) {
            // The Mac's key as it is now (it may have changed since pairing); the one kept from pairing otherwise.
            let key = (try? await api.gatePubkey())?.publicKey ?? model.profile?.gate?.publicKey
            guard let key else { throw TokenError.badPublicKey }
            ciphertext = try TokenMinter(publicKeyBase64URL: key).mint(payload)
        }
        try await send(api, typed.request(ciphertext: ciphertext, current: current))
    }

    private func clear(_ api: AgentSwitchAPI) async throws { try await send(api, nil) }

    private func send(_ api: AgentSwitchAPI, _ request: ProxyRequest?) async throws {
        switch target {
        case .browser: show(try await api.setBrowserProxy(request), resetDraft: true)
        case .profile(let agent, let profile):
            let reply = try await api.setProfileProxy(agent: agent, id: profile.id, proxy: request)
            show(reply.agents[agent]?.profiles.first { $0.id == profile.id }, problem: reply.problem, resetDraft: true)
        }
    }

    private func check(_ api: AgentSwitchAPI) async throws {
        guard case .profile(let agent, let profile) = target else { return }
        let reply = try await api.checkProfileExit(agent: agent, id: profile.id)
        show(reply.agents[agent]?.profiles.first { $0.id == profile.id }, problem: reply.problem, resetDraft: false)
    }

    private func restart(_ api: AgentSwitchAPI) async throws { show(try await api.restartBrowser(), resetDraft: false) }

    private func show(_ state: BrowserProxyState, resetDraft: Bool) {
        current = state.proxy
        restartNeeded = state.restartNeeded
        fingerprint = state.fingerprint
        switch state.exit {
        case .found(let found)?: exit = found.text; problem = nil
        case .problem(let text)?: exit = nil; problem = text
        case nil: exit = nil; problem = nil
        }
        if exit == nil, let proxy = state.proxy { exit = ProxyText.site(proxy.server) }
        if resetDraft { draft = ProxyDraft(state.proxy) }
    }

    private func show(_ profile: ProfileChoice?, problem said: String?, resetDraft: Bool) {
        guard let profile else { return }
        current = profile.proxy
        exit = profile.proxy == nil ? nil : profile.way
        problem = said
        if resetDraft { draft = ProxyDraft(profile.proxy) }
    }
}
