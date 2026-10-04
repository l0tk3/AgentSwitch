import AgentSwitchKit
import SwiftUI

/// Where the Browser tab leads by value: one tab's page.
enum BrowserRoute: Hashable {
    case tab(BrowserTabInfo)
}

/// The Browser tab (docs/browser-v0.md §1, demo page `docs/design/implemented/browser.html`): the tabs of the browser on
/// the Mac grouped by who holds them — terminals' agents (`// codex · AgentSwitch`), dispatched tasks (their title),
/// then yours (`// You`). Each row: the status (the spinner while an agent works on it, a blinking amber square while it
/// waits for you, with why; hollow when idle), the title and where it is. A tap opens it; a long press opens its menu,
/// a swipe closes it. Under them the servers listening on the Mac. `+` opens a new tab.
struct BrowserTab: View {
    @Environment(AppModel.self) private var model
    /// The classic look writes a group's label without the slashes (docs/ui-v0.md §8).
    @Environment(\.interfaceLook) private var look
    @State private var path = NavigationPath()
    @State private var creating = false
    @State private var menuFor: RowMenu?
    @State private var closing: BrowserTabInfo?
    @State private var opening: Int?
    /// Why closing or opening failed: a box over whatever is open.
    @State private var failure: String?

    var body: some View {
        let store = model.browser
        NavigationStack(path: $path) {
            List {
                Group {
                    if model.connection.endpoint == nil { ConnectionBanner() }
                    if store.unsupported {
                        Text("此 Mac 上的 AgentSwitch 未提供浏览器：版本过旧，或浏览器已关闭。").font(.footnote).foregroundStyle(.secondary)
                    } else if let error = store.error {
                        Text(error).font(.footnote).foregroundStyle(Theme.failed)
                    }
                    if store.list != nil && store.tabs.isEmpty {
                        Text("还没有打开的标签。").font(.footnote).foregroundStyle(.secondary).padding(.vertical, 24)
                    }
                    ForEach(store.list?.groups ?? []) { group in
                        groupLabel(group.owner)
                        ForEach(group.tabs) { tab in
                            TabRow(tab: tab, open: { path.append(BrowserRoute.tab(tab)) },
                                   menu: { anchor in menuFor = RowMenu(tab: tab, anchor: anchor) })
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button("Close Tab", systemImage: "xmark", role: .destructive) { askToClose(tab) }
                                }
                        }
                    }
                    if !store.servers.isEmpty { servers(store) }
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 0, leading: Theme.Space.l, bottom: 0, trailing: Theme.Space.l))
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 1)
            .background { ZStack { Theme.base; Scanlines() }.ignoresSafeArea() }
            .safeAreaInset(edge: .top, spacing: 0) { HairRule() }
            .navigationTitle("Browser")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 7) {
                        PixelSprite(rows: PixelArt.globe, pixel: 1, color: Theme.ink, strength: 1, shadow: false, cell: 0.7)
                        Text("Browser").font(.headline)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: { LookGlyph(glyph: "+", symbol: "plus", size: 20, weight: .regular) }
                        .disabled(model.api == nil || store.unsupported)
                        .accessibilityLabel("New Tab")
                }
            }
            .navigationDestination(for: BrowserRoute.self) { route in
                switch route {
                case .tab(let tab): BrowserPage(tab: tab)
                }
            }
            .refreshable {
                await store.refreshList(model.api)
                await store.refreshServers(model.api)
            }
            // The list itself is read from every tab (MainTabs). The servers once as the tab comes on screen (and on
            // pulling down, and in `+`): listing them runs `lsof` on the Mac, not worth a timer.
            .task(id: model.connection.endpoint) { await store.refreshServers(model.api) }
            .onAppear { openRequested() }
            .onChange(of: model.openBrowserRequest) { openRequested() }
            .onChange(of: store.list == nil) { openRequested() }
            .sheet(isPresented: $creating) {
                NewBrowserTabSheet { tab in
                    store.add(tab)
                    path.append(BrowserRoute.tab(tab))
                }
            }
            .pixelBox(item: $menuFor) { m in
                PixelBox(cancel: nil, actions: [.init(label: "Copy URL") { UIPasteboard.general.string = m.tab.url },
                                                .init(label: "Close Tab", role: .destructive) { askToClose(m.tab) }],
                         anchor: m.anchor)
            }
            .pixelBox(item: $closing) { tab in
                PixelBox(head: "Close Tab", tone: .red,
                         message: "关闭「\(tab.displayTitle)」？\(tab.owner.label) 正在使用此标签，关闭后它对此标签的操作将失败。",
                         actions: [.init(label: "Close", role: .primary) { Task { await close(tab) } }])
            }
        }
        .pixelBox(item: $failure) { message in
            PixelBox(head: "Error", tone: .red, message: message, cancel: nil, actions: [.init(label: "OK", role: .primary) {}])
        }
    }

    /// `// codex · AgentSwitch` with the agent's mark, `// 登录财务平台下载对账单`, `// You`.
    private func groupLabel(_ owner: BrowserTabOwner) -> some View {
        HStack(spacing: 8) {
            if owner.isAgent, let harness = model.harness(of: owner), let rows = PixelArt.agents[harness] {
                PixelSprite(rows: rows, pixel: 2, color: .secondary, strength: 0.8, shadow: false)
            }
            groupWords(owner.label).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.top, Theme.Space.l)
        .padding(.bottom, 4)
        .accessibilityAddTraits(.isHeader)
    }

    /// `// label`, close-set; a plain small heading in the classic look.
    private func groupWords(_ text: String) -> some View {
        Text(ClassicWords.label(text, in: look)).mono(look.isClassic ? 13 : 11, weight: look.isClassic ? .semibold : .regular)
            .tracking(look.isClassic ? 0 : 0.4).foregroundStyle(.secondary)
    }

    /// The servers listening on the Mac: a tap opens one.
    @ViewBuilder
    private func servers(_ store: BrowserStore) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HairRule().padding(.top, Theme.Space.l)
            groupWords("Local Servers on \(model.profile?.name ?? "Mac")")
                .padding(.top, Theme.Space.m).padding(.bottom, 4)
        }
        ForEach(store.servers) { server in
            Button { Task { await openServer(server) } } label: { ServerRow(server: server, opening: opening == server.port) }
                .buttonStyle(.plain)
                .disabled(opening != nil)
        }
    }

    private func askToClose(_ tab: BrowserTabInfo) {
        if tab.owner.isAgent { closing = tab } else { Task { await close(tab) } }
    }

    private func close(_ tab: BrowserTabInfo) async {
        guard let api = model.api else { return }
        do {
            try await api.closeBrowserTab(tab.id)
            model.browser.remove(tab.id)
        } catch {
            failure = error.localizedDescription
        }
    }

    private func openServer(_ server: BrowserLocalServer) async {
        guard let api = model.api else { return }
        opening = server.port
        defer { opening = nil }
        do {
            let tab = try await api.openBrowserTab(.port(server.port))
            model.browser.add(tab)
            path.append(BrowserRoute.tab(tab))
        } catch {
            failure = error.localizedDescription
        }
    }

    /// `new`, or a tab (a demo screen, later the Live Activity) in place of the page open now.
    private func openRequested() {
        guard let id = model.openBrowserRequest else { return }
        if id == "new" { model.openBrowserRequest = nil; creating = true; return }
        guard let list = model.browser.list else { return }
        model.openBrowserRequest = nil
        if let tab = list.tabs.first(where: { $0.id == id }) { path = NavigationPath([BrowserRoute.tab(tab)]) }
    }

    private struct RowMenu: Equatable {
        let tab: BrowserTabInfo
        let anchor: CGRect
    }
}

/// A tab's state in pixels: the spinner while an agent works on it, a blinking amber square while it waits for you,
/// hollow when idle.
struct BrowserStatusMark: View {
    let status: BrowserTabStatus
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch status {
        case .busy: BrailleSpinner()
        case .waiting:
            if look.isClassic { ClassicWaitingDot() } else { PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting).waitingBlink() }
        default: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Theme.inkDim)
        }
    }
}

/// One tab: its status, its title, and where it is (why it waits first, in amber). A tap opens it; a long press lights
/// the row and opens its menu by it.
private struct TabRow: View {
    let tab: BrowserTabInfo
    let open: () -> Void
    let menu: (CGRect) -> Void
    @State private var held = false
    @State private var frame = FrameRef()

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            BrowserStatusMark(status: tab.status).frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                Text(tab.displayTitle).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                place
            }
            Spacer(minLength: 6)
            LookGlyph.onward().foregroundStyle(.tertiary)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 4)
        .background(held ? Theme.raised : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .onLongPressGesture(minimumDuration: 0.45) {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            menu(frame.rect)
        } onPressingChanged: { held = $0 }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame.rect = $0 }
        .runningGlitch(tab.status == .busy)
        .glitch(on: tab.status, when: { $0 == .waiting })
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(tab.status.label)
    }

    private var place: some View {
        let site = tab.kind == .blank ? "about:blank" : tab.site
        return (Text(tab.waitingReason.map { "\($0) · " } ?? "").foregroundStyle(Theme.waiting) + Text(site).foregroundStyle(.secondary))
            .mono(11)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    /// Where the row is on the screen, kept without redrawing (read when its menu opens).
    private final class FrameRef {
        var rect: CGRect = .zero
    }
}

/// `■ localhost:5173 · vite · ~/Projects/site`.
private struct ServerRow: View {
    let server: BrowserLocalServer
    let opening: Bool

    var body: some View {
        HStack(spacing: 8) {
            if opening { BrailleSpinner(color: .secondary) } else { PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done) }
            Text(["localhost:\(server.port)", server.name, MacPath.tilde(server.cwd)].filter { !$0.isEmpty }.joined(separator: " · "))
                .mono(11).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityHint("在新标签中打开")
    }
}

extension AppModel {
    /// The agent's name as people call it (`Codex`, `Claude Code`), else the owner's label.
    func agentName(of owner: BrowserTabOwner) -> String { owner.agentName(harness: harness(of: owner)) }

    /// The agent behind a tab: its terminal's or its task's, else as its label names it.
    func harness(of owner: BrowserTabOwner) -> String? {
        switch owner.kind {
        case .terminal: return terminals.terminals.first { $0.id == owner.id }?.harness ?? owner.namedHarness
        case .task: return tasks.first { $0.id == owner.id }?.harness ?? owner.namedHarness
        default: return owner.namedHarness
        }
    }
}
