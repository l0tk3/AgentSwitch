import AgentSwitchMacCore
import AppKit
import SwiftUI

/// What the bar's, the rail's and the status bar's controls do (MainWindowController).
struct MainBarActions {
    var switchPage: (MainPage) -> Void = { _ in }
    var toggleList: () -> Void = {}
    var newTerminal: () -> Void = {}
    var newTab: () -> Void = {}
    var settings: () -> Void = {}
    /// The status bar's lock: Encrypt & Send to the terminal on screen.
    var seal: () -> Void = {}
    /// The Terminals bar's split buttons: the pane in focus split to the `right` or `down`.
    var split: (String) -> Void = { _ in }
    /// The bar's menu on Terminals: the terminal of the pane in focus to a window of its own.
    var detach: () -> Void = {}
    /// The Terminals bar's switch: the pane in focus as its session's record, or as the terminal again.
    var toggleView: () -> Void = {}
    /// The Terminals bar's button for the terminal on screen's folder in the code editor.
    var openInEditor: () -> Void = {}
    /// The bar's own traffic lights while the window is full screen.
    var closeWindow: () -> Void = {}
    var exitFullScreen: () -> Void = {}
    /// The bar's node menu and the strip's way back: the window's pages become that node's (nil: this Mac's).
    var useNode: (NodeStatus?) -> Void = { _ in }
    /// The node menu's `Open in New Window`: that node's pages in a window of their own (nil: this Mac's).
    var openWindow: (NodeStatus?) -> Void = { _ in }
    /// Settings › Nodes.
    var openNodes: () -> Void = {}
    /// The bar's folder icon, ⇧⌘F: the Files column at the folder of the pane in focus, or closed (docs/files-v0.md §0).
    var toggleFiles: () -> Void = {}
}

/// The window's content in three parts (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo
/// `implemented/window-bars.html`, proposal B, 2026-10-03): the bar in the title bar's row (32 pt, as iTerm's compact
/// tabs) across the window; under it the rail on the left and the page container; at the foot the status bar across the
/// window, under the rail too. Solid edges between them (dotted until 2026-10-03) — since 2026-10-05 only while the
/// rail or the page's list is shown (BarRule): with both put away there is no line, and the bar, the page and the
/// status bar are one surface, as a terminal's window is. The ground is the page's: black on Terminals (the terminal
/// window's dark block, ui-v0 §3b; the terminal's own colour where its theme has another) and on Browser (the screen's), the system's light or dark on Dispatch (ui-v0 §7.3).
/// A page change draws in the page container only: the rail and the bars are the window's.
struct MainWindowRoot: View {
    let state: MainWindowState
    let head: TerminalHead
    let model: AppModel
    let content: NSView
    let actions: MainBarActions
    var browser: BrowserPageModel?
    var files: FilesColumn?

    var body: some View {
        // The look is handed down from here (`followsWindow`), so the layout that reads it is a view under it.
        MainWindowLayout(state: state, head: head, model: model, content: content, actions: actions, browser: browser, files: files)
            // The bars' spinners and marks stop while the window is not seen (ui-v0 §7.4).
            .followsWindow()
    }
}

private struct MainWindowLayout: View {
    let state: MainWindowState
    let head: TerminalHead
    let model: AppModel
    let content: NSView
    let actions: MainBarActions
    /// The Browser page's model: its hold is the status bar's right on Browser.
    var browser: BrowserPageModel?
    /// The window's Files column (docs/files-v0.md §2): beside the page on the right, or over it.
    var files: FilesColumn?
    @AppStorage(NodeStrip.hiddenKey) private var stripHidden = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        GeometryReader { proxy in
            let side = sideEdge(windowWidth: proxy.size.width)
            VStack(spacing: 0) {
                MainBar(state: state, head: head, actions: actions, nodes: model.nodes.nodes,
                        ownName: model.nodes.list?.own.name ?? model.remote?.name ?? "This Mac", files: files)
                    .frame(height: state.barHeight)
                    .background(BarGround(side: side))
                // The bar's edge, while there is an outline to draw (BarRule).
                BarRule(shown: !look.isClassic && (side > 0 || filesDocked(proxy.size.width)))
                // Another node's pages: whose they are, said across the window, with the way back.
                if let node = state.node, NodeStrip.shown(node: model.nodes.node(node.id) ?? node, known: model.nodes.node(node.id) != nil, hidden: stripHidden) {
                    NodeStrip(node: model.nodes.node(node.id) ?? node, known: model.nodes.node(node.id) != nil, back: { actions.useNode(nil) },
                              hide: { stripHidden = true })
                    HairRule(color: Look.line)
                }
                HStack(spacing: 0) {
                    // The rail; put away it leaves no column (docs/dispatch-v0.md §1 图标栏可以收起): the page runs to
                    // the window's edge.
                    if !state.railHidden {
                        MainRail(state: state, switchPage: actions.switchPage, settings: actions.settings)
                            .background(ChromeGround(color: .clear))
                        RailEdge(state: state).zIndex(1)
                    }
                    ContentHost(view: content)
                    // Beside the page (files-v0 §2.1); floating, it is over the page instead.
                    if let files, files.open, filesDocked(proxy.size.width) {
                        FilesColumnView(files: files, floating: false, ground: Color(nsColor: ground))
                            .frame(width: files.width)
                    }
                }
                .overlay(alignment: .trailing) {
                    if let files, files.open, !filesDocked(proxy.size.width) {
                        FilesColumnView(files: files, floating: true, ground: Color(nsColor: ground))
                            .frame(width: files.width)
                    }
                }
                // The bars a put-away rail leaves on the window's edge, over the page's first points.
                .overlay(alignment: .leading) {
                    if state.railHidden { RailStrip(state: state, switchPage: actions.switchPage, settings: actions.settings) }
                }
                // The put-away rail out over the page's edge while the pointer is on it.
                .overlay(alignment: .leading) {
                    RailOut(state: state, switchPage: actions.switchPage, settings: actions.settings)
                }
                BarRule(shown: !look.isClassic && (side > 0 || filesDocked(proxy.size.width)))
                MainStatusBar(state: state, head: head, model: model, browser: browser, files: files, seal: actions.seal)
                    .frame(height: MainStatusBar.height)
                    .background(BarGround(side: side))
            }
        }
        .background(Color(nsColor: ground))
        .ignoresSafeArea(.container, edges: .top)
    }

    /// The column stands beside the page: open, not floating, and the page keeps its least width beside it (else it
    /// floats over the page until the window is wide again, files-v0 §2.1).
    private func filesDocked(_ windowWidth: CGFloat) -> Bool {
        guard let files, files.open, !files.floating else { return false }
        let rail: CGFloat = state.railHidden ? 0 : MainRail.width + 1
        return windowWidth - rail - files.width >= FilesColumn.leastPage
    }

    /// The window's ground: the page's; on Terminals the terminal's own (its theme's), so that the bar over the
    /// terminal and the status bar under it are of one piece with it.
    private var ground: NSColor {
        // A record in the pane in focus: the page's own ground, light or dark with the system.
        if state.page == .terminals, head.light { return .dispatchGround }
        return state.page == .terminals ? head.ground ?? state.page.ground : state.page.ground
    }

    /// Where what is beside the page ends, from the window's left edge: the rail with its edge, if it is shown, and
    /// the page's list — the terminals' (the page says how wide it is), the browser's tabs; none on Dispatch. Nothing:
    /// everything is put away, and no line is drawn (BarRule).
    private func sideEdge(windowWidth: CGFloat) -> CGFloat {
        let rail: CGFloat = state.railHidden ? 0 : MainRail.width + 1
        let list: CGFloat = switch state.page {
        case .terminals: head.sideWidth
        case .browser: browser.map { CGFloat($0.side.shown(pageWidth: Double(windowWidth - rail))) } ?? 0
        case .dispatch, .clash, .rooms: 0
        }
        return rail + list
    }
}

/// The line under the bar and the one over the status bar: there, across the window, while something beside the page
/// has an outline to draw — the rail, the page's list — and not there at all once everything is put away, when the
/// bar, the page and the status bar are one surface, as a terminal's own window is (2026-10-05; user, with a picture of
/// iTerm's window: 我说的一体化是和终端一样……这种一体化; then, of lines drawn only as far as the list's edge, which left
/// stubs under the window's buttons beside a rail alone: 画的有点草率了哥们，如果所有东西都收起来不需要线来划清界限的话就不用
/// 展示线，如果需要用线来划分轮廓的话就显示边界线). A line is whole or it is not there: nothing ends in mid-air. Demo
/// `docs/design/concepts/bars.html`, C.
private struct BarRule: View {
    let shown: Bool

    var body: some View {
        HairRule(color: shown ? Look.line : .clear)
    }
}

/// A bar's ground in the classic look: the window's own over the list's column, nothing over the page's (the page's
/// ground — the terminal's — shows there). Nothing in the pixel look, where the page's ground runs under all of it.
private struct BarGround: View {
    let side: CGFloat

    var body: some View {
        // Nothing in either look: the page's ground runs under the bars (the classic look's too since §8.1 — its
        // side columns are cards that float, no longer a column of the window's own grey under the bar).
        Color.clear
    }
}

/// The window's own greys under the bar, the rail and the status bar in the classic look (docs/ui-v0.md §8); nothing in
/// the pixel look, where the page's ground runs under them.
private struct ChromeGround: View {
    let color: Color
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic { color } else { Color.clear }
    }
}

/// The bar (docs/dispatch-v0.md §1, proposal B): the page's own toolbar. The traffic lights, then the list's button
/// pinned beside them on every page (Terminals' list, Browser's tabs, ⌘B; dimmed in place on Dispatch, which has none);
/// the title in the centre — the terminal on screen and its git, the tab on screen, the page's name —; at the end only the page's own action, `+` (a new terminal, a new tab; none on Dispatch). The
/// pages and what they have going on are the rail's, the trouble and the page's context the status bar's. Its empty
/// part moves the window and a double click zooms, as a title bar does. All of it changes with the page, at once.
struct MainBar: View {
    @AppStorage("terminals.recordSide") private var recordSide = true
    let state: MainWindowState
    let head: TerminalHead
    let actions: MainBarActions
    /// The nodes this Mac uses and its own name, for the node menu (docs/mesh-v0.md §5.2).
    var nodes: [NodeStatus] = []
    var ownName = "This Mac"
    var files: FilesColumn?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        ZStack {
            // The bar's empty part; on Terminals its menu puts the terminal on screen in a window of its own
            // (docs/dispatch-v0.md §1 单独的窗口; the list's menu has it too).
            WindowDragArea()
                .contextMenu {
                    // A terminal of another node stays in this window: its own windows are this Mac's terminals'.
                    if state.page == .terminals, !head.name.isEmpty, state.node == nil {
                        Button("Open in New Window", action: actions.detach)
                    }
                }
            if state.fullScreen {
                FullScreenLights(key: state.windowKey, close: actions.closeWindow, exitFullScreen: actions.exitFullScreen)
                    .padding(.leading, state.lightsStart)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 4) {
                ToolbarPixelButton(rows: PixelArt.toolbarList, help: state.page.hasList ? "List ⌘B" : "No List on This Page",
                                   enabled: state.page.hasList, action: actions.toggleList)
                NodeChoice(state: state, nodes: nodes, ownName: ownName, actions: actions)
                Spacer(minLength: 0)
                // The page's own actions, side by side in the classic look (ToolbarPixelButton).
                HStack(spacing: look.isClassic ? 0 : 4) {
                    // The Files column (docs/files-v0.md §0), on every page: at the folder of the pane in focus on
                    // Terminals; lit while it shows that folder (anywhere else: while it is open).
                    if let files {
                        let lit = files.open && (state.page != .terminals || head.folder == nil || files.root == head.folder)
                        ToolbarPixelButton(rows: PixelArt.toolbarFiles, help: lit ? "Hide Files ⌘⇧F" : "Show in Files ⌘⇧F", lit: lit, action: actions.toggleFiles)
                    }
                    switch state.page {
                    case .terminals:
                        // Both looks (user #486: seven icons in a row were a clutter; #565: the pixel look's the same
                        // way, in the same places): the side pane, one menu for what is done now and then — the editor,
                        // the other view, the two splits — and New Terminal.
                        // The two views side by side, the one shown lit (user #583: used often enough to be in sight,
                        // not in the menu).
                        if !head.name.isEmpty { ViewSwitch(simple: head.simple, toggle: actions.toggleView).padding(.trailing, 6) }
                        if head.simple { ToolbarPixelButton(rows: PixelArt.toolbarSide, help: head.split ? "Side Pane" : recordSide ? "Hide Side Pane" : "Show Side Pane", enabled: !head.split, lit: recordSide && !head.split) { recordSide.toggle() } }
                        Menu {
                            if !head.name.isEmpty {
                                Button("Open in \(CodeEditor.load(.standard).short)", action: actions.openInEditor)
                                Divider()
                            }
                            Button("Split Right  ⌘D") { actions.split("right") }
                            Button("Split Down  ⌘⇧D") { actions.split("down") }
                        } label: {
                            if look.isClassic {
                                Image(systemName: "ellipsis").font(.system(size: 13, weight: .regular)).foregroundStyle(Color.secondary).frame(width: 26, height: 22).contentShape(Rectangle())
                            } else {
                                PixelMenuLabel(sprite: .more)
                            }
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                        .help("More").accessibilityLabel("More")
                        ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Terminal ⌘T", action: actions.newTerminal)
                    case .browser:
                        ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Tab ⌘T", action: actions.newTab)
                    case .rooms:
                        ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Channel") { state.askNewRoom() }
                        ToolbarPixelButton(rows: PixelArt.toolbarPeople, help: "Members", lit: state.roomsMembers) { state.roomsMembers.toggle() }
                    case .dispatch, .clash:
                        EmptyView()
                    }
                }
            }
            .padding(.leading, state.lightsEnd + 10)
            .padding(.trailing, look.isClassic ? 6 : 8)
            switch state.page {
            case .terminals:
                TerminalTitle(name: head.name, git: head.git, status: head.status, help: head.help).allowsHitTesting(false)
            case .dispatch:
                DispatchTitleView(title: BarTitle("Dispatch · 调度台"))
            case .browser:
                DispatchTitleView(title: state.browserTitle)
            case .clash:
                DispatchTitleView(title: BarTitle("Clash Integration"))
            case .rooms:
                DispatchTitleView(title: BarTitle(state.roomsTitle.map { "# \($0)" } ?? "Channels"))
            }
        }
    }
}

/// The node the window is on (docs/mesh-v0.md §5.2; demo `docs/design/concepts/mesh.html` §2), after the list's button:
/// this Mac's name, or `@ <node>` in the signal colour while the pages are another node's. Its menu lists this Mac and
/// the nodes it uses — what waits for you there, or how each is reached; one that does not answer cannot be chosen —
/// then the way to Settings › Nodes. Not there until this Mac uses a node.
struct NodeChoice: View {
    let state: MainWindowState
    let nodes: [NodeStatus]
    let ownName: String
    let actions: MainBarActions

    var body: some View {
        if !nodes.isEmpty || state.node != nil {
            Menu {
                Section("Use AgentSwitch On") {
                    Button(item(ownName, detail: "This Mac", current: state.node == nil)) { actions.useNode(nil) }
                    ForEach(nodes) { node in
                        Button(item(node.name, detail: NodeText.menuDetail(node), current: state.nodeId == node.id)) { actions.useNode(node) }
                            .disabled(node.state != .online)
                    }
                }
                Divider()
                // 2026-10-14 (user: 这里每一个节点都可以单独开一个窗口): every node but this window's own; one already in a
                // window of its own comes forward.
                Menu("Open in New Window") {
                    if state.node != nil { Button(item(ownName, detail: "This Mac", current: false)) { actions.openWindow(nil) } }
                    ForEach(nodes.filter { $0.id != state.nodeId }) { node in
                        Button(item(node.name, detail: NodeText.menuDetail(node), current: false)) { actions.openWindow(node) }
                            .disabled(node.state != .online)
                    }
                }
                Divider()
                Button("Pair Another Node…", action: actions.openNodes)
                Button("Nodes…", action: actions.openNodes)
            } label: {
                HStack(spacing: 5) {
                    Text(state.node.map { "@ \($0.name)" } ?? ownName).foregroundStyle(state.node == nil ? Look.ink2 : Color.signal)
                    Text("▾").foregroundStyle(Look.ink2)
                }
                .mono(12)
                .lineLimit(1)
                .padding(.horizontal, 6)
                .frame(height: 22)
                .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Use AgentSwitch on Another Node")
            .accessibilityLabel("Node")
        }
    }

    private func item(_ name: String, detail: String, current: Bool) -> String {
        "\(current ? "✓ " : "    ")\(name)\(detail.isEmpty ? "" : "  ·  \(detail)")"
    }
}

/// Under the bar while the window's pages are another node's (demo mesh.html §2): whose they are and how it is
/// reached, and the way back — a task on the Mac mini is not to be taken for one of this Mac's. `×` puts it away for
/// good (2026-10-14, user: 这个东西可关掉; the bar's `@ <node>` still says whose the pages are); a node that stops
/// answering or was removed brings it back, red, and that one stays (`shown`).
struct NodeStrip: View {
    let node: NodeStatus
    /// This Mac still has the node in its book (false: it was removed while the window was on it).
    let known: Bool
    let back: () -> Void
    var hide: () -> Void = {}

    static let hiddenKey = "nodeStripHidden"

    /// Whether the strip is drawn: always while something is wrong there, else unless it was put away.
    static func shown(node: NodeStatus, known: Bool, hidden: Bool) -> Bool { !hidden || !known || node.state != .online }

    static let height: CGFloat = 24

    var body: some View {
        HStack(spacing: 8) {
            PixelSprite(rows: PixelArt.square, pixel: 2, color: trouble ? .failed : .signal)
            Text("正在使用").foregroundStyle(Look.ink2)
            Text(node.name).foregroundStyle(Color.signal)
            Text(words).foregroundStyle(trouble ? Color.failed : Look.ink2)
            Spacer(minLength: 12)
            Button(action: back) { BracketLabel(word: "Back to This Mac") }
                .buttonStyle(BracketButtonStyle(size: 12))
            if !trouble {
                Button(action: hide) { LookGlyph(glyph: "×", symbol: "xmark", size: 13) }
                    .buttonStyle(QuietButtonStyle())
                    .foregroundStyle(Look.ink2)
                    .help("Hide")
                    .accessibilityLabel("Hide")
            }
        }
        .mono(12)
        .lineLimit(1)
        .padding(.horizontal, 12)
        .frame(height: Self.height)
        .background(Color.signal.opacity(0.07))
    }

    private var trouble: Bool { !known || node.state != .online }

    private var words: String {
        if !known { return "· 已从这台 Mac 的节点中移除" }
        switch node.state {
        case .online: return "· " + [NodeText.path(node.address), node.address].compactMap { $0 }.joined(separator: " · ")
        case .offline: return "· Offline · 连接不上，恢复后自动继续"
        case .revoked: return "· Removed There · 对方已移除这台 Mac，需重新配对"
        }
    }
}

/// The traffic lights kept in their place while the window is full screen (2026-10-03, user: 全屏做的有点智障了，红绿灯
/// 直接常驻这里不就好了): macOS hides its own until the pointer reaches the top edge, which left a hole before the list's
/// button. Drawn as the system draws them — 12 pt circles 8 apart, their marks under the pointer, grey while the window
/// is not the key window —: close the window, minimise (dimmed: a full screen window does not minimise, as the system's
/// says), leave full screen.
struct FullScreenLights: View {
    let key: Bool
    let close: () -> Void
    let exitFullScreen: () -> Void
    @State private var hovering = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            light(fill: 0xFF5F57, rim: 0xE0443E, mark: "xmark", help: "Close", action: close)
            light(fill: nil, rim: nil, mark: nil, help: "Minimize", action: nil)
            light(fill: 0x28C840, rim: 0x1AAB29, mark: "arrow.down.forward.and.arrow.up.backward", help: "Exit Full Screen", action: exitFullScreen)
        }
        .onHover { hovering = $0 }
    }

    /// One light; nil colours draw it dimmed and it does nothing.
    @ViewBuilder
    private func light(fill: UInt32?, rim: UInt32?, mark: String?, help: String, action: (() -> Void)?) -> some View {
        let off = Color(white: scheme == .dark ? 0.32 : 0.82)
        let lit = key || hovering
        let body = Circle()
            .fill(fill.map { lit ? Color(hex: $0) : off } ?? off)
            .overlay(Circle().strokeBorder(rim.map { lit ? Color(hex: $0) : off } ?? off, lineWidth: 0.5))
            .overlay {
                if hovering, let mark, action != nil {
                    Image(systemName: mark).font(.system(size: 6.5, weight: .bold)).foregroundStyle(Color.black.opacity(0.55))
                }
            }
            .frame(width: 12, height: 12)
        if let action {
            Button(action: action) { body.contentShape(Circle()) }.buttonStyle(.plain).help(help).accessibilityLabel(help)
        } else {
            body.accessibilityHidden(true)
        }
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// Waiting for you, as everywhere: an amber square that blinks in two steps over 1.1 s; still under Reduce Motion, and
/// while not seen (ui-v0 §7.4, 2026-10-03).
struct BlinkingSquare: View {
    var color: Color = .waiting
    /// The cell: 2 pt (an 8 pt square) in a line, 1 pt as a mark off an icon (the rail).
    var pixel: CGFloat = 2
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            ClassicWaitingDot(color: color, side: 4 * pixel)
        } else {
            blinking
        }
    }

    private var blinking: some View {
        Group {
            if reduceMotion {
                square(dim: false)
            } else if onScreen {
                TimelineView(.periodic(from: Motion.epoch, by: Motion.blink)) { timeline in
                    square(dim: Motion.step(at: timeline.date, every: Motion.blink) % 2 == 1)
                }
            } else {
                square(dim: Motion.step(at: Date(), every: Motion.blink) % 2 == 1)
            }
        }
        .frame(width: 4 * pixel, height: 4 * pixel)
    }

    private func square(dim: Bool) -> some View {
        PixelSprite(rows: PixelArt.square, pixel: pixel, color: color).opacity(dim ? 0.25 : 1)
    }
}

/// A page's title in the bar's centre: a mark and a title (the Browser's tab on screen, the page's own name); it lets
/// the bar move the window.
private struct DispatchTitleView: View {
    let title: BarTitle?

    var body: some View {
        HStack(spacing: 8) {
            if let title {
                HStack(spacing: 8) {
                    BarTitleMark(mark: title.mark)
                    Text(title.text).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                }
                .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: 460)
    }
}

private struct BarTitleMark: View {
    let mark: BarTitle.Mark

    var body: some View {
        switch mark {
        case .none: EmptyView()
        case .busy: BrailleSpinner()
        case .waiting: BlinkingSquare()
        case .done: PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
        case .failed: PixelSprite(rows: PixelArt.square, pixel: 2, color: .failed)
        case .off: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
        }
    }
}

/// The Terminals title: the folder the terminal's agent works in now and its git, as the agent's own status line says
/// it (2026-10-01, user: 应该和当前 agent 的工作目录保持一致，并显示 git 状态), with the status mark (the spinner while
/// busy, amber while it waits, hollow once ended).
struct TerminalTitle: View {
    /// The folder the agent works in, its git, the terminal's status; its own name and the path under the pointer.
    let name: String
    let git: String
    let status: String?
    let help: String

    var body: some View {
        HStack(spacing: 7) {
            if !name.isEmpty {
                switch status {
                case "working": BrailleSpinner()
                case "waiting": PixelSprite(rows: PixelArt.square, pixel: 2, color: .waiting)
                case "exited": PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
                default: PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
                }
                Text(name).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                if !git.isEmpty {
                    Text(git).mono(11).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .help(help)
        .padding(.horizontal, 12)
        .frame(maxWidth: 460)
    }
}

/// A bar button as a pixel icon (1 pt cells): secondary ink, brighter with a faint square behind it under the pointer,
/// as the demo page's; dimmed to the edge's ink where it does nothing (the list's button on Dispatch), in its place.
/// In the classic look (docs/ui-v0.md §8) the system's symbol at one size and weight for every button — 13 pt, regular,
/// as a standard toolbar's — in a button 26 pt wide, so those side by side sit close (2026-10-04, user, of symbols sized
/// by their sprites and 32 pt apart: 他们排列的应该更加紧凑一些).
/// Simple and Terminal, side by side: the view the pane in focus shows lit; a click on the other switches (⌘⇧E). Classic:
/// a two-part control on a soft ground; pixel: `[Simple|Terminal]`, the one shown in reverse.
struct ViewSwitch: View {
    let simple: Bool
    let toggle: () -> Void
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: look.isClassic ? 2 : 0) {
            part("Simple", symbol: "text.alignleft", on: simple)
            part("Terminal", symbol: "terminal", on: !simple)
        }
        .padding(look.isClassic ? 2 : 0)
        .background(RoundedRectangle(cornerRadius: look.isClassic ? Look.controlRadius : 0, style: .continuous).fill(look.isClassic ? Look.hover : Color.clear))
        .overlay(Rectangle().strokeBorder(look.isClassic ? Color.clear : Look.ink, lineWidth: 1))
        .fixedSize()
    }

    private func part(_ word: String, symbol: String, on: Bool) -> some View {
        Button { if !on { toggle() } } label: {
            Group {
                if look.isClassic {
                    HStack(spacing: 4) {
                        Image(systemName: symbol).font(.system(size: 11, weight: .medium))
                        Text(word).font(.system(size: 12, weight: on ? .semibold : .regular))
                    }
                    .foregroundStyle(on ? Look.ink : Look.ink2)
                    .padding(.horizontal, 8).frame(height: 20)
                    .background(RoundedRectangle(cornerRadius: Look.controlRadius - 2, style: .continuous).fill(on ? Look.ground : Color.clear)
                        .shadow(color: .black.opacity(on ? 0.08 : 0), radius: 1, y: 0.5))
                } else {
                    Text(word).font(.system(size: 11.5, weight: on ? .semibold : .regular, design: .monospaced))
                        .foregroundStyle(on ? Look.ground : Look.ink2)
                        .padding(.horizontal, 7).frame(height: 20)
                        .background(on ? Look.ink : Color.clear)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(on ? "\(word) View" : "\(word) View  ⌘⇧E")
        .accessibilityLabel("\(word) View")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

struct ToolbarPixelButton: View {
    let rows: [String]
    let help: String
    var enabled = true
    /// On (the Files column showing the pane's folder): ink behind it, the classic look's accent.
    var lit = false
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            if look.isClassic, let symbol = PixelArt.symbol(for: rows) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(!enabled ? Look.line : lit ? Color.signal : hovering ? Color.primary : Color.secondary)
                    .frame(width: 26, height: 22)
                    .background(RoundedRectangle(cornerRadius: Look.controlRadius, style: .continuous)
                        .fill(lit ? Color.signal.opacity(0.2) : Color(white: 0.5).opacity(enabled && hovering ? 0.16 : 0)).padding(.horizontal, 1))
                    .contentShape(Rectangle())
            } else {
                // The shaded picture on 1 pt cells, the size the classic look's icons are in this bar: on 1.5 pt cells
                // they stood half as large again as everything beside them (2026-10-07, user: 像素页面这几个图标太大了).
                PixelSprite(rows: rows, pixel: 1, color: !enabled ? Look.line : lit || hovering ? .primary : .secondary,
                            strength: !enabled ? 0.28 : lit || hovering ? 1 : 0.85, cell: 1)
                    .frame(width: 28, height: 24)
                    // Square, as everything of the pixel look's is; on, the key is pressed in: its seat's dark edge
                    // above and left (§9's empty seat).
                    .background(PixelKeySeat(on: lit, hovering: enabled && hovering))
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .onHover { hovering = $0 }
        .help(ClassicWords.help(help, in: look))
        .accessibilityLabel(help)
    }
}

/// A shaded picture as a menu's label in the pixel look: a menu draws its label as an image, so a Canvas would come
/// out blank; the same cells (1 pt, the hard shadow a cell down and right) drawn into an image, in a bar button's frame.
struct PixelMenuLabel: View {
    let sprite: ShadedSprite
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        let cells = sprite.cells(dark: dark)
        let size = NSSize(width: 28, height: 24)
        let x0 = ((size.width - CGFloat(sprite.width + 1)) / 2).rounded(.down), y0 = ((size.height - CGFloat(sprite.height + 1)) / 2).rounded(.down)
        let image = NSImage(size: size, flipped: true) { _ in
            NSColor.rgb(dark ? 0x2C2A28 : 0xCFC9BC).withAlphaComponent(0.85).setFill()
            for c in cells { NSRect(x: x0 + CGFloat(c.x + 1), y: y0 + CGFloat(c.y + 1), width: 1, height: 1).fill() }
            for c in cells { NSColor.rgb(c.rgb).withAlphaComponent(0.85).setFill(); NSRect(x: x0 + CGFloat(c.x), y: y0 + CGFloat(c.y), width: 1, height: 1).fill() }
            return true
        }
        Image(nsImage: image).frame(width: size.width, height: size.height).contentShape(Rectangle())
    }
}

/// A bar button's ground in the pixel look: nothing; a faint square under the pointer; while on, a pressed key — a
/// square a step darker with a 1 pt shade along its top and left.
struct PixelKeySeat: View {
    let on: Bool
    let hovering: Bool

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(white: 0.5).opacity(on ? 0.24 : hovering ? 0.14 : 0))
            if on {
                Rectangle().fill(Color.black.opacity(0.22)).frame(height: 1)
                Rectangle().fill(Color.black.opacity(0.22)).frame(width: 1)
            }
        }
    }
}

/// The bar's empty part: it moves the window, and a double click does what the system's title bars do (zoom, minimise
/// or nothing, System Settings › Desktop & Dock).
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ view: NSView, context: Context) {}
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }

    final class DragView: NSView {
        override func mouseDown(with event: NSEvent) {
            guard event.clickCount == 2 else { window?.performDrag(with: event); return }
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window?.performMiniaturize(nil)
            case "None": break
            default: window?.performZoom(nil)
            }
        }
    }
}

/// The page container as it is (the window keeps it; SwiftUI only places it).
private struct ContentHost: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ view: NSView, context: Context) {}
    /// The space offered, as it is: asked for its fitting size, AppKit would walk every page's views through Auto Layout
    /// on each layout of the bar — each step of its spinner (2026-10-03, ui-v0 §7.4).
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}
