import AgentSwitchMacCore
import AppKit
import SwiftUI

// The main window's third page, Browser (docs/browser-v0.md §1 Mac; demo `docs/design/implemented/browser.html`, "MAC ·
// MAIN WINDOW, THIRD PAGE"): on the left the tabs grouped by owner — the terminals' agents, the tasks, yours — each with
// its status mark, title and place; on the right the address bar (‹ › ↻, the address as text, a click to edit it, ↩ to
// go, the lock for https), the live screen (BrowserScreenView) and the footer (whose tab it is, what an agent waits for,
// `[ Fill Ciphertext ]` while this Mac drives an http(s) page of your own, `[ Take Over ]` / `[ Hand Back ]`). Always
// dark, as the Terminals page. The data and the actions are BrowserPageModel's.

struct BrowserPage: View {
    let model: BrowserPageModel

    /// The page as the window's container holds it: dark whatever the system's look.
    static func host(_ model: BrowserPageModel) -> NSView {
        let host = NSHostingView(rootView: BrowserPage(model: model).environment(\.colorScheme, .dark).tint(.brand).followsWindow())
        host.appearance = NSAppearance(named: .darkAqua)
        return host
    }

    var body: some View {
        HStack(spacing: 0) {
            BrowserTabListView(model: model)
                .frame(width: 270)
                .overlay(alignment: .trailing) { DottedColumnRule(color: Look.line) }
            VStack(spacing: 0) {
                BrowserAddressBar(model: model)
                screen
                BrowserFooter(model: model)
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
        }
        .background(Color.black)
        .sheet(item: Binding(get: { model.fillTarget }, set: { model.fillTarget = $0 })) { target in
            BrowserFillSheet(model: model, target: target)
        }
    }

    private var screen: some View {
        ZStack {
            BrowserScreenHost(view: model.screen)
            if model.current == nil {
                Color.black
                empty
            } else if !model.hasFrame {
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
                ForEach(model.list.groups, id: \.owner.key) { group in
                    BrowserGroupLabel(owner: group.owner)
                    ForEach(group.tabs) { tab in
                        BrowserTabRow(tab: tab, selected: tab.id == model.selectedID,
                                      select: { model.select(tab.id) },
                                      close: { Task { await model.close(tab.id) } })
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .scrollIndicators(.never)
    }
}

extension BrowserOwner {
    /// One group per owner.
    var key: String { "\(kind.rawValue):\(id)" }
}

private struct BrowserGroupLabel: View {
    let owner: BrowserOwner

    var body: some View {
        HStack(spacing: 8) {
            AgentSprite(harness: owner.harness)
            Text("// \(BrowserTabText.group(owner))").font(.system(size: 11, design: .monospaced)).tracking(0.44)
                .foregroundStyle(Look.faint).lineLimit(1).truncationMode(.tail)
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
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 10) {
            BrowserStatusMark(status: tab.status).frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(BrowserTabText.title(tab)).font(.system(size: 13, weight: .semibold)).foregroundStyle(Look.ink)
                    .lineLimit(1).truncationMode(.tail)
                // A path loses its middle; what an agent waits for keeps its start.
                second.font(.system(size: 11, design: .monospaced)).foregroundStyle(Look.ink2).lineLimit(1)
                    .truncationMode(BrowserTabText.waiting(tab) == nil ? .middle : .tail)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(selected ? Look.raised : (hovering ? Look.hover : Color.clear))
        .overlay(alignment: .leading) { if selected { Rectangle().fill(Color.signal).frame(width: 3) } }
        .contentShape(Rectangle())
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

/// A 1 px dotted rule down the side (2 on, 2 off), as the list's edge on the Terminals page.
private struct DottedColumnRule: View {
    var color: Color

    var body: some View {
        Canvas { context, size in
            var y: CGFloat = 0
            while y < size.height {
                context.fill(Path(CGRect(x: 0, y: y, width: 1, height: 2)), with: .color(color))
                y += 4
            }
        }
        .frame(width: 1)
        .accessibilityHidden(true)
    }
}

// MARK: - the address bar

private struct BrowserAddressBar: View {
    let model: BrowserPageModel
    @State private var editing = false
    @State private var text = ""
    @FocusState private var focused: Bool

    static let prompt = BrowserAddressBarPrompt.text

    var body: some View {
        let tab = model.current
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                BarGlyph(glyph: "‹", help: "Back ⌘[") { Task { await model.history(.back) } }
                BarGlyph(glyph: "›", help: "Forward ⌘]") { Task { await model.history(.forward) } }
            }
            .disabled(tab == nil)
            field(tab)
            if tab?.loading == true {
                BrailleSpinner().frame(width: 22)
            } else {
                BarGlyph(glyph: "↻", help: "Reload ⌘R") { Task { await model.history(.reload) } }.disabled(tab == nil)
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
                    PixelSprite(rows: PixelArt.lock, pixel: 2, color: Look.faint).help("HTTPS")
                }
                let shown = tab.map { BrowserAddress.display($0.url) } ?? ""
                Text(shown.isEmpty ? Self.prompt : shown)
                    .foregroundStyle(shown.isEmpty ? Look.faint : Look.ink)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
        }
        .font(.system(size: 11.5, design: .monospaced))
        .padding(.horizontal, 8)
        .frame(height: 24)
        .overlay(Rectangle().strokeBorder(editing ? Look.ink2 : Look.line, lineWidth: 1))
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

/// `‹` `›` `↻`: a monospaced glyph that brightens under the pointer.
private struct BarGlyph: View {
    let glyph: String
    let help: String
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            Text(glyph).font(.system(size: 16, design: .monospaced))
                .foregroundStyle(enabled && hovering ? Look.ink : Look.ink2)
                .opacity(enabled ? 1 : 0.4)
                .frame(width: 20, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

// MARK: - the footer

/// Whose tab it is, what is going on, `[ Fill Ciphertext ]` while this Mac drives an http(s) page of yours (nobody else
/// holding it; never an agent's, even taken over), and the hold: `[ Take Over ]` for an agent's tab (filled while it
/// waits for you), `[ Hand Back ]` while this Mac holds it.
private struct BrowserFooter: View {
    let model: BrowserPageModel

    var body: some View {
        if let tab = model.current {
            let holder = BrowserTabText.holder(tab, screen: model.screenID)
            HStack(spacing: 14) {
                owner(tab, holder: holder)
                Spacer(minLength: 8)
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
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(Look.ink2)
            .padding(.horizontal, 14)
            .frame(height: 30)
            .overlay(alignment: .top) { Rectangle().fill(Look.line).frame(height: 1) }
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
                        .font(.system(size: 12.5, design: .monospaced))
                        .focused($focused)
                        .onSubmit { open(.typed(text)) }
                    if model.opening { BrailleSpinner() }
                }
                .padding(.horizontal, 8)
                .frame(height: 28)
                .overlay(Rectangle().strokeBorder(Look.ink2, lineWidth: 1))
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

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if mark { PixelSprite(rows: PixelArt.square, pixel: 2, color: hovering ? Look.ground : .ok) }
                Text(text).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(hovering ? Look.ground : Look.ink)
            .padding(.horizontal, 6)
            .frame(height: 22)
            .background(hovering ? Look.ink : Color.clear)
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
