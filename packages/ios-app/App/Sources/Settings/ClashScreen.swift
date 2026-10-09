import AgentSwitchKit
import SwiftUI
import UniformTypeIdentifiers

/// What the Clash page has read and is doing (docs/clash-v0.md §9): one of these per page, handed to the pages
/// behind it (a service's nodes, a template's text) so that they change the same thing.
@MainActor
@Observable
final class ClashModel {
    var view: ClashView?
    var loaded = false
    var error: String?
    /// A call that fetches from the subscription service is under way.
    var fetching = false
    var delays: [ClashService: [String: Int?]] = [:]
    var testing: Set<ClashService> = []
    var checked: [ClashCheckRow]?
    var checking = false
    @ObservationIgnored var api: AgentSwitchAPI?
    @ObservationIgnored var failed: (Error) -> Void = { _ in }

    func load() async {
        guard let api else {
            #if DEBUG
            view = DemoData.clash
            delays = DemoData.clashDelays
            checked = DemoData.clashChecked
            loaded = true
            #endif
            return
        }
        do { view = try await api.clash(); error = nil } catch { if view == nil { say(error) } }
        loaded = true
    }

    /// One call to the Mac; what it has afterwards is shown.
    func run(_ work: @escaping (AgentSwitchAPI) async throws -> ClashView) {
        guard let api else { return }
        Task { do { view = try await work(api); error = nil } catch { say(error) } }
    }

    /// The same for a call that fetches from the subscription service: said to be under way meanwhile.
    func fetch(_ work: @escaping (AgentSwitchAPI) async throws -> ClashView) {
        guard let api, !fetching else { return }
        fetching = true
        Task {
            do { view = try await work(api); error = nil } catch { say(error) }
            fetching = false
        }
    }

    /// The settings with one thing changed, kept by the Mac at once.
    func change(_ edit: (inout ClashSettings) -> Void) {
        guard let now = view?.settings else { return }
        var next = now
        edit(&next)
        guard next != now else { return }
        #if DEBUG
        if api == nil { view = DemoData.clash(with: next) }
        #endif
        run { try await $0.saveClash(next) }
    }

    func select(_ service: ClashService, node: String?) { run { try await $0.selectClash(service, node: node) } }

    func test(_ service: ClashService, all: Bool) {
        guard let api, !testing.contains(service) else { return }
        testing.insert(service)
        Task {
            do {
                let tried = try await api.clashDelays(service, all: all)
                delays[service] = (delays[service] ?? [:]).merging(tried) { _, new in new }
                error = nil
            } catch { say(error) }
            testing.remove(service)
        }
    }

    func check() {
        guard let api, !checking else { return }
        checking = true
        Task {
            do { checked = try await api.checkClash(); error = nil } catch { say(error) }
            checking = false
        }
    }

    /// What was edited is kept — a rule template's own rules, or the DNS template's own text (`template` nil);
    /// `text` nil: the built-in one again. What the Mac says is wrong with it is the answer.
    func keep(_ template: ClashTemplate?, text: String?) async -> String? {
        guard let api, var next = view?.settings else { return "还没有读到设置。" }
        if let template { next.templates[template].rules = text.map(ClashText.lines) } else { next.dns.text = text }
        do {
            view = try await api.saveClash(next)
            return nil
        } catch {
            failed(error)
            return error.localizedDescription
        }
    }

    private func say(_ error: Error) {
        failed(error)
        self.error = error.localizedDescription
    }
}

/// 设置 › Proxies › Clash (docs/clash-v0.md §9): the Mac's Clash page on the phone — what was found of Clash Verge,
/// the subscription worked from, the nodes for Claude and for OpenAI with what each group uses now, the rule
/// templates and DNS, the addresses that go direct, and the routing check. The one thing that stays on the Mac is
/// adding AgentSwitch's subscription to Clash Verge.
struct ClashScreen: View {
    @Environment(AppModel.self) private var model
    @State private var clash = ClashModel()
    @State private var adding = false
    @State private var confirmRemove = false
    @State private var newDirect = ""
    #if DEBUG
    @State private var demoNodes = false
    @State private var demoText = false
    #endif

    var body: some View {
        ScrollViewReader { reader in
        Form {
            if let error = clash.error { Section { ErrorText(message: Binding(get: { clash.error }, set: { clash.error = $0 })).id(error) } }
            if let view = clash.view {
                status(view)
                subscription(view)
                if view.source != nil {
                    ForEach(ClashService.allCases, id: \.self) { ClashServiceSection(clash: clash, view: view, service: $0) }
                    rules(view)
                    direct(view)
                    routing(view)
                }
            } else if clash.loaded {
                Section { Text("这台 Mac 上的 AgentSwitch 还不能从手机管理 Clash：在 Mac 上更新 AgentSwitch。").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Clash")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if clash.fetching { ToolbarItem(placement: .topBarTrailing) { ProgressView() } } }
        .task {
            clash.api = model.api
            clash.failed = { [model] in model.handle($0) }
            await clash.load()
            #if DEBUG
            await demo(reader)
            #endif
        }
        #if DEBUG
        .navigationDestination(isPresented: $demoNodes) { ClashNodesScreen(clash: clash, service: .claude) }
        .navigationDestination(isPresented: $demoText) { ClashTextScreen(clash: clash, template: .domestic) }
        #endif
        }
        .refreshable { await clash.load() }
        .sheet(isPresented: $adding) { ClashSourceSheet(clash: clash) }
        .confirmationDialog("移除这个订阅？", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { clash.run { try await $0.removeClashSource() } }
        } message: {
            Text("Clash Verge 会继续用它上次取到的那一份，直到你在那里切走或删掉 AgentSwitch 订阅。")
        }
    }

    #if DEBUG
    /// The demo screens of this page: a part of it in view, or one of the pages behind it open.
    private func demo(_ reader: ScrollViewProxy) async {
        let screen = UserDefaults.standard.string(forKey: "uiDemoScreen")
        try? await Task.sleep(for: .milliseconds(300))
        switch screen {
        case "clashservice": reader.scrollTo("clash-service-openai", anchor: .bottom)
        case "clashrules": reader.scrollTo("clash-direct", anchor: .bottom)
        case "clashcheck": reader.scrollTo("clash-check", anchor: .bottom)
        case "clashnodes": demoNodes = true
        case "clashtext": demoText = true
        case "clashsource": adding = true
        default: break
        }
    }
    #endif

    // MARK: Clash Verge

    private func status(_ view: ClashView) -> some View {
        Section {
            LabeledContent("Clash Verge") {
                Text(view.word).mono(13).foregroundStyle(!view.found || !view.running ? Theme.failed : view.todo.isEmpty ? Theme.done : Theme.waiting)
            }
            if let version = view.version { LabeledContent("Core") { Text(version).mono(13) } }
            if let tun = view.tun { LabeledContent("TUN") { Text(tun ? "On" : "Off").mono(13).foregroundStyle(tun ? Color.secondary : Theme.waiting) } }
            ForEach(view.todo, id: \.self) { Text($0).font(.footnote).foregroundStyle(Theme.waiting) }
        } header: {
            SectionLabel("Status")
        }
    }

    // MARK: the subscription

    @ViewBuilder
    private func subscription(_ view: ClashView) -> some View {
        Section {
            if let source = view.source {
                LabeledContent("From") { Text(ClashText.origin(source)).mono(13).lineLimit(1) }
                LabeledContent("Nodes") { Text("\(source.nodes)").mono(13) }
                if let traffic = source.traffic { LabeledContent("Traffic") { Text(ClashText.traffic(traffic)).mono(13) } }
                LabeledContent("Updated") { Text(Date(timeIntervalSince1970: source.updatedAt / 1000).relative).mono(13) }
                if let error = source.error { Text("上次更新没有成功，用的还是之前那一份：\(error)").font(.footnote).foregroundStyle(Theme.waiting) }
                ForEach(source.providers.filter { $0.error != nil }, id: \.name) { provider in
                    Text("节点集 \(provider.name) 没有取到：\(provider.error ?? "")").font(.footnote).foregroundStyle(Theme.waiting)
                }
                Picker("Auto Update", selection: Binding(get: { view.settings.autoUpdateHours }, set: { hours in clash.change { $0.autoUpdateHours = hours } })) {
                    ForEach(ClashSettings.updateHours, id: \.self) { Text(ClashText.interval(hours: $0)).tag($0) }
                }
                Button("Update Now") { clash.fetch { try await $0.updateClash() } }.disabled(clash.fetching || source.kind != "link" && source.providers.isEmpty)
                Button("Replace…") { adding = true }.disabled(clash.fetching)
                Button("Remove", role: .destructive) { confirmRemove = true }.disabled(clash.fetching)
            } else {
                Button("Add Subscription…") { adding = true }.disabled(clash.fetching)
            }
        } header: {
            SectionLabel("Subscription")
        } footer: {
            Text(view.source == nil ? "AgentSwitch 从这个订阅出发，加上给 Claude 和 OpenAI 单独的分组，再交给 Clash Verge。链接由 Mac 保管，这里只显示它的主机名。"
                                    : "换一个订阅会忘掉为 Claude 和 OpenAI 选过的节点。")
        }
    }

    // MARK: rules and DNS

    private func rules(_ view: ClashView) -> some View {
        Section {
            ForEach(ClashTemplate.allCases, id: \.self) { template in
                Toggle(isOn: Binding(get: { view.settings.templates[template].on }, set: { on in clash.change { $0.templates[template].on = on } })) {
                    Text(template.title)
                }
                NavigationLink { ClashTextScreen(clash: clash, template: template) } label: {
                    LabeledContent("Edit") { Text(detail(view, template)).mono(13) }
                }
            }
            Toggle("DNS", isOn: Binding(get: { view.settings.dns.on }, set: { on in clash.change { $0.dns.on = on } }))
            NavigationLink { ClashTextScreen(clash: clash, template: nil) } label: {
                LabeledContent("Edit") { Text(view.dns.custom ? "Edited" : "Template").mono(13) }
            }
            if view.dns.on, view.dns.overridden {
                Text("Clash Verge 自己的“DNS 覆写”开着：内核用的是它那一份，这里的 DNS 不起作用。").font(.footnote).foregroundStyle(Theme.waiting)
            }
            if let group = view.defaultGroup {
                Toggle("Rename \(group) to Manual", isOn: Binding(get: { view.settings.renameDefault }, set: { on in clash.change { $0.renameDefault = on } }))
            }
        } header: {
            SectionLabel("Rules")
        } footer: {
            Text("规则模版打开就加进 Clash，关掉就拿走，都立刻生效。DNS 改的是订阅正文，要 Clash Verge 重新取一次才生效。")
        }
    }

    private func detail(_ view: ClashView, _ template: ClashTemplate) -> String {
        guard let state = view.state(template) else { return "" }
        return ClashText.rules(state.count) + (state.custom ? " · Edited" : "")
    }

    // MARK: go direct

    private func direct(_ view: ClashView) -> some View {
        Section {
            ForEach(view.settings.direct, id: \.self) { Text($0).code(14) }
                .onDelete { offsets in clash.change { $0.direct.remove(atOffsets: offsets) } }
            HStack {
                TextField("Address", text: $newDirect, prompt: Text("host or IP"))
                    .code(14).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .onSubmit(addDirect)
                Button("Add", action: addDirect).disabled(newDirect.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .id("clash-direct")
        } header: {
            SectionLabel("Go Direct")
        } footer: {
            Text("这些地址不经任何节点，直接连出去：配置自己的代理的地址会自己加进来。向左滑删除。")
        }
    }

    private func addDirect() {
        let address = newDirect.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty else { return }
        clash.change { if !$0.direct.contains(address) { $0.direct.append(address) } }
        newDirect = ""
    }

    // MARK: the routing check

    private func routing(_ view: ClashView) -> some View {
        Section {
            ForEach(clash.checked ?? []) { row in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(row.title)
                        Spacer()
                        if let ok = row.ok { Text(ok ? "OK" : "Wrong").mono(12).foregroundStyle(ok ? Theme.done : Theme.failed) }
                    }
                    Text(row.host).code(12).foregroundStyle(.secondary)
                    Text(row.route).font(.footnote).foregroundStyle(.secondary)
                    if let seen = row.seen { Text(seen).mono(12).foregroundStyle(.secondary) }
                    if let problem = row.problem { Text(problem).font(.footnote).foregroundStyle(Theme.failed) }
                }
                .padding(.vertical, 2)
            }
            HStack {
                Button(clash.checked == nil ? "Run Check" : "Run Again") { clash.check() }.disabled(clash.checking || !view.running)
                Spacer()
                if clash.checking { ProgressView() }
            }
            .id("clash-check")
        } header: {
            SectionLabel("Routing Check")
        } footer: {
            Text("每一类流量各发一条连接，看 Mac 上的内核把它送去了哪里。")
        }
    }
}

/// A service's own way out: what its group uses now — the automatic group or one node, picked by a tap — over the
/// nodes chosen for it in their order.
private struct ClashServiceSection: View {
    let clash: ClashModel
    let view: ClashView
    let service: ClashService
    @Environment(\.interfaceLook) private var look

    private var state: ClashServiceState? { view.state(service) }
    private var nodes: [String] { view.settings[service].nodes }
    private var live: Bool { state?.live ?? false }
    private var delays: [String: Int?] { clash.delays[service] ?? [:] }

    var body: some View {
        Section {
            if let state, state.live {
                row(title: "Automatic", detail: state.autoNow.map { "→ \($0)" } ?? "", chosen: state.automatic, gone: false) { clash.select(service, node: nil) }
            }
            ForEach(nodes, id: \.self) { node in
                row(title: node, detail: ClashText.delay(delays[node]), chosen: live ? state?.now == node : nil, gone: state?.missing.contains(node) ?? false) {
                    clash.select(service, node: node)
                }
            }
            .onDelete { offsets in clash.change { $0[service].nodes.remove(atOffsets: offsets) } }
            NavigationLink { ClashNodesScreen(clash: clash, service: service) } label: {
                LabeledContent("Nodes") { Text(nodes.isEmpty ? "None" : "\(nodes.count)").mono(13) }
            }
            HStack {
                Button("Test") { clash.test(service, all: false) }.disabled(clash.testing.contains(service) || nodes.isEmpty || !view.running)
                Spacer()
                if clash.testing.contains(service) { ProgressView() }
            }
            .id("clash-service-\(service.rawValue)")
        } header: {
            SectionLabel("Separate Proxy for \(service.title)")
        } footer: {
            Text(footer)
        }
    }

    /// One way out: its mark (a ring, or `< >` / `<x>`; none while the core has no such group yet), its name, and
    /// what there is to say of it on the right.
    private func row(title: String, detail: String, chosen: Bool?, gone: Bool, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack(spacing: Theme.Space.s) {
                if let chosen {
                    if look.isClassic {
                        Image(systemName: chosen ? "largecircle.fill.circle" : "circle").font(.system(size: 17)).foregroundStyle(chosen ? Theme.signal : Color.secondary)
                    } else {
                        Text(chosen ? "<x>" : "< >").mono(13).foregroundStyle(chosen ? Theme.ink : Color.secondary)
                    }
                }
                Text(title).lineLimit(1).foregroundStyle(Theme.ink)
                Spacer(minLength: Theme.Space.s)
                if gone { Text("Gone").mono(12).foregroundStyle(Theme.waiting) }
                Text(detail).mono(12).foregroundStyle(detail == "Timeout" ? Theme.waiting : Color.secondary).lineLimit(1)
            }
        }
        .disabled(chosen == nil || gone)
    }

    private var footer: String {
        guard let state else { return "" }
        if nodes.isEmpty { return "没有选节点：\(service.title) 的流量照订阅里原有的规则走。在 Nodes 里选几个。" }
        if nodes.allSatisfy(state.missing.contains) { return "选的节点在现在这个订阅里一个都没有（标着 Gone）：\(service.title) 的流量照订阅里原有的规则走。在 Nodes 里重新选几个；用不着的向左滑拿掉。" }
        let groups = "Clash 里是两组：\(state.auto) 按从上到下的顺序用第一个连得上的节点；\(state.group) 决定 \(service.title) 的流量走哪里。"
        return live ? groups + "点一行就改用那一个。" : groups + "Clash Verge 用上 AgentSwitch 订阅之后，可以在这里点选用哪一个。"
    }
}

/// A service's nodes: the ones chosen, in their order (dragged in `Edit`), and every node of the subscription to
/// take in or leave out with a tap. `Test All` says how long each takes.
private struct ClashNodesScreen: View {
    let clash: ClashModel
    let service: ClashService
    @Environment(\.interfaceLook) private var look
    @State private var query = ""
    @State private var editing: EditMode = .inactive

    private var chosen: [String] { clash.view?.settings[service].nodes ?? [] }
    private var delays: [String: Int?] { clash.delays[service] ?? [:] }
    private var all: [String] {
        let nodes = clash.view?.nodes ?? []
        let asked = query.trimmingCharacters(in: .whitespaces)
        return asked.isEmpty ? nodes : nodes.filter { $0.localizedCaseInsensitiveContains(asked) }
    }

    var body: some View {
        List {
            if !chosen.isEmpty {
                Section {
                    ForEach(chosen, id: \.self) { node in
                        HStack {
                            Text(node).lineLimit(1)
                            Spacer()
                            if clash.view?.state(service)?.missing.contains(node) == true { Text("Gone").mono(12).foregroundStyle(Theme.waiting) }
                            Text(ClashText.delay(delays[node])).mono(12).foregroundStyle(.secondary)
                        }
                    }
                    .onMove { from, to in clash.change { $0[service].nodes.move(fromOffsets: from, toOffset: to) } }
                    .onDelete { offsets in clash.change { $0[service].nodes.remove(atOffsets: offsets) } }
                } header: {
                    SectionLabel("Chosen")
                } footer: {
                    Text("从上到下，用第一个连得上的。")
                }
            }
            Section {
                ForEach(all, id: \.self) { node in
                    let on = chosen.contains(node)
                    Button {
                        clash.change { settings in
                            if on { settings[service].nodes.removeAll { $0 == node } } else { settings[service].nodes.append(node) }
                        }
                    } label: {
                        HStack(spacing: Theme.Space.s) {
                            if look.isClassic {
                                Image(systemName: on ? "checkmark.square.fill" : "square").font(.system(size: 17)).foregroundStyle(on ? Theme.signal : Color.secondary)
                            } else {
                                Text(on ? "[x]" : "[ ]").mono(13).foregroundStyle(on ? Theme.ink : Color.secondary)
                            }
                            Text(node).lineLimit(1).foregroundStyle(Theme.ink)
                            Spacer(minLength: Theme.Space.s)
                            Text(ClashText.delay(delays[node])).mono(12).foregroundStyle(ClashText.delay(delays[node]) == "Timeout" ? Theme.waiting : Color.secondary)
                        }
                    }
                }
            } header: {
                SectionLabel("All Nodes")
            }
        }
        .searchable(text: $query, prompt: "Search")
        .navigationTitle("\(service.title) Nodes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if clash.testing.contains(service) { ProgressView() } else {
                    Button("Test All") { clash.test(service, all: true) }.disabled(clash.view?.running != true)
                }
            }
            // The system's own button says it in the phone's language; this one in the app's words.
            ToolbarItem(placement: .topBarTrailing) {
                if chosen.count > 1 || editing.isEditing {
                    Button(editing.isEditing ? "Done" : "Edit") { withAnimation { editing = editing.isEditing ? .inactive : .active } }
                }
            }
        }
        .environment(\.editMode, $editing)
    }
}

/// A template's text, edited: a rule template's rules, a line each (docs/clash-v0.md §7.7), or the DNS template's
/// text (§7.8, `template` nil). What the Mac says is wrong with it is shown; the page stays open on it.
private struct ClashTextScreen: View {
    let clash: ClashModel
    let template: ClashTemplate?
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var initial = ""
    @State private var custom = false
    @State private var loaded = false
    @State private var saving = false
    @State private var problem: String?

    private var help: String {
        switch template {
        case .domestic?: return "一行一条规则，写成“类型,内容”，例如 DOMAIN-SUFFIX,cn 或 PROCESS-NAME,WeChat；不写去向（这里的都直连）。空行和 # 开头的行不算。"
        case .block?: return "一行一条规则，写成“类型,内容”，例如 DOMAIN-SUFFIX,doubleclick.net；不写去向（这里的都拦截）。空行和 # 开头的行不算。"
        case nil: return "这是订阅里 dns: 下面的整段内容（YAML，不含 dns: 这一行），打开开关后它会替换掉订阅自带的那一段。改完要等 Clash Verge 重新取一次订阅才生效。"
        }
    }

    var body: some View {
        Form {
            if let problem { Section { Text(problem).font(.footnote).foregroundStyle(Theme.failed) } }
            Section {
                TextEditor(text: $text)
                    .code(13).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .frame(minHeight: 320)
            } footer: {
                Text(help)
            }
            if custom {
                Section {
                    Button("Use Built-In", role: .destructive) { keep(nil) }.disabled(saving)
                } footer: {
                    Text("丢掉你自己改的这一份，用回内置的模版。")
                }
            }
        }
        .navigationTitle(template?.title ?? "DNS")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if saving { ProgressView() } else { Button("Save") { keep(text) }.disabled(!loaded || text == initial) }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard !loaded else { return }
        guard let api = clash.api else {
            #if DEBUG
            text = DemoData.clashRules
            initial = text
            loaded = true
            #endif
            return
        }
        do {
            if let template {
                let rules = try await api.clashTemplate(template)
                (text, custom) = (rules.rules.joined(separator: "\n"), rules.custom)
            } else {
                let dns = try await api.clashDNS()
                (text, custom) = (dns.text, dns.custom)
            }
            initial = text
            loaded = true
        } catch { problem = error.localizedDescription }
    }

    private func keep(_ edited: String?) {
        saving = true
        Task {
            problem = await clash.keep(template, text: edited)
            saving = false
            if problem == nil { dismiss() }
        }
    }
}

/// Where the subscription comes from: a link pasted in, one of Clash Verge's own subscriptions, or a file.
private struct ClashSourceSheet: View {
    let clash: ClashModel
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var picking = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                if let problem { Section { Text(problem).font(.footnote).foregroundStyle(Theme.failed) } }
                Section {
                    TextField("Link", text: $link, prompt: Text("https://…"), axis: .vertical)
                        .code(13).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).lineLimit(1...4)
                    Button("Use Link") { use { try await $0.setClashSource(link: link.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).count < 8)
                } header: {
                    SectionLabel("Link")
                } footer: {
                    Text("Mac 现在就去取一次，之后按 Auto Update 的间隔再取。链接经这条加密的连接发给 Mac，由它保管，不留在这台 iPhone 上。")
                }
                if let profiles = clash.view?.profiles, !profiles.isEmpty {
                    Section {
                        ForEach(profiles) { profile in
                            Button { use { try await $0.setClashSource(verge: profile.uid) } } label: {
                                LabeledContent(profile.name) { Text(profile.type).mono(12) }
                            }
                            .foregroundStyle(Theme.ink)
                        }
                    } header: {
                        SectionLabel("From Clash Verge")
                    } footer: {
                        Text("Mac 的 Clash Verge 里已有的订阅：点一个拿过来用。")
                    }
                }
                Section {
                    Button("Choose File…") { picking = true }
                } footer: {
                    Text("一份 Clash 的 yaml 配置。文件不会自己更新。")
                }
            }
            .navigationTitle("Subscription")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.yaml, .plainText, .data]) { result in
                switch result {
                case .success(let url): take(url)
                case .failure(let failure): problem = failure.localizedDescription
                }
            }
        }
    }

    private func use(_ work: @escaping (AgentSwitchAPI) async throws -> ClashView) {
        clash.fetch(work)
        dismiss()
    }

    private func take(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), data.count <= 8_000_000, let yaml = String(data: data, encoding: .utf8), !yaml.isEmpty else {
            problem = "读不了这个文件，或者它超过 8 MB、不是文本。"
            return
        }
        let name = url.lastPathComponent
        use { try await $0.setClashSource(yaml: yaml, name: name) }
    }
}
