import AgentSwitchMacCore
import AppKit
import SwiftUI

// The main window's third page, Browser (docs/browser-v0.md §1 Mac; demo `docs/design/implemented/browser.html`, "MAC ·
// MAIN WINDOW, THIRD PAGE"): on the left the tabs grouped by owner — the terminals' agents, the tasks, yours — each with
// its status mark, title and place; on the right the address bar (‹ › ↻, the address as text, a click to edit it, ↩ to
// go, the lock for https) and the live screen (BrowserScreenView). The tab's hold — whose tab it is, what an agent waits
// for, `[ Fill Ciphertext ]` while this Mac drives an http(s) page of your own, `[ Take Over ]` / `[ Hand Back ]` — was the
// page's footer; since 2026-10-03 (proposal B, docs/dispatch-v0.md §1) it is the right of the window's status bar
// (BrowserHoldItems, drawn by MainStatusBar), the page's zoom after it (BrowserZoomItems). Always dark, as the
// Terminals page. The data and the actions are BrowserPageModel's.
// The list is a side column as on Terminals (2026-10-03, BrowserSide): its edge drags it wider or narrower, past
// the left it closes with nothing left; the bar's list button and ⌘B open and close it.

struct BrowserPage: View {
    let model: BrowserPageModel
    /// The column while its edge is dragged (shown at once, kept when let go).
    @State private var dragging: BrowserSide?
    /// The classic look gives the list and the address bar grounds of their own (docs/ui-v0.md §8).
    @Environment(\.interfaceLook) private var look

    /// The page as the window's container holds it: dark whatever the system's look.
    static func host(_ model: BrowserPageModel) -> NSView {
        let host = NSHostingView(rootView: BrowserPage(model: model).environment(\.colorScheme, .dark).tint(.brand).followsWindow())
        host.appearance = NSAppearance(named: .darkAqua)
        return host
    }

    var body: some View {
        GeometryReader { proxy in
            let pageWidth = Double(proxy.size.width)
            let side = dragging ?? model.side
            HStack(spacing: 0) {
                // While a drag closes it the column stays, at no width, so its edge goes on following the pointer.
                if !model.side.closed || dragging != nil {
                    column(width: side.shown(pageWidth: pageWidth), pageWidth: pageWidth)
                        .zIndex(1)
                }
                main
            }
        }
        .background(Color.black)
        .sheet(item: Binding(get: { model.fillTarget }, set: { model.fillTarget = $0 })) { target in
            BrowserFillSheet(model: model, target: target)
        }
    }

    private func column(width: Double, pageWidth: Double) -> some View {
        BrowserTabListView(model: model)
            .frame(width: width)
            .background(look.isClassic ? Look.sidebar : Color.clear)
            .clipped()
            .overlay(alignment: .trailing) {
                BrowserSideEdge(dragging: dragging != nil,
                                width: { width },
                                drag: { x in dragging = model.side.dragged(to: x, pageWidth: pageWidth) },
                                drop: { x in
                                    model.side = model.side.dragged(to: x, pageWidth: pageWidth)
                                    dragging = nil
                                },
                                reset: { model.side = model.side.reset() })
            }
    }

    private var main: some View {
        VStack(spacing: 0) {
            // Tabs with windows of their own (docs/browser-v0.md §7.2): the selected tab's details; its page, its
            // address bar and its picture are in its window.
            if model.windows, model.current != nil {
                BrowserDetailPane(model: model)
            } else {
                if !model.windows { BrowserAddressBar(model: model).background(look.isClassic ? Look.ground : Color.clear) }
                screen
            }
        }
        // The new tab box, over the screen under the address bar.
        .overlay(alignment: .top) {
            if model.composing {
                ZStack(alignment: .top) {
                    // A click beside the box closes it.
                    Color.black.opacity(0.001).onTapGesture { model.composing = false }
                    BrowserNewTabBox(model: model).padding(.top, 44).padding(.horizontal, 24)
                }
            }
        }
        // The identity and engine box, over the lower right corner: above the status bar's item that opens it.
        .overlay(alignment: .bottomTrailing) {
            if model.identity.open {
                ZStack(alignment: .bottomTrailing) {
                    Color.black.opacity(0.001).onTapGesture { model.identity.open = false }
                    BrowserIdentityBox(model: model.identity).padding(.trailing, 12).padding(.bottom, 8).padding(.top, 8)
                }
            }
        }
    }

    private var screen: some View {
        ZStack {
            BrowserScreenHost(view: model.screen)
            if model.current == nil {
                Color.black
                empty
            } else if !model.hasFrame, !model.windows {
                BrailleSpinner().accessibilityLabel("Loading")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var empty: some View {
        if let problem = model.problem {
            Text(problem).font(.system(size: 13)).foregroundStyle(Look.ink2).multilineTextAlignment(.center).padding(24)
        } else if model.loaded {
            VStack(spacing: 14) {
                Text("还没有打开的标签。").font(.system(size: 13)).foregroundStyle(Look.ink2)
                Button { model.composeNew() } label: { BracketLabel(word: "+ New Tab", key: "⌘T") }
                    .buttonStyle(BracketButtonStyle())
            }
        }
    }
}

// MARK: - the list

/// The tabs by owner (`// codex · AgentSwitch`, a task's title, `// You`), the one on screen raised with the signal bar.
private struct BrowserTabListView: View {
    let model: BrowserPageModel

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // Which browser the list is of, when there is more than the shared one (docs/profiles-v0.md §5.2).
                if model.browsers.count > 1 { BrowserChooser(model: model) }
                ForEach(model.list.groups, id: \.owner.key) { group in
                    BrowserGroupLabel(owner: group.owner)
                    ForEach(group.tabs) { tab in
                        BrowserTabRow(tab: tab, selected: tab.id == model.selectedID,
                                      select: { model.select(tab.id) },
                                      close: { Task { await model.close(tab.id) } },
                                      tag: model.windows ? BrowserWindowText.tag(tab) : nil,
                                      open: model.windows ? { Task { await model.showWindow(tab.id) } } : nil)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .scrollIndicators(.never)
    }
}

/// The browsers there are, at the head of the tab list: the shared one and each profile's own, the one on the page
/// marked. A click shows that browser's tabs.
private struct BrowserChooser: View {
    let model: BrowserPageModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.browsers) { choice in
                BrowserChoiceRow(choice: choice, selected: choice.key == model.browserKey) { model.show(browser: choice.key) }
            }
            Rectangle().fill(Look.line).frame(height: 1).padding(.horizontal, look.isClassic ? 8 : 16).padding(.top, 6)
        }
        .padding(.top, 2)
    }
}

private struct BrowserChoiceRow: View {
    let choice: BrowserChoice
    let selected: Bool
    let pick: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 8) {
            // The one on the page, a filled square; the others hollow.
            Text(selected ? "■" : "□").mono(11).foregroundStyle(selected ? Color.signal : Look.faint).frame(width: 12)
            Text(choice.name).font(.system(size: 12.5, weight: selected ? .semibold : .regular)).foregroundStyle(selected ? Look.ink : Look.ink2).lineLimit(1)
            Spacer(minLength: 0)
            // Where a profile's browser leaves this Mac from.
            if let exit = choice.exit { Text(exit.text).mono(11).foregroundStyle(Look.faint).lineLimit(1).truncationMode(.middle) }
        }
        .padding(.horizontal, look.isClassic ? 8 : 16)
        .padding(.vertical, 5)
        .grounded(hovering && !selected ? Look.hover : Color.clear, radius: 8)
        .padding(.horizontal, look.isClassic ? 8 : 0)
        .contentShape(Rectangle())
        .onTapGesture(perform: pick)
        .onHover { hovering = $0 }
        .help(choice.key == nil ? "The browser every agent without a proxy of its own shares" : "\(choice.name)’s own browser")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

extension BrowserOwner {
    /// One group per owner.
    var key: String { "\(kind.rawValue):\(id)" }
}

private struct BrowserGroupLabel: View {
    let owner: BrowserOwner
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 8) {
            AgentSprite(harness: owner.harness)
            // `// codex · AgentSwitch`; a plain small heading in the classic look (docs/ui-v0.md §8).
            if look.isClassic {
                Text(BrowserTabText.group(owner)).font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail)
            } else {
                Text("// \(BrowserTabText.group(owner))").font(.system(size: 11, design: .monospaced)).tracking(0.44)
                    .foregroundStyle(Look.faint).lineLimit(1).truncationMode(.tail)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }
}

private struct BrowserTabRow: View {
    let tab: BrowserTab
    let selected: Bool
    let select: () -> Void
    let close: () -> Void
    /// The word at the row's end (windows only), and what a double click does there (the tab's window to the front).
    var tag: String?
    var open: (() -> Void)?
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 10) {
            BrowserStatusMark(status: tab.status).frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(BrowserTabText.title(tab)).font(.system(size: 13, weight: .semibold)).foregroundStyle(Look.ink)
                    .lineLimit(1).truncationMode(.tail)
                // A path loses its middle; what an agent waits for keeps its start.
                second.mono(11).foregroundStyle(Look.ink2).lineLimit(1)
                    .truncationMode(BrowserTabText.waiting(tab) == nil ? .middle : .tail)
            }
            Spacer(minLength: 0)
            // Who holds it, where tabs have windows: `You` once you stepped into an agent's, `On iPhone`.
            if let tag {
                Text(tag).mono(11).foregroundStyle(tag == "You" ? Color.signal : Color.waiting).lineLimit(1).fixedSize()
            }
        }
        .padding(.horizontal, look.isClassic ? 8 : 16)
        .padding(.vertical, 7)
        // The tab on screen: a raised ground behind a signal line; a round highlight in the classic look.
        .grounded(selected ? Look.raised : (hovering ? Look.hover : Color.clear), radius: 8)
        .overlay(alignment: .leading) { if selected && !look.isClassic { Rectangle().fill(Color.signal).frame(width: 3) } }
        .padding(.horizontal, look.isClassic ? 8 : 0)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { select(); open?() }
        .onTapGesture(perform: select)
        .onHover { hovering = $0 }
        .help(tab.url)
        .contextMenu {
            Button(action: close) { Label("Close Tab", systemImage: "xmark").labelStyle(.titleAndIcon) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// `等你：短信验证码 · portal.example.com`: what the agent waits for in amber, then the place.
    private var second: Text {
        let place = Text(BrowserTabText.place(tab))
        guard let waiting = BrowserTabText.waiting(tab) else { return place }
        return Text(waiting).foregroundColor(.waiting) + Text(" · ") + place
    }
}

/// The spinner while an agent operates the tab, the blinking amber square while it waits for you, hollow otherwise.
struct BrowserStatusMark: View {
    let status: BrowserTabStatus

    var body: some View {
        switch status {
        case .busy: BrailleSpinner()
        case .waiting: BlinkingSquare()
        case .idle: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim).accessibilityLabel("Idle")
        }
    }
}

// MARK: - the address bar

private struct BrowserAddressBar: View {
    let model: BrowserPageModel
    @State private var editing = false
    @State private var text = ""
    @FocusState private var focused: Bool
    @Environment(\.interfaceLook) private var look

    static let prompt = BrowserAddressBarPrompt.text

    var body: some View {
        let tab = model.current
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                BarGlyph(glyph: "‹", symbol: "chevron.left", help: "Back ⌘[") { Task { await model.history(.back) } }
                BarGlyph(glyph: "›", symbol: "chevron.right", help: "Forward ⌘]") { Task { await model.history(.forward) } }
            }
            .disabled(tab == nil)
            field(tab)
            if tab?.loading == true {
                BrailleSpinner().frame(width: 22)
            } else {
                BarGlyph(glyph: "↻", symbol: "arrow.clockwise", help: "Reload ⌘R") { Task { await model.history(.reload) } }.disabled(tab == nil)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .onChange(of: model.addressRequests) { startEditing() }
        .onChange(of: focused) { if !focused { editing = false } }
        .onChange(of: model.selectedID) { editing = false }
    }

    private func field(_ tab: BrowserTab?) -> some View {
        HStack(spacing: 6) {
            if editing {
                TextField("", text: $text, prompt: Text(Self.prompt).foregroundColor(Look.faint))
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .onSubmit(submit)
                    .onExitCommand(perform: stopEditing)
            } else {
                if let tab, BrowserAddress.isSecure(tab.url) {
                    PixelSprite(rows: PixelArt.lock, pixel: 2, color: Look.faint, strength: 0.6, shadow: false, picture: .lockSmall).help("HTTPS")
                }
                let shown = tab.map { BrowserAddress.display($0.url) } ?? ""
                Text(shown.isEmpty ? Self.prompt : shown)
                    .foregroundStyle(shown.isEmpty ? Look.faint : Look.ink)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
        }
        .mono(look.isClassic ? 12.5 : 11.5)
        .padding(.horizontal, look.isClassic ? 10 : 8)
        .frame(height: look.isClassic ? 26 : 24)
        // A framed line; a round field on its own ground in the classic look, ringed while it is typed in.
        .grounded(look.isClassic ? Look.raised : Color.clear, radius: 8)
        .framed(look.isClassic ? (editing ? Color.signal : Color.clear) : (editing ? Look.ink2 : Look.line), radius: 8)
        .contentShape(Rectangle())
        .onTapGesture { if !editing { startEditing() } }
        .help(tab?.url ?? "")
    }

    private func startEditing() {
        text = BrowserAddress.editing(model.current?.url ?? "")
        editing = true
        DispatchQueue.main.async { focused = true }
    }

    private func stopEditing() {
        editing = false
        model.screen.window?.makeFirstResponder(model.screen)
    }

    private func submit() {
        let typed = text
        editing = false
        Task { await model.go(typed) }
    }
}

/// `‹` `›` `↻`: a monospaced glyph that brightens under the pointer; the system's symbol in the classic look.
private struct BarGlyph: View {
    let glyph: String
    let symbol: String
    let help: String
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            LookGlyph(glyph: glyph, symbol: symbol, size: 16)
                .foregroundStyle(enabled && hovering ? Look.ink : Look.ink2)
                .opacity(enabled ? 1 : 0.4)
                .frame(width: look.isClassic ? 24 : 20, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(ClassicWords.help(help, in: look))
        .accessibilityLabel(help)
    }
}

// MARK: - the hold (the status bar's right on Browser)

/// Whose tab it is, what is going on, `[ Fill Ciphertext ]` while this Mac drives an http(s) page of yours (nobody else
/// holding it; never an agent's, even taken over), and the hold: `[ Take Over ]` for an agent's tab (filled while it
/// waits for you), `[ Hand Back ]` while this Mac holds it (both also ⌘⇧T, `hold()`). Your own tab held here is simply on
/// this screen (尺寸有主): `You`, nothing to hand back. Once the page's footer; the window's status bar since 2026-10-03.
struct BrowserHoldItems: View {
    let model: BrowserPageModel

    var body: some View {
        if let tab = model.current {
            let holder = BrowserScreenPolicy.footerHolder(tab, screen: model.screenID)
            HStack(spacing: 14) {
                owner(tab, holder: holder)
                if let note = model.note ?? model.problem {
                    Text(note).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail).help(note)
                } else if case .elsewhere? = holder {
                    Text("其他屏幕已接手此标签。").foregroundStyle(Look.ink2).lineLimit(1)
                } else if let waiting = BrowserTabText.waiting(tab) {
                    Text(waiting).foregroundStyle(Color.waiting).lineLimit(1).truncationMode(.tail)
                }
                if model.canFill {
                    Button { model.openFill() } label: { BracketLabel(word: "Fill Ciphertext") }
                        .buttonStyle(BracketButtonStyle(size: 12))
                        .help("从密文填入页面中当前的输入框")
                }
                hold(tab, holder: holder)
            }
            .mono(11.5)
            .foregroundStyle(Look.ink2)
        }
    }

    @ViewBuilder
    private func owner(_ tab: BrowserTab, holder: BrowserHolder?) -> some View {
        if holder == .thisMac {
            HStack(spacing: 7) {
                PixelSprite(rows: PixelArt.square, pixel: 2, color: .signal)
                Text(BrowserTabText.heldHere(tab)).lineLimit(1)
            }
            .foregroundStyle(Color.signal)
        } else if tab.owner.isAgent {
            HStack(spacing: 7) {
                AgentSprite(harness: tab.owner.harness)
                Text(BrowserTabText.group(tab.owner)).lineLimit(1).truncationMode(.tail)
            }
        } else {
            Text("You")
        }
    }

    @ViewBuilder
    private func hold(_ tab: BrowserTab, holder: BrowserHolder?) -> some View {
        switch holder {
        case .thisMac?:
            Button { Task { await model.handBack() } } label: { BracketLabel(word: "Hand Back") }
                .buttonStyle(BracketButtonStyle(size: 12))
        case .elsewhere?:
            Button { Task { await model.takeOver() } } label: { BracketLabel(word: "Take Over") }
                .buttonStyle(BracketButtonStyle(size: 12))
        case nil where tab.owner.isAgent:
            Button { Task { await model.takeOver() } } label: { BracketLabel(word: "Take Over") }
                .buttonStyle(BracketButtonStyle(role: tab.status == .waiting ? .primary : .normal, size: 12))
        case nil:
            EmptyView()
        }
    }
}

// MARK: - a new tab

/// `+` (the bar, ⌘T, the empty page): an address, a recent one, or one of the Mac's local servers.
private struct BrowserNewTabBox: View {
    let model: BrowserPageModel
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        FloatingBox(title: "New Tab", trailing: "esc", waiting: false) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    TextField("", text: $text, prompt: Text(BrowserAddressBarPrompt.text).foregroundColor(Look.faint))
                        .textFieldStyle(.plain)
                        .mono(12.5)
                        .focused($focused)
                        .onSubmit { open(.typed(text)) }
                    if model.opening { BrailleSpinner() }
                }
                .padding(.horizontal, 8)
                .frame(height: 28)
                .framed(Look.ink2, radius: Look.controlRadius)
                if let error = model.openError {
                    Text(error).font(.system(size: 12)).foregroundStyle(Color.failed).fixedSize(horizontal: false, vertical: true)
                }
                if !model.recents.isEmpty {
                    PartLabel("Recent").padding(.top, 2)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.recents, id: \.self) { entry in
                            ChoiceRow(text: BrowserAddress.display(entry).isEmpty ? entry : BrowserAddress.display(entry)) { open(.typed(entry)) }
                        }
                    }
                }
                PartLabel("Local Servers on This Mac").padding(.top, 2)
                servers
            }
            .padding(12)
        }
        .frame(maxWidth: 560)
        .onAppear { focused = true }
        .onExitCommand { model.composing = false }
    }

    @ViewBuilder
    private var servers: some View {
        if model.serversLoading && model.servers.isEmpty {
            BrailleSpinner().padding(.leading, 6)
        } else if let note = model.serversNote {
            Text(note).font(.system(size: 12)).foregroundStyle(Look.ink2)
        } else if model.servers.isEmpty {
            Text("未发现正在监听的本地服务。").font(.system(size: 12)).foregroundStyle(Look.ink2)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(model.servers) { server in
                    ChoiceRow(text: BrowserTabText.server(server, home: NSHomeDirectory()), mark: true) { open(.port(server.port)) }
                }
            }
        }
    }

    private func open(_ target: BrowserTarget) {
        if case .typed(let typed) = target, typed.trimmingCharacters(in: .whitespaces).isEmpty { return }
        Task { await model.open(target) }
    }
}

/// The address field's prompt (the bar's and the new tab box's).
enum BrowserAddressBarPrompt {
    static let text = "网址、Mac 上的路径或 localhost:5173"
}

/// One choice in the new tab box: monospaced, inverted under the pointer; a local server with its green square.
private struct ChoiceRow: View {
    let text: String
    var mark = false
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        // Inverted under the pointer; in the classic look a round highlight in the accent, as a menu's.
        let over: Color = look.isClassic ? .white : Look.ground
        Button(action: action) {
            HStack(spacing: 8) {
                if mark { PixelSprite(rows: PixelArt.square, pixel: 2, color: hovering ? over : .ok) }
                Text(text).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .mono(12)
            .foregroundStyle(hovering ? over : Look.ink)
            .padding(.horizontal, 6)
            .frame(height: look.isClassic ? 24 : 22)
            .grounded(hovering ? (look.isClassic ? Color.signal : Look.ink) : Color.clear, radius: 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The screen, as the model holds it (SwiftUI only places it).
private struct BrowserScreenHost: NSViewRepresentable {
    let view: BrowserScreenView
    func makeNSView(context: Context) -> BrowserScreenView { view }
    func updateNSView(_ view: BrowserScreenView, context: Context) {}
}
