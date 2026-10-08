import AgentSwitchMacCore
import SwiftUI
import UniformTypeIdentifiers

/// The main window's Clash page (docs/clash-v0.md §6; 2026-10-08, user: 可以不在设置里吗，弄成浏览器 terminal dispatch并列的):
/// the form in a column of its own on the window's dark ground, looked at again only while the page is the one shown.
struct ClashPage: View {
    let state: MainWindowState
    /// A made-up Clash for the design preview: shown as it is, the service never asked.
    var demo: ClashView?

    var body: some View {
        ClashIntegrationView(shown: demo == nil && state.page == .clash && state.windowVisible, demo: demo)
            .scrollContentBackground(.hidden)
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
    }
}

/// What the page's parts ask for; each is one call to the service, and what it answers is shown.
private struct ClashActions {
    var save: (ClashSettings) -> Void = { _ in }
    var useLink: (String) -> Void = { _ in }
    var chooseFile: () -> Void = {}
    var importFrom: (String) -> Void = { _ in }
    var update: () -> Void = {}
    var remove: () -> Void = {}
    var select: (ClashService, String?) -> Void = { _, _ in }
    var test: (ClashService, Bool) -> Void = { _, _ in }
    /// A template's rules are to be edited: they are fetched, then its sheet opens.
    var edit: (ClashTemplate) -> Void = { _ in }
    /// The same for the DNS template's text.
    var editDNS: () -> Void = {}
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
    @State private var loaded: ClashView?
    @State private var error: String?
    /// A fetch from the subscription service is under way.
    @State private var fetching = false
    @State private var delays: [ClashService: [String: Int?]] = [:]
    @State private var testing: Set<ClashService> = []
    @State private var editing: ClashEditing?
    private var view: ClashView? { loaded ?? demo }

    var body: some View {
        Form {
            if let view {
                ClashStatusSection(view: view, error: error)
                if view.found {
                    // What is used day to day comes first; the subscription, once given, is at the foot.
                    if view.source != nil {
                        ForEach(ClashService.allCases, id: \.self) { service in
                            ClashServiceSection(service: service, view: view, delays: delays[service] ?? demoDelays(service), testing: testing.contains(service), actions: actions)
                        }
                        ClashRulesSection(view: view, actions: actions)
                        ClashDirectSection(view: view, actions: actions)
                    }
                    ClashSubscriptionSection(view: view, fetching: fetching, actions: actions)
                }
            } else {
                Section { Text(error ?? "Reading…").foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
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
            useLink: { link in fetch { try await $0.setClashSource(link: link) } },
            chooseFile: chooseFile,
            importFrom: { uid in fetch { try await $0.setClashSource(verge: uid) } },
            update: { fetch { try await $0.updateClash() } },
            remove: { run { try await $0.removeClashSource() } },
            select: { service, node in run { try await $0.selectClash(service, node: node) } },
            test: test,
            edit: edit,
            editDNS: editDNS)
    }

    private func edit(_ template: ClashTemplate) {
        let client = model.client
        Task {
            do {
                let rules = try await client.clashTemplate(template)
                editing = ClashEditing(template: template, text: rules.rules.joined(separator: "\n"), custom: rules.custom)
                error = nil
            } catch { self.error = said(error) }
        }
    }

    private func editDNS() {
        let client = model.client
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
            loaded = try await model.client.saveClash(next)
            error = nil
            return nil
        } catch { return said(error) }
    }

    private func load() async {
        do { loaded = try await model.client.clash(); error = nil }
        catch { if loaded == nil { self.error = said(error) } }
    }

    /// One call to the service; what it has afterwards is shown.
    private func run(_ work: @escaping (DaemonClient) async throws -> ClashView) {
        let client = model.client
        Task {
            do { loaded = try await work(client); error = nil }
            catch { self.error = said(error) }
        }
    }

    /// The same for a call that fetches from the subscription service: said to be under way meanwhile.
    private func fetch(_ work: @escaping (DaemonClient) async throws -> ClashView) {
        guard !fetching else { return }
        fetching = true
        let client = model.client
        Task {
            do { loaded = try await work(client); error = nil }
            catch { self.error = said(error) }
            fetching = false
        }
    }

    private func test(_ service: ClashService, all: Bool) {
        guard !testing.contains(service) else { return }
        testing.insert(service)
        let client = model.client
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
        fetch { try await $0.setClashSource(yaml: text, name: url.lastPathComponent) }
    }

    private func said(_ error: Error) -> String { (error as? DaemonError)?.reason ?? error.localizedDescription }
}

// MARK: - Clash Verge

private struct ClashStatusSection: View {
    let view: ClashView
    let error: String?

    var body: some View {
        Section {
            ForEach(view.todo, id: \.self) { step in
                Label(step, systemImage: "exclamationmark.circle").foregroundStyle(.orange)
            }
            if view.todo.isEmpty { Label("Clash Verge 正在使用 AgentSwitch 的订阅，TUN 已打开。", systemImage: "checkmark.circle").foregroundStyle(.green) }
            if view.found, view.source != nil, !view.active {
                Button("Add to Clash Verge…") { if let url = URL(string: view.install) { NSWorkspace.shared.open(url) } }
            }
            if let fetched = view.fetchedAt {
                LabeledContent("Clash Verge Fetched") { Text(TimeText.moment(Date(timeIntervalSince1970: fetched / 1000))) }
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
        } header: {
            Text("Clash Verge")
        } footer: {
            Footer("AgentSwitch 把订阅原样拿来，加上 Claude 和 OpenAI 的分组与规则，在本机提供给 Clash Verge（只有这台 Mac 读得到）。不改 Clash Verge 的任何文件；不想用了，切回原来的订阅或删掉 AgentSwitch 这一个即可。换节点、调顺序、改直连都立刻生效；只有多出或少掉一组分组时要 Clash Verge 重新取一次，它每小时会自己来取——想更快，在 Clash Verge 里编辑 AgentSwitch 订阅，把更新间隔改成几分钟。")
        }
    }
}

// MARK: - the subscription

private struct ClashSubscriptionSection: View {
    let view: ClashView
    let fetching: Bool
    let actions: ClashActions
    @State private var link = ""
    @State private var removing = false

    var body: some View {
        Section {
            if let source = view.source { kept(source) }
            HStack {
                TextField(view.source == nil ? "Subscription Link" : "Another Link", text: $link).onSubmit(use)
                Button("Use", action: use).disabled(fetching || link.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            HStack {
                Button("Choose File…", action: actions.chooseFile)
                Menu("Import from Clash Verge") {
                    ForEach(view.profiles) { profile in Button(profile.name) { actions.importFrom(profile.uid) } }
                }
                .disabled(view.profiles.isEmpty)
                .fixedSize()
                Spacer()
                if fetching { ProgressView().controlSize(.small) }
            }
            .disabled(fetching)
        } header: {
            Text("Subscription")
        } footer: {
            Footer("底本：一条订阅链接、一个 Clash 的 yaml 文件，或者 Clash Verge 里现有的一个订阅（抄一份过来）。AgentSwitch 自己保存它并按间隔去取新的，里面有节点的地址和密码：只存在这台 Mac 上 AgentSwitch 自己的目录里，只有你能读。")
        }
        .confirmationDialog("Remove the subscription from AgentSwitch?", isPresented: $removing) {
            Button("Remove", role: .destructive, action: actions.remove)
        } message: {
            Text("Clash Verge 会继续用它上次取到的那一份，直到你在那里切走或删掉 AgentSwitch 订阅。")
        }
    }

    @ViewBuilder private func kept(_ source: ClashSource) -> some View {
        LabeledContent("Source") { Text(ClashText.origin(source)).lineLimit(1) }
        LabeledContent("Nodes") { Text("\(source.nodes)").monospacedDigit() }
        LabeledContent("Updated") { Text(TimeText.moment(Date(timeIntervalSince1970: source.updatedAt / 1000))) }
        if let traffic = source.traffic { LabeledContent("Traffic") { Text(ClashText.traffic(traffic)).monospacedDigit() } }
        if let error = source.error { Label("上次没有取到：\(error)。现在用的是之前那一份。", systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
        ForEach(source.providers.filter { $0.error != nil }, id: \.name) { set in
            Label("节点集 \(set.name) 没有取到：\(set.error ?? "")。", systemImage: "exclamationmark.circle").foregroundStyle(.orange)
        }
        if let group = view.defaultGroup {
            Toggle("Rename “\(group)” to Manual", isOn: Binding(get: { view.settings.renameDefault }, set: { on in
                var next = view.settings
                next.renameDefault = on
                actions.save(next)
            }))
        }
        Picker("Auto Update", selection: Binding(get: { view.settings.autoUpdateHours }, set: { hours in
            var next = view.settings
            next.autoUpdateHours = hours
            actions.save(next)
        })) {
            ForEach(ClashSettings.updateHours, id: \.self) { hours in Text(ClashText.interval(hours: hours)).tag(hours) }
        }
        HStack {
            Button("Update Now", action: actions.update).disabled(fetching)
            Spacer()
            Button("Remove…", role: .destructive) { removing = true }.disabled(fetching)
        }
    }

    private func use() {
        let text = link.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !fetching else { return }
        link = ""
        actions.useLink(text)
    }
}

// MARK: - a service's nodes

private struct ClashServiceSection: View {
    let service: ClashService
    let view: ClashView
    let delays: [String: Int?]
    let testing: Bool
    let actions: ClashActions

    private var nodes: [String] { view.settings[service].nodes }
    private var state: ClashServiceState? { view.state(service) }
    private var live: Bool { state?.live ?? false }

    var body: some View {
        Section {
            if let state, state.live {
                ClashChoiceRow(title: "Automatic", detail: state.autoNow.map { "→ \($0)" } ?? "", chosen: state.automatic) { actions.select(service, nil) }
            }
            ForEach(nodes, id: \.self) { node in
                ClashNodeRow(node: node, gone: state?.missing.contains(node) ?? false, delay: ClashText.delay(delays[node]),
                             chosen: live ? state?.now == node : nil, first: node == nodes.first, last: node == nodes.last,
                             pick: { actions.select(service, node) }, move: { by in move(node, by: by) }, remove: { change { $0.removeAll { $0 == node } } })
            }
            .onMove { from, to in change { $0.move(fromOffsets: from, toOffset: to) } }
            HStack {
                Menu("Add Node…") {
                    Button("Test All Nodes") { actions.test(service, true) }
                    Divider()
                    ForEach(view.nodes.filter { !nodes.contains($0) }, id: \.self) { node in
                        Button(label(node)) { change { $0.append(node) } }
                    }
                }
                .fixedSize()
                Spacer()
                if testing { ProgressView().controlSize(.small) }
                Button("Test") { actions.test(service, false) }.disabled(testing || nodes.isEmpty || !view.running)
            }
        } header: {
            Text("Separate Proxy for \(service.title)")
        } footer: {
            Footer(footer)
        }
    }

    private var footer: String {
        guard let state else { return "" }
        if nodes.isEmpty { return "没有选节点：\(service.title) 的流量照订阅里原有的规则走。" }
        // Chosen for another subscription, none of them in this one: as good as none chosen.
        if nodes.allSatisfy(state.missing.contains) { return "选的节点在现在这个订阅里一个都没有（标着 Gone）：\(service.title) 的流量照订阅里原有的规则走。从 Add Node… 里重新选几个；用不着的点减号拿掉。" }
        let groups = "Clash 里是两组：\(state.auto) 按从上到下的顺序用第一个连得上的节点；\(state.group) 决定 \(service.title) 的流量走哪里。"
        return live ? groups + "点一行就改用那一个。" : groups + "Clash Verge 用上之后，可以在这里点选用哪一个。"
    }

    /// A node in the menu, with how long it took when every node was tried.
    private func label(_ node: String) -> String {
        let delay = ClashText.delay(delays[node])
        return delay.isEmpty ? node : "\(node)    \(delay)"
    }

    private func move(_ node: String, by: Int) {
        change { list in
            guard let i = list.firstIndex(of: node), list.indices.contains(i + by) else { return }
            list.swapAt(i, i + by)
        }
    }

    private func change(_ edit: (inout [String]) -> Void) {
        var next = view.settings
        edit(&next[service].nodes)
        if next != view.settings { actions.save(next) }
    }
}

/// `Automatic`, the first row of a service whose groups the core has.
private struct ClashChoiceRow: View {
    let title: String
    let detail: String
    let chosen: Bool
    let pick: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            ClashRadio(chosen: chosen, action: pick)
            Text(title)
            Spacer()
            Text(detail).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

/// A chosen node: where it stands (moved by dragging or by its arrows), how long it took, whether the group uses it.
private struct ClashNodeRow: View {
    let node: String
    let gone: Bool
    let delay: String
    /// nil: the core does not have this service's groups, so nothing can be picked yet.
    let chosen: Bool?
    let first: Bool
    let last: Bool
    let pick: () -> Void
    let move: (Int) -> Void
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if let chosen { ClashRadio(chosen: chosen, action: pick) }
            Text(node).lineLimit(1)
            if gone { Text("Gone").font(.callout).foregroundStyle(.orange).help("订阅里已经没有这个节点。") }
            Spacer()
            Text(delay).monospacedDigit().foregroundStyle(delay == "Timeout" ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            Button { move(-1) } label: { Image(systemName: "chevron.up") }.disabled(first).help("Move Up")
            Button { move(1) } label: { Image(systemName: "chevron.down") }.disabled(last).help("Move Down")
            Button(action: remove) { Image(systemName: "minus.circle") }.help("Remove")
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
    }
}

private struct ClashRadio: View {
    let chosen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: chosen ? "largecircle.fill.circle" : "circle").foregroundStyle(chosen ? Color.accentColor : Color.secondary)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - the rule templates

private struct ClashRulesSection: View {
    let view: ClashView
    let actions: ClashActions

    var body: some View {
        Section {
            ForEach(ClashTemplate.allCases, id: \.self) { template in
                HStack {
                    Toggle(isOn: Binding(get: { view.settings.templates[template].on }, set: { on in
                        var next = view.settings
                        next.templates[template].on = on
                        actions.save(next)
                    })) {
                        Text(template.title)
                        Text(detail(template)).monospacedDigit()
                    }
                    Button("Edit…") { actions.edit(template) }
                }
            }
            HStack {
                Toggle(isOn: Binding(get: { view.settings.dns.on }, set: { on in
                    var next = view.settings
                    next.dns.on = on
                    actions.save(next)
                })) {
                    Text("DNS")
                    Text(view.dns.custom ? "Edited" : "Template")
                }
                Button("Edit…", action: actions.editDNS)
            }
            if view.dns.on, view.dns.overridden {
                Label("Clash Verge 自己的“DNS 覆写”开着：内核用的是它那一份，这里的 DNS 不起作用。", systemImage: "exclamationmark.circle").foregroundStyle(.orange)
            }
        } header: {
            Text("Rules")
        } footer: {
            Footer("打开就把这一套规则加进 Clash，关掉就拿走，都立刻生效。Domestic & Local Direct：国内常用域名、微信这类国内应用、局域网，直接连出去。Block Ads & Trackers：拦截广告和统计的域名；它排在订阅自己的规则之后，前面已经有规则管的流量不受它影响。DNS：用这里的 DNS 设置替换订阅自带的那一段（国内域名用国内 DNS 解析，Claude 的域名只认境外 DNS 的结果）；这一项改的是订阅正文，要 Clash Verge 重新取一次才生效。")
        }
    }

    private func detail(_ template: ClashTemplate) -> String {
        guard let state = view.state(template) else { return "" }
        return ClashText.rules(state.count) + (state.custom ? " · Edited" : "")
    }
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

// MARK: - direct

private struct ClashDirectSection: View {
    let view: ClashView
    let actions: ClashActions
    @State private var address = ""

    var body: some View {
        Section {
            ForEach(view.settings.direct, id: \.self) { item in
                HStack {
                    Text(item).font(.system(.body, design: .monospaced))
                    Spacer()
                    Button { change { $0.removeAll { $0 == item } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            HStack {
                TextField("IP or Host", text: $address).onSubmit(add)
                Button("Add", action: add).disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } header: {
            Text("Go Direct")
        } footer: {
            Footer("这些地址不经任何节点，直接连出去。用于配置里填的代理服务器：开着 TUN 时免得先绕一遍 Clash。改动立刻生效。")
        }
    }

    private func add() {
        let item = address.trimmingCharacters(in: .whitespaces)
        guard !item.isEmpty else { return }
        address = ""
        change { if !$0.contains(item) { $0.append(item) } }
    }

    private func change(_ edit: (inout [String]) -> Void) {
        var next = view.settings
        edit(&next.direct)
        if next != view.settings { actions.save(next) }
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
}
#endif
