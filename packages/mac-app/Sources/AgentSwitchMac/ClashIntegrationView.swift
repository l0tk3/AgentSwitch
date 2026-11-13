import AgentSwitchMacCore
import SwiftUI
import UniformTypeIdentifiers

/// The main window's Clash page (docs/clash-v0.md §6; 2026-10-08, user: 可以不在设置里吗，弄成浏览器 terminal dispatch并列的):
/// a column of its own on the page's ground, looked at again only while the page is the one shown. Since 2026-11-11 the
/// page is drawn in the app's own inks on its own ground, light or dark with the system — a system form on black
/// before (user: 这个页面应该换成和主题色一样的颜色).
struct ClashPage: View {
    let state: MainWindowState
    /// A made-up Clash for the design preview: shown as it is, the service never asked.
    var demo: ClashView?

    var body: some View {
        // On another node the page is that node's Clash (docs/mesh-v0.md §5.2; 2026-10-11, user: 我希望远程mac上我也能管理它的clash).
        ClashIntegrationView(shown: demo == nil && state.page == .clash && state.windowVisible, demo: demo, node: state.nodeId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Look.ground)
    }
}

/// The page shows another node's Clash: its words say "that Mac", and what only that Mac can do is not offered.
private struct ClashOnNodeKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var clashOnNode: Bool {
        get { self[ClashOnNodeKey.self] }
        set { self[ClashOnNodeKey.self] = newValue }
    }
}

/// What the page's parts ask for; each is one call to the service, and what it answers is shown.
struct ClashActions {
    var save: (ClashSettings) -> Void = { _ in }
    var useLink: (String) -> Void = { _ in }
    var chooseFile: () -> Void = {}
    var importFrom: (String) -> Void = { _ in }
    /// A subscription, by its id ("": the only one of a service that knows of one), is fetched again, removed,
    /// renamed, given another interval.
    var update: (String) -> Void = { _ in }
    var remove: (String) -> Void = { _ in }
    var rename: (String, String) -> Void = { _, _ in }
    var setHours: (String, Int) -> Void = { _, _ in }
    /// A node is left out of everything, or is back; every node is tried.
    var setNodeOff: (String, Bool) -> Void = { _, _ in }
    var testAll: () -> Void = {}
    var select: (ClashService, String?) -> Void = { _, _ in }
    var test: (ClashService, Bool) -> Void = { _, _ in }
    /// A template's rules are to be edited: they are fetched, then its sheet opens.
    var edit: (ClashTemplate) -> Void = { _ in }
    /// The same for the DNS template's text.
    var editDNS: () -> Void = {}
    /// The routing check is run.
    var check: () -> Void = {}
}

/// What is being edited in the sheet — a rule template's rules or the DNS template's text — as it was when the sheet
/// opened.
private struct ClashEditing: Identifiable {
    /// nil: the DNS template.
    let template: ClashTemplate?
    let text: String
    let custom: Bool
    var id: String { template?.rawValue ?? "dns" }

    var title: String { template?.title ?? "DNS" }

    var help: String {
        switch template {
        case .domestic?: "一行一条规则，写成“类型,内容”，例如 DOMAIN-SUFFIX,cn 或 PROCESS-NAME,WeChat；不写去向（这里的都直连）。从 Clash 的 yaml 里整行粘过来也可以，多余的部分会去掉；空行和 # 开头的行不算。"
        case .block?: "一行一条规则，写成“类型,内容”，例如 DOMAIN-SUFFIX,doubleclick.net；不写去向（这里的都拦截）。从 Clash 的 yaml 里整行粘过来也可以，多余的部分会去掉；空行和 # 开头的行不算。"
        case nil: "这是订阅里 dns: 下面的整段内容（YAML，不含 dns: 这一行），打开开关后它会替换掉订阅自带的那一段。改完要等 Clash Verge 重新取一次订阅才生效。"
        }
    }
}

/// Clash Integration (docs/clash-v0.md §7): the subscription AgentSwitch works from, the nodes for Claude and for
/// OpenAI in their order with what each group uses now, the addresses that go direct — and, until Clash Verge runs the
/// subscription AgentSwitch makes with TUN on, what is still to do there.
struct ClashIntegrationView: View {
    @Environment(AppModel.self) private var model
    /// The page is on screen: what Clash Verge runs is asked for only then.
    var shown = true
    var demo: ClashView?
    /// The node whose Clash this is; nil: this Mac's. Every call goes to that node's service; what only the Mac Clash
    /// Verge runs on can do (handing it the subscription) is said, not offered.
    var node: String?
    private var client: DaemonClient { model.client(on: node) }
    @State private var loaded: ClashView?
    @State private var error: String?
    /// A fetch from the subscription service is under way.
    @State private var fetching = false
    @State private var delays: [ClashService: [String: Int?]] = [:]
    @State private var testing: Set<ClashService> = []
    /// How long every node took when all were tried, whatever they are used for; and that they are being tried.
    @State private var allDelays: [String: Int?] = [:]
    @State private var testingAll = false
    @State private var editing: ClashEditing?
    /// The last routing check's lines; nil: none run yet.
    @State private var checked: [ClashCheckRow]?
    @State private var checking = false
    private var view: ClashView? { loaded ?? demo }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let view {
                    ClashStatusLines(view: view, error: error)
                    if view.found {
                        // The subscription first: where the nodes come from and how they are kept up to date (2026-11-11,
                        // user: 代理链接更新相关的东西应该放在最上面; at the foot before).
                        ClashGroup(view.keepsSeveral ? "Subscriptions" : "Subscription") {
                            ForEach(view.listed) { ClashSubscriptionCard(subscription: $0, view: view, fetching: fetching, actions: actions) }
                            ClashAddCard(view: view, fetching: fetching, actions: actions)
                            if view.source != nil { ClashDeliveryCard(view: view, actions: actions) }
                        }
                        if view.source != nil {
                            // Every node of every subscription in one place (§10).
                            if view.table != nil {
                                ClashGroup("Nodes") { ClashNodesCard(view: view, delays: allDelays.isEmpty ? demoDelays(.claude) : allDelays, testing: testingAll, actions: actions) }
                            }
                            ClashGroup("Separate Proxies") {
                                ForEach(ClashService.allCases, id: \.self) { service in
                                    ClashServiceCard(service: service, view: view, delays: delays[service] ?? demoDelays(service), testing: testing.contains(service), actions: actions)
                                }
                            }
                            ClashGroup("Rules") {
                                ClashRulesCard(view: view, actions: actions)
                                ClashDirectCard(view: view, actions: actions)
                            }
                        }
                    }
                    if view.running { ClashGroup("Routing Check") { ClashCheckCard(rows: checked ?? demoCheck, checking: checking, actions: actions) } }
                } else {
                    Text(error ?? "Reading…").font(.system(size: 13)).foregroundStyle(Look.ink2).padding(.top, 24)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
            .frame(maxWidth: 680, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .tint(Color.signal)
        .environment(\.clashOnNode, node != nil)
        .sheet(item: $editing) { item in
            ClashTextEditor(title: item.title, help: item.help, initial: item.text, custom: item.custom) { text in await saveEdited(item.template, text: text) }
        }
        .task(id: shown) {
            // What Clash Verge runs changes there, not here: looked at again every few seconds while the page shows.
            while shown, !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private var demoCheck: [ClashCheckRow]? {
        #if DEBUG
        demo == nil ? nil : ClashView.demoCheck
        #else
        nil
        #endif
    }

    private func demoDelays(_ service: ClashService) -> [String: Int?] {
        #if DEBUG
        demo == nil ? [:] : ClashView.demoDelays
        #else
        [:]
        #endif
    }

    private var actions: ClashActions {
        ClashActions(
            save: { next in run { try await $0.saveClash(next) } },
            // A service that knows of one subscription alone (another node not yet updated) has the one replaced.
            useLink: { link in fetch { several ? try await $0.addClashSubscription(link: link) : try await $0.setClashSource(link: link) } },
            chooseFile: chooseFile,
            importFrom: { uid in fetch { several ? try await $0.addClashSubscription(verge: uid) : try await $0.setClashSource(verge: uid) } },
            update: { id in fetch { several ? try await $0.updateClashSubscription(id) : try await $0.updateClash() } },
            remove: { id in run { several ? try await $0.removeClashSubscription(id) : try await $0.removeClashSource() } },
            rename: { id, name in run { try await $0.editClashSubscription(id, name: name) } },
            setHours: setHours,
            setNodeOff: { name, off in run { try await $0.setClashNode(name, off: off) } },
            testAll: testAll,
            select: { service, node in run { try await $0.selectClash(service, node: node) } },
            test: test,
            edit: edit,
            editDNS: editDNS,
            check: check)
    }

    /// The service keeps several subscriptions (§10).
    private var several: Bool { view?.keepsSeveral ?? false }

    private func setHours(_ id: String, _ hours: Int) {
        if several { run { try await $0.editClashSubscription(id, hours: hours) }; return }
        guard var next = view?.settings else { return }
        next.autoUpdateHours = hours
        run { try await $0.saveClash(next) }
    }

    private func testAll() {
        guard !testingAll else { return }
        testingAll = true
        let client = client
        Task {
            do { allDelays = try await client.clashDelays(); error = nil }
            catch { self.error = said(error) }
            testingAll = false
        }
    }

    private func check() {
        guard !checking else { return }
        checking = true
        let client = client
        Task {
            do { checked = try await client.checkClash(); error = nil }
            catch { self.error = said(error) }
            checking = false
        }
    }

    private func edit(_ template: ClashTemplate) {
        let client = client
        Task {
            do {
                let rules = try await client.clashTemplate(template)
                editing = ClashEditing(template: template, text: rules.rules.joined(separator: "\n"), custom: rules.custom)
                error = nil
            } catch { self.error = said(error) }
        }
    }

    private func editDNS() {
        let client = client
        Task {
            do {
                let dns = try await client.clashDNS()
                editing = ClashEditing(template: nil, text: dns.text, custom: dns.custom)
                error = nil
            } catch { self.error = said(error) }
        }
    }

    /// What was edited is kept — a rule template's own rules, or the DNS template's own text (`template` nil); `text`
    /// nil: the built-in one again. What the service says is wrong with it is the answer: the sheet stays open on it.
    private func saveEdited(_ template: ClashTemplate?, text: String?) async -> String? {
        guard var next = view?.settings else { return "还没有读到设置。" }
        if let template { next.templates[template].rules = text.map(ClashText.lines) } else { next.dns.text = text }
        do {
            loaded = try await client.saveClash(next)
            error = nil
            return nil
        } catch { return said(error) }
    }

    private func load() async {
        do { loaded = try await client.clash(); error = nil }
        catch { if loaded == nil { self.error = said(error) } }
    }

    /// One call to the service; what it has afterwards is shown.
    private func run(_ work: @escaping (DaemonClient) async throws -> ClashView) {
        let client = client
        Task {
            do { loaded = try await work(client); error = nil }
            catch { self.error = said(error) }
        }
    }

    /// The same for a call that fetches from the subscription service: said to be under way meanwhile.
    private func fetch(_ work: @escaping (DaemonClient) async throws -> ClashView) {
        guard !fetching else { return }
        fetching = true
        let client = client
        Task {
            do { loaded = try await work(client); error = nil }
            catch { self.error = said(error) }
            fetching = false
        }
    }

    private func test(_ service: ClashService, all: Bool) {
        guard !testing.contains(service) else { return }
        testing.insert(service)
        let client = client
        Task {
            do {
                let tried = try await client.clashDelays(service, all: all)
                delays[service] = (delays[service] ?? [:]).merging(tried) { _, new in new }
                error = nil
            } catch { self.error = said(error) }
            testing.remove(service)
        }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.yaml, .plainText]
        panel.allowsMultipleSelection = false
        panel.message = "A Clash subscription file (YAML)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let text = try? String(contentsOf: url, encoding: .utf8), text.utf8.count < 8_000_000 else {
            error = "这个文件读不了，或者太大了。"
            return
        }
        let name = url.lastPathComponent, several = several
        fetch { several ? try await $0.addClashSubscription(yaml: text, name: name) : try await $0.setClashSource(yaml: text, name: name) }
    }

    private func said(_ error: Error) -> String { (error as? DaemonError)?.reason ?? error.localizedDescription }
}

/// The sheet a template is edited in: a rule template's rules, a line each (docs/clash-v0.md §7.7), or the DNS
/// template's text (§7.8). `save` answers with what the service says is wrong with it, or nil when it was kept — the
/// sheet closes only then; `save(nil)` is the built-in one again.
struct ClashTextEditor: View {
    let title: String
    let help: String
    let custom: Bool
    let save: (String?) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var problem: String?
    @State private var saving = false

    /// `problem`: what is said under the text from the start (the design preview's).
    init(title: String, help: String, initial: String, custom: Bool, problem: String? = nil, save: @escaping (String?) async -> String?) {
        self.title = title
        self.help = help
        self.custom = custom
        self.save = save
        _problem = State(initialValue: problem)
        _text = State(initialValue: initial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text(help).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(minWidth: 520, minHeight: 360)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            if let problem { Text(problem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Button("Reset to Template") { commit(nil) }.disabled(saving || !custom)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") { commit(text) }.keyboardShortcut(.defaultAction).disabled(saving)
            }
        }
        .padding(20)
        .frame(width: 600)
    }

    private func commit(_ edited: String?) {
        saving = true
        Task {
            problem = await save(edited)
            saving = false
            if problem == nil { dismiss() }
        }
    }
}

#if DEBUG
extension ClashView {
    /// A made-up Clash for the design preview: a subscription from a link, three nodes for Claude with the second
    /// picked by hand, two for OpenAI whose groups Clash Verge does not have yet.
    static let demo: ClashView = try! JSONDecoder().decode(ClashView.self, from: Data("""
    {"found":true,"running":true,"version":"v1.19.31","tun":true,"active":true,"upToDate":false,"fetchedAt":1791463123000,
     "source":{"kind":"link","name":"sub.example.com","host":"sub.example.com","updatedAt":1791462000000,"nodes":42,
               "providers":[],"traffic":{"used":13207024435,"total":107374182400,"expire":1798675200000}},
     "nodes":["JP Tokyo 01","JP Tokyo 02","SG Singapore 01","US Los Angeles 01","US Seattle 02","HK Hong Kong 03"],
     "together":true,
     "subscriptions":[{"id":"0","kind":"link","name":"Main","host":"sub.example.com","updatedAt":1791462000000,"nodes":4,"providers":[],"hours":24,
                       "traffic":{"used":13207024435,"total":107374182400,"expire":1798675200000}},
                      {"id":"3f9a12c0","kind":"file","name":"spare.yaml","updatedAt":1791202800000,"nodes":3,"providers":[],"hours":0}],
     "table":[{"name":"JP Tokyo 01","sub":"0","type":"vless","off":false},{"name":"JP Tokyo 02","sub":"0","type":"vless","off":false},
              {"name":"SG Singapore 01","sub":"0","type":"trojan","off":false},{"name":"US Los Angeles 01","sub":"0","type":"vless","off":false},
              {"name":"US Seattle 02","sub":"3f9a12c0","type":"hysteria2","off":false},{"name":"HK Hong Kong 03","sub":"3f9a12c0","type":"ss","off":false},
              {"name":"JP Tokyo 01 · spare.yaml","sub":"3f9a12c0","type":"ss","off":true}],
     "profiles":[{"uid":"Lbw7BJYzpand","name":"my-subscription.yaml","type":"local"}],
     "settings":{"claude":{"nodes":["JP Tokyo 01","SG Singapore 01","US Seattle 02"]},"openai":{"nodes":["US Los Angeles 01","JP Tokyo 02"]},
                 "direct":["203.0.113.7"],"autoUpdateHours":24,"renameDefault":true,"dns":{"on":true,"text":null},
                 "templates":{"domestic":{"on":true,"rules":null},"block":{"on":false,"rules":["DOMAIN-SUFFIX,doubleclick.net"]}}},
     "services":{"claude":{"group":"Claude","auto":"Claude自动选择","live":true,"now":"SG Singapore 01","autoNow":"JP Tokyo 01","missing":[]},
                 "openai":{"group":"OpenAI","auto":"OpenAI自动选择","live":false,"now":null,"autoNow":null,"missing":[]}},
     "templates":{"domestic":{"on":true,"custom":false,"count":169},"block":{"on":false,"custom":true,"count":31}},"defaultGroup":"Candy",
     "dns":{"on":true,"custom":false,"overridden":false},
     "install":"clash://install-config?url=x"}
    """.utf8))

    static let demoDelays: [String: Int?] = ["JP Tokyo 01": 392, "SG Singapore 01": 428, "US Seattle 02": nil, "US Los Angeles 01": 330]

    /// A made-up routing check: Claude as it should be, OpenAI leaving by the wrong group, an ad getting through.
    static let demoCheck: [ClashCheckRow] = try! JSONDecoder().decode([ClashCheckRow].self, from: Data("""
    [{"id":"claude","title":"Claude","host":"claude.ai","expect":{"kind":"group","group":"Claude"},"ok":true,
      "observed":{"outcome":"proxied","rule":"RuleSet as-claude","path":["Claude","Claude自动选择","SG Singapore 01"],"exit":{"ip":"203.0.113.9","loc":"SG"},"ms":362}},
     {"id":"openai","title":"OpenAI","host":"chatgpt.com","expect":{"kind":"group","group":"OpenAI"},"ok":false,
      "observed":{"outcome":"proxied","rule":"Match","path":["Manual","HK Hong Kong 03"],"exit":{"ip":"198.51.100.4","loc":"HK"},"ms":552}},
     {"id":"domestic","title":"Domestic","host":"www.baidu.com","expect":{"kind":"direct"},"ok":true,"observed":{"outcome":"direct","rule":"RuleSet as-domestic","path":["DIRECT"]}},
     {"id":"block","title":"Ads","host":"ad.doubleclick.net","expect":null,"ok":null,"observed":{"outcome":"proxied","rule":"Match","path":["Manual","HK Hong Kong 03"]}},
     {"id":"other","title":"Everything Else","host":"www.google.com","expect":null,"ok":null,"observed":{"outcome":"proxied","rule":"DomainKeyword google","path":["Manual","HK Hong Kong 03"]}}]
    """.utf8))
}
#endif
