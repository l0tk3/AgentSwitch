import AgentSwitchMacCore
import SwiftUI

// The Clash page's parts (docs/clash-v0.md §7.13): two levels and no more. A group has a heading that stands by itself
// (`Subscriptions`, `Nodes`, `Separate Proxies`, `Rules`, `Routing Check`); under it one card or several, and a card that is one
// of several says what it is in a band at its head (`Claude`, `OpenAI`, `Go Direct`). A system form before, where
// every block had the same small title and a paragraph under it (2026-11-11, user: 每个板块分级不太明显，容易混淆;
// 还有一堆这东西，没人会读). What a paragraph said is now a state's own line where the state is, or nothing.

// MARK: - the two levels

/// A group: its heading, then its cards.
struct ClashGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    @Environment(\.interfaceLook) private var look

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if look.isClassic { Text(title).font(.system(size: 17, weight: .semibold)) }
                else { Text(title.uppercased()).font(.system(size: 13, weight: .bold, design: .monospaced)).tracking(1.6) }
            }
            .foregroundStyle(Look.ink)
            content
        }
        .padding(.top, 30)
    }
}

/// A card: rows one under another, a line between them. `title`: the band at its head, for a card that is one of
/// several in its group.
struct ClashCard<Trailing: View, Content: View>: View {
    var title: String?
    @ViewBuilder var trailing: Trailing
    @ViewBuilder let content: Content
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                HStack(spacing: 8) {
                    Text(title).mono(13, weight: .semibold).foregroundStyle(Look.ink)
                    Spacer(minLength: 8)
                    trailing
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Look.raised)
                .overlay(alignment: .bottom) { ClashLine() }
            }
            content
        }
        .grounded(Look.panel)
        .framed(Look.line)
    }
}

extension ClashCard where Trailing == EmptyView {
    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = EmptyView()
        self.content = content()
    }
}

private struct ClashLine: View {
    @Environment(\.interfaceLook) private var look

    var body: some View { Look.line.frame(height: look.isClassic ? 0.5 : 1) }
}

private extension View {
    /// A row of a card: its room, and the line under it (the last row's lies on the card's own edge).
    func clashRow() -> some View {
        font(.system(size: 13))
            .foregroundStyle(Look.ink)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
            .overlay(alignment: .bottom) { ClashLine() }
    }
}

/// `Updated        3m ago`: a name and what it is.
private struct ClashFact<Value: View>: View {
    let name: String
    @ViewBuilder let value: Value

    var body: some View {
        HStack(spacing: 8) {
            Text(name)
            Spacer(minLength: 8)
            value.foregroundStyle(Look.ink2)
        }
        .clashRow()
    }
}

private struct ClashButton: View {
    let word: String
    var role: BracketButtonStyle.Role = .normal
    let action: () -> Void

    init(_ word: String, role: BracketButtonStyle.Role = .normal, action: @escaping () -> Void) {
        self.word = word
        self.role = role
        self.action = action
    }

    var body: some View {
        Button(action: action) { BracketLabel(word: word) }.buttonStyle(BracketButtonStyle(role: role))
    }
}

/// A state's sign: a dot (a square in the pixel look) in its colour.
private struct ClashMark: View {
    let color: Color
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group { if look.isClassic { Circle().fill(color) } else { Rectangle().fill(color) } }.frame(width: 7, height: 7)
    }
}

/// Something that is not as it should be, in a line: amber.
private struct ClashNote: View {
    let text: String
    var color: Color = .waiting

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            ClashMark(color: color).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            Text(text).font(.system(size: 13)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct ClashField: View {
    let prompt: String
    @Binding var text: String
    var mono = false
    let submit: () -> Void

    var body: some View {
        TextField(prompt, text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: 13, design: mono ? .monospaced : .default))
            .foregroundStyle(Look.ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .grounded(Look.raised, radius: Look.controlRadius)
            .framed(Look.line, radius: Look.controlRadius)
            .onSubmit(submit)
    }
}

// MARK: - what is still to do

/// The page's first lines: what is still to do in Clash Verge, or that nothing is.
struct ClashStatusLines: View {
    let view: ClashView
    let error: String?
    @Environment(\.clashOnNode) private var onNode

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if view.todo.isEmpty {
                ClashNote(text: ["In Use", view.tun == true ? "TUN On" : nil, view.version.map { "mihomo \($0)" }].compactMap { $0 }.joined(separator: " · "), color: .ok)
            }
            ForEach(view.todo, id: \.self) { ClashNote(text: $0) }
            if view.found, view.source != nil, !view.active {
                if onNode {
                    // The link that hands Clash Verge the subscription opens on the Mac Clash Verge runs on.
                    Text("这一步在那台 Mac 上完成：在它的 Clash 页点 Add to Clash Verge…。").font(.system(size: 12)).foregroundStyle(Look.ink2)
                } else {
                    ClashButton("Add to Clash Verge…", role: .primary) { if let url = URL(string: view.install) { NSWorkspace.shared.open(url) } }
                }
            }
            if let error { ClashNote(text: error, color: .failed) }
        }
        .padding(.top, 22)
    }
}

// MARK: - the subscriptions

/// One subscription (docs/clash-v0.md §10): where it comes from, when it was fetched, how often it is fetched again;
/// renamed and removed from here. Its name and what it holds are in the band at its head.
struct ClashSubscriptionCard: View {
    let subscription: ClashSubscription
    let view: ClashView
    let fetching: Bool
    let actions: ClashActions
    @State private var removing = false
    @State private var renaming = false
    @State private var name = ""

    var body: some View {
        ClashCard(title: subscription.name) {
            Text(([ClashText.nodes(subscription.nodes)] + [subscription.traffic.map { ClashText.traffic($0) }].compactMap { $0 }).joined(separator: " · "))
                .font(.system(size: 12)).monospacedDigit().foregroundStyle(Look.ink2).lineLimit(1)
        } content: {
            ClashFact(name: "From") { Text(subscription.origin).lineLimit(1) }
            HStack(spacing: 10) {
                Text("Updated")
                Spacer(minLength: 8)
                if fetching { ProgressView().controlSize(.small) }
                Text(TimeText.moment(Date(timeIntervalSince1970: subscription.updatedAt / 1000))).foregroundStyle(Look.ink2)
                ClashButton("Update Now") { actions.update(subscription.id) }.disabled(fetching)
            }
            .clashRow()
            if let error = subscription.error { ClashNote(text: "上次没有取到：\(error)。现在用的是之前那一份。").clashRow() }
            ForEach(subscription.providers.filter { $0.error != nil }, id: \.name) { set in
                ClashNote(text: "节点集 \(set.name) 没有取到：\(set.error ?? "")。").clashRow()
            }
            HStack {
                Text("Auto Update")
                Spacer(minLength: 8)
                Picker("", selection: Binding(get: { subscription.hours }, set: { actions.setHours(subscription.id, $0) })) {
                    ForEach(ClashSettings.updateHours, id: \.self) { hours in Text(ClashText.interval(hours: hours)).tag(hours) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
            }
            .clashRow()
            HStack(spacing: 14) {
                // A service that knows of one subscription alone has no name to give it.
                if view.keepsSeveral { ClashButton("Rename…") { name = subscription.name; renaming = true } }
                Spacer()
                ClashButton("Remove…", role: .destructive) { removing = true }
            }
            .disabled(fetching)
            .clashRow()
        }
        .confirmationDialog("Remove “\(subscription.name)” from AgentSwitch?", isPresented: $removing) {
            Button("Remove", role: .destructive) { actions.remove(subscription.id) }
        } message: {
            Text(view.listed.count > 1 ? "它的节点会从 Clash 的分组里拿掉；为 Claude、OpenAI 选的节点里属于它的也一并去掉。"
                 : "Clash Verge 会继续用它上次取到的那一份，直到你在那里切走或删掉 AgentSwitch 订阅。")
        }
        .alert("Rename Subscription", isPresented: $renaming) {
            TextField("Name", text: $name)
            Button("Rename") {
                let next = name.trimmingCharacters(in: .whitespaces)
                if !next.isEmpty, next != subscription.name { actions.rename(subscription.id, next) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

/// One more subscription: a link, a file, or one of Clash Verge's own. With a service that knows of one subscription
/// alone, what is given takes the place of the one there is.
struct ClashAddCard: View {
    let view: ClashView
    let fetching: Bool
    let actions: ClashActions
    @State private var link = ""

    private var first: Bool { view.source == nil }

    var body: some View {
        ClashCard(title: first ? nil : (view.keepsSeveral ? "Add Subscription" : "Replace Subscription")) {
            if fetching { ProgressView().controlSize(.small) }
        } content: {
            HStack(spacing: 10) {
                ClashField(prompt: "Subscription Link", text: $link, submit: use)
                ClashButton(first || view.keepsSeveral ? "Add" : "Use", role: first ? .primary : .normal, action: use).disabled(fetching || link.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .clashRow()
            HStack(spacing: 14) {
                ClashButton("Choose File…", action: actions.chooseFile)
                Menu {
                    ForEach(view.profiles) { profile in Button(profile.name) { actions.importFrom(profile.uid) } }
                } label: { BracketLabel(word: "Import from Clash Verge") }
                .menuStyle(.borderlessButton)
                .tint(Look.ink)
                .fixedSize()
                .disabled(view.profiles.isEmpty)
                Spacer()
                if fetching && first { ProgressView().controlSize(.small) }
            }
            .disabled(fetching)
            .clashRow()
        }
    }

    private func use() {
        let text = link.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !fetching else { return }
        link = ""
        actions.useLink(text)
    }
}

/// How what is made of the subscriptions reaches Clash Verge: when it last fetched it, whether AgentSwitch loads a
/// change itself, the default group's name.
struct ClashDeliveryCard: View {
    let view: ClashView
    let actions: ClashActions

    var body: some View {
        ClashCard(title: "Clash Verge") {
            if let fetched = view.fetchedAt {
                ClashFact(name: "Clash Verge Fetched") { Text(TimeText.moment(Date(timeIntervalSince1970: fetched / 1000))) }
            }
            ClashSwitch(title: "Apply Changes at Once", detail: "订阅有改动时由 AgentSwitch 直接让内核载入，不等 Clash Verge 每小时来取", isOn: setting(\.applyNow))
            if let group = view.defaultGroup, !view.ownRules {
                ClashSwitch(title: "Rename “\(group)” to Manual", detail: nil, isOn: setting(\.renameDefault))
            }
        }
    }

    private func setting(_ path: WritableKeyPath<ClashSettings, Bool>) -> Binding<Bool> {
        Binding(get: { view.settings[keyPath: path] }, set: { value in
            var next = view.settings
            next[keyPath: path] = value
            actions.save(next)
        })
    }
}

// MARK: - every node

/// Every node of every subscription in one table (docs/clash-v0.md §10): which subscription each is of, how long it
/// takes to answer, and a box that leaves it out of everything when it is cleared.
struct ClashNodesCard: View {
    let view: ClashView
    let delays: [String: Int?]
    let testing: Bool
    let actions: ClashActions
    /// The subscription shown alone; "": all of them.
    @State private var only = ""
    @State private var search = ""

    private var table: [ClashNode] { view.table ?? [] }
    private var names: [String: String] { Dictionary(uniqueKeysWithValues: view.listed.map { ($0.id, $0.name) }) }
    private var several: Bool { view.listed.count > 1 }
    private var shown: [ClashNode] { ClashText.filtered(table, subscription: only.isEmpty || names[only] == nil ? nil : only, search: search) }

    var body: some View {
        ClashCard {
            HStack(spacing: 10) {
                if several {
                    Picker("", selection: $only) {
                        Text("All Subscriptions").tag("")
                        ForEach(view.listed) { Text($0.name).tag($0.id) }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
                }
                ClashField(prompt: "Search", text: $search, submit: {})
                Text(ClashText.nodeCount(shown: shown.count, off: table.filter(\.off).count)).font(.system(size: 12)).monospacedDigit().foregroundStyle(Look.ink2).fixedSize()
                if testing { ProgressView().controlSize(.small) }
                ClashButton("Test All", action: actions.testAll).disabled(testing || !view.running)
            }
            .clashRow()
            if !view.ownRules, !several {
                Text("停用单个节点需要先打开 Only My Rules：订阅自带的分组里去不掉单个节点。").font(.system(size: 12)).foregroundStyle(Look.ink2).clashRow()
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(shown) { node in
                        HStack(spacing: 8) {
                            Button { actions.setNodeOff(node.name, !node.off) } label: {
                                Image(systemName: node.off ? "square" : "checkmark.square.fill").foregroundStyle(node.off ? Look.ink2 : Color.signal)
                            }
                            .buttonStyle(.plain)
                            .disabled(!view.ownRules && !node.off)
                            .help(node.off ? "Use This Node" : "Leave This Node Out")
                            Text(node.name).lineLimit(1).foregroundStyle(node.off ? Look.faint : Look.ink)
                            Spacer(minLength: 8)
                            if several { Text(names[node.sub] ?? "").font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1) }
                            Text(node.type).mono(11.5).foregroundStyle(Look.faint).frame(width: 78, alignment: .trailing)
                            let delay = ClashText.delay(delays[node.name])
                            Text(delay).monospacedDigit().foregroundStyle(delay == "Timeout" ? Color.waiting : Look.ink2).frame(width: 64, alignment: .trailing)
                        }
                        .clashRow()
                    }
                }
            }
            .frame(height: min(CGFloat(max(shown.count, 1)) * 38, 342))
            if shown.isEmpty { Text(table.isEmpty ? "No Nodes" : "No Matches").font(.system(size: 12)).foregroundStyle(Look.ink2).clashRow() }
        }
    }
}

/// A switch on a row: its name, a line about it where one is needed, the switch at the row's end.
private struct ClashSwitch<Trailing: View>: View {
    let title: String
    let detail: String?
    @Binding var isOn: Bool
    var held = false
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let detail { Text(detail).font(.system(size: 11.5)).foregroundStyle(Look.ink2).monospacedDigit().fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            trailing
            Toggle("", isOn: $isOn).labelsHidden().toggleStyle(.switch).controlSize(.small).disabled(held)
        }
        .clashRow()
    }
}

private extension ClashSwitch where Trailing == EmptyView {
    init(title: String, detail: String?, isOn: Binding<Bool>, held: Bool = false) {
        self.title = title
        self.detail = detail
        self._isOn = isOn
        self.held = held
        self.trailing = EmptyView()
    }
}

// MARK: - a service's nodes

struct ClashServiceCard: View {
    let service: ClashService
    let view: ClashView
    let delays: [String: Int?]
    let testing: Bool
    let actions: ClashActions

    private var nodes: [String] { view.settings[service].nodes }
    private var state: ClashServiceState? { view.state(service) }
    private var live: Bool { state?.live ?? false }
    /// Chosen for another subscription, none of them in this one: as good as none chosen.
    private var allGone: Bool { !nodes.isEmpty && nodes.allSatisfy { state?.missing.contains($0) ?? false } }

    var body: some View {
        ClashCard(title: service.title) {
            Text(standing).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1)
        } content: {
            if let state, state.live {
                HStack(spacing: 8) {
                    ClashRadio(chosen: state.automatic) { actions.select(service, nil) }
                    Text("Automatic")
                    Spacer()
                    Text(state.autoNow.map { "→ \($0)" } ?? "").foregroundStyle(Look.ink2).lineLimit(1)
                }
                .clashRow()
            }
            ForEach(nodes, id: \.self) { node in
                ClashNodeRow(node: node, gone: state?.missing.contains(node) ?? false, delay: ClashText.delay(delays[node]),
                             chosen: live ? state?.now == node : nil, first: node == nodes.first, last: node == nodes.last,
                             pick: { actions.select(service, node) }, move: { by in move(node, by: by) }, remove: { change { $0.removeAll { $0 == node } } })
                    .clashRow()
            }
            if allGone { ClashNote(text: "选的节点在现在这个订阅里都没有了，重新选几个。").clashRow() }
            HStack(spacing: 14) {
                Menu {
                    Button("Test All Nodes") { actions.test(service, true) }
                    Divider()
                    ForEach(view.nodes.filter { !nodes.contains($0) }, id: \.self) { node in
                        Button(label(node)) { change { $0.append(node) } }
                    }
                } label: { BracketLabel(word: "Add Node…") }
                .menuStyle(.borderlessButton)
                .tint(Look.ink)
                .fixedSize()
                Spacer()
                if testing { ProgressView().controlSize(.small) }
                ClashButton("Test") { actions.test(service, false) }.disabled(testing || nodes.isEmpty || !view.running)
            }
            .clashRow()
        }
    }

    /// Where the card stands, at its head's end: nothing chosen, not in Clash yet, or what its group uses now.
    private var standing: String {
        if nodes.isEmpty || allGone { return "Follows the Subscription" }
        guard let state, state.live else { return "Not in Clash Yet" }
        return state.automatic ? (state.autoNow ?? "") : (state.now ?? "")
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

/// A chosen node: where it stands (moved by its arrows), how long it took, whether the group uses it.
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
            if gone { Text("Gone").mono(11.5).foregroundStyle(Color.waiting).help("订阅里已经没有这个节点。") }
            Spacer()
            Text(delay).monospacedDigit().foregroundStyle(delay == "Timeout" ? Color.waiting : Look.ink2)
            Group {
                Button { move(-1) } label: { Image(systemName: "chevron.up") }.disabled(first).help("Move Up")
                Button { move(1) } label: { Image(systemName: "chevron.down") }.disabled(last).help("Move Down")
                Button(action: remove) { Image(systemName: "minus.circle") }.help("Remove")
            }
            .buttonStyle(.plain)
            .foregroundStyle(Look.ink2)
        }
    }
}

private struct ClashRadio: View {
    let chosen: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: chosen ? "largecircle.fill.circle" : "circle").foregroundStyle(chosen ? Color.signal : Look.ink2)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - the rules

struct ClashRulesCard: View {
    let view: ClashView
    let actions: ClashActions

    var body: some View {
        ClashCard {
            // With several subscriptions the groups and rules are AgentSwitch's alone (§10): on, and not to be turned off.
            if view.together == true {
                ClashSwitch(title: "Only My Rules", detail: "有多份订阅时，分组和规则都由 AgentSwitch 生成", isOn: .constant(true), held: true)
            } else {
                ClashSwitch(title: "Only My Rules", detail: view.settings.ownRules ? "订阅的分组和规则都不用了，只留它的节点" : "订阅自己的分组和规则排在这些后面", isOn: setting(\.ownRules))
            }
            ForEach(ClashTemplate.allCases, id: \.self) { template in
                // The domestic template is on while only these rules are: without it everything at home goes by Manual.
                let held = template == .domestic && view.ownRules
                ClashSwitch(title: template.title, detail: detail(template), isOn: Binding(get: { held || view.settings.templates[template].on }, set: { on in
                    var next = view.settings
                    next.templates[template].on = on
                    actions.save(next)
                }), held: held) { ClashButton("Edit…") { actions.edit(template) } }
            }
            ClashSwitch(title: "DNS", detail: view.dns.custom ? "Edited" : "Template", isOn: setting(\.dns.on)) { ClashButton("Edit…", action: actions.editDNS) }
            if view.dns.on, view.dns.overridden {
                ClashNote(text: "Clash Verge 自己的“DNS 覆写”开着：内核用的是它那一份，这里的 DNS 不起作用。").clashRow()
            }
        }
    }

    private func setting(_ path: WritableKeyPath<ClashSettings, Bool>) -> Binding<Bool> {
        Binding(get: { view.settings[keyPath: path] }, set: { on in
            var next = view.settings
            next[keyPath: path] = on
            actions.save(next)
        })
    }

    private func detail(_ template: ClashTemplate) -> String? {
        guard let state = view.state(template) else { return nil }
        return ClashText.rules(state.count) + (state.custom ? " · Edited" : "")
    }
}

struct ClashDirectCard: View {
    let view: ClashView
    let actions: ClashActions
    @State private var address = ""

    var body: some View {
        ClashCard(title: "Go Direct") {
            ForEach(view.settings.direct, id: \.self) { item in
                HStack {
                    Text(item).code(12.5)
                    Spacer()
                    Button { change { $0.removeAll { $0 == item } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.plain).foregroundStyle(Look.ink2).help("Remove")
                }
                .clashRow()
            }
            HStack(spacing: 10) {
                ClashField(prompt: "IP or Host", text: $address, mono: true, submit: add)
                ClashButton("Add", action: add).disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .clashRow()
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

// MARK: - the routing check

/// Whether each kind of traffic goes where its rule sends it, seen on the running core (docs/clash-v0.md §7.9).
struct ClashCheckCard: View {
    let rows: [ClashCheckRow]?
    let checking: Bool
    let actions: ClashActions

    var body: some View {
        ClashCard {
            ForEach(rows ?? []) { row in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: row.ok == true ? "checkmark.circle" : row.ok == false ? "xmark.circle" : "circle.dotted")
                        .foregroundStyle(row.ok == true ? Color.ok : row.ok == false ? Color.failed : Look.faint)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(row.title)
                            Text(row.host).foregroundStyle(Look.ink2)
                            Spacer()
                            if let seen = row.seen { Text(seen).monospacedDigit().foregroundStyle(Look.ink2) }
                        }
                        Text(row.route).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(2)
                        if let problem = row.problem { Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed) }
                    }
                }
                .clashRow()
            }
            HStack(spacing: 10) {
                ClashButton(rows == nil ? "Check Routing" : "Check Again", action: actions.check).disabled(checking)
                if checking { ProgressView().controlSize(.small) }
                Spacer()
            }
            .clashRow()
        }
    }
}
