import AgentSwitchMacCore
import SwiftUI

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

/// Clash Integration (docs/clash-v0.md §6): which of Clash Verge's subscriptions AgentSwitch works from, the
/// nodes for Claude and for OpenAI in their order, the addresses that go direct — and, until Clash Verge runs the
/// subscription AgentSwitch makes with TUN on, what is still to do there.
struct ClashIntegrationView: View {
    @Environment(AppModel.self) private var model
    /// The page is on screen: what Clash Verge runs is asked for only then.
    var shown = true
    var demo: ClashView?
    @State private var loaded: ClashView?
    private var view: ClashView? { loaded ?? demo }
    @State private var error: String?
    @State private var address = ""

    var body: some View {
        Form {
            if let view {
                status(view)
                if view.found {
                    source(view)
                    service("Separate Proxy for Claude", view: view, at: \.claude)
                    service("Separate Proxy for OpenAI", view: view, at: \.openai)
                    direct(view)
                }
            } else {
                Section { Text(error ?? "Reading…").foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
        .task(id: shown) {
            // What Clash Verge runs changes there, not here: looked at again every few seconds while the page shows.
            while shown, !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    @ViewBuilder private func status(_ view: ClashView) -> some View {
        Section {
            ForEach(view.todo, id: \.self) { step in
                Label(step, systemImage: "exclamationmark.circle").foregroundStyle(.orange)
            }
            if view.todo.isEmpty { Label("Clash Verge 正在使用 AgentSwitch 的订阅，TUN 已打开。", systemImage: "checkmark.circle").foregroundStyle(.green) }
            if view.found, view.settings.source != nil, !view.active {
                Button("Add to Clash Verge…") { if let url = URL(string: view.install) { NSWorkspace.shared.open(url) } }
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
        } header: {
            Text("Clash Verge")
        } footer: {
            Footer("AgentSwitch 把你选的订阅原样拿来，在最前面加上它自己的分组和规则，在本机提供给 Clash Verge（只有这台 Mac 读得到）。不改 Clash Verge 的任何文件；不想用了，切回原来的订阅或删掉 AgentSwitch 这一个即可。")
        }
    }

    @ViewBuilder private func source(_ view: ClashView) -> some View {
        Section {
            Picker("Work From", selection: Binding(get: { view.settings.source ?? "" }, set: { uid in change(view) { $0.source = uid.isEmpty ? nil : uid } })) {
                Text("None").tag("")
                ForEach(view.profiles.filter { $0.name != "AgentSwitch" }) { profile in Text(profile.name).tag(profile.uid) }
            }
        } footer: {
            Footer("底本：AgentSwitch 在哪个订阅的基础上加东西。节点的地址和密码仍只在 Clash Verge 的那个文件里，AgentSwitch 不另存。")
        }
    }

    @ViewBuilder private func service(_ title: String, view: ClashView, at path: WritableKeyPath<ClashSettings, ClashServiceProxy>) -> some View {
        let proxy = view.settings[keyPath: path]
        Section {
            ForEach(proxy.nodes, id: \.self) { node in
                HStack(spacing: 8) {
                    Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary)
                    Text(node).lineLimit(1)
                    Spacer()
                    if proxy.mode == "manual" {
                        Button { change(view) { $0[keyPath: path].picked = node } } label: {
                            Image(systemName: proxy.picked == node ? "largecircle.fill.circle" : "circle").foregroundStyle(proxy.picked == node ? Color.accentColor : Color.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    Button { change(view) { $0[keyPath: path].nodes.removeAll { $0 == node } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            .onMove { from, to in change(view) { $0[keyPath: path].nodes.move(fromOffsets: from, toOffset: to) } }
            Menu("Add Node…") {
                ForEach((view.nodes ?? []).filter { !proxy.nodes.contains($0) }, id: \.self) { node in
                    Button(node) { change(view) { $0[keyPath: path].nodes.append(node) } }
                }
            }
            .disabled(view.nodes?.isEmpty ?? true)
            if !proxy.nodes.isEmpty {
                Picker("Use", selection: Binding(get: { proxy.mode }, set: { mode in change(view) { $0[keyPath: path].mode = mode; if mode == "manual", $0[keyPath: path].picked == nil { $0[keyPath: path].picked = $0[keyPath: path].nodes.first } } })) {
                    Text("Automatic").tag("auto")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)
            }
        } header: {
            Text(title)
        } footer: {
            Footer(proxy.nodes.isEmpty ? "没有选节点：这类流量照你订阅里原有的规则走。" : "从上到下是优先级，拖动可以调整。Automatic：用排在最前、此刻连得上的那个；Manual：用你点选的那个。")
        }
    }

    @ViewBuilder private func direct(_ view: ClashView) -> some View {
        Section {
            ForEach(view.settings.direct, id: \.self) { item in
                HStack {
                    Text(item).font(.system(.body, design: .monospaced))
                    Spacer()
                    Button { change(view) { $0.direct.removeAll { $0 == item } } } label: { Image(systemName: "minus.circle") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            HStack {
                TextField("IP or Host", text: $address).onSubmit { add(view) }
                Button("Add") { add(view) }.disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        } header: {
            Text("Go Direct")
        } footer: {
            Footer("这些地址不经任何节点，直接连出去。用于配置里填的代理服务器：开着 TUN 时免得先绕一遍 Clash。改动立刻生效，不需要在 Clash Verge 里更新。")
        }
    }

    private func add(_ view: ClashView) {
        let item = address.trimmingCharacters(in: .whitespaces)
        guard !item.isEmpty else { return }
        address = ""
        change(view) { if !$0.direct.contains(item) { $0.direct.append(item) } }
    }

    private func load() async {
        do { loaded = try await model.client.clash(); error = nil }
        catch { if view == nil { self.error = (error as? DaemonError)?.reason ?? error.localizedDescription } }
    }

    /// One change to the settings, saved at once; what the service has afterwards is shown.
    private func change(_ view: ClashView, _ edit: (inout ClashSettings) -> Void) {
        var next = view.settings
        edit(&next)
        guard next != view.settings else { return }
        let client = model.client
        Task {
            do { loaded = try await client.saveClash(next); error = nil }
            catch { self.error = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }
}

#if DEBUG
extension ClashView {
    /// A made-up Clash Verge for the design preview: a subscription chosen, three nodes for Claude picked by hand, two
    /// for OpenAI, one address direct, and Clash Verge not yet on AgentSwitch's subscription.
    static let demo: ClashView = try! JSONDecoder().decode(ClashView.self, from: Data("""
    {"found":true,"running":true,"version":"v1.19.31","tun":false,"active":false,"upToDate":false,
     "nodes":["JP Tokyo 01","JP Tokyo 02","SG Singapore 01","US Los Angeles 01","US Seattle 02","HK Hong Kong 03"],
     "profiles":[{"uid":"Lbw7BJYzpand","name":"my-subscription.yaml","type":"local"}],"currentProfile":"Lbw7BJYzpand",
     "settings":{"source":"Lbw7BJYzpand","claude":{"nodes":["JP Tokyo 01","SG Singapore 01","US Seattle 02"],"mode":"manual","picked":"SG Singapore 01"},
                 "openai":{"nodes":["US Los Angeles 01","JP Tokyo 02"],"mode":"auto"},"direct":["203.0.113.7"]},
     "install":"clash://install-config?url=x"}
    """.utf8))
}
#endif
