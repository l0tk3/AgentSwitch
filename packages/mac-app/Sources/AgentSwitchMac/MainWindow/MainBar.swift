import AgentSwitchMacCore
import AppKit
import SwiftUI

/// What the bar's, the rail's and the status bar's controls do (MainWindowController).
struct MainBarActions {
    var switchPage: (MainPage) -> Void = { _ in }
    var back: () -> Void = {}
    var toggleList: () -> Void = {}
    var newTerminal: () -> Void = {}
    var newTab: () -> Void = {}
    var settings: () -> Void = {}
    /// The status bar's lock: Encrypt & Send to the terminal on screen.
    var seal: () -> Void = {}
    /// The Terminals bar's split buttons: the pane in focus split to the `right` or `down`.
    var split: (String) -> Void = { _ in }
    /// The bar's own traffic lights while the window is full screen.
    var closeWindow: () -> Void = {}
    var exitFullScreen: () -> Void = {}
}

/// The window's content in three parts (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo
/// `implemented/window-bars.html`, proposal B, 2026-10-03): the bar in the title bar's row (32 pt, as iTerm's compact
/// tabs) across the window; under it the rail on the left and the page container; at the foot the status bar across the
/// window, under the rail too. Solid edges between them (dotted until 2026-10-03). The ground is the page's: black on Terminals (the terminal
/// window's dark block, ui-v0 §3b) and on Browser (the screen's), the system's light or dark on Dispatch (ui-v0 §7.3).
/// A page change draws in the page container only: the rail and the bars are the window's.
struct MainWindowRoot: View {
    let state: MainWindowState
    let head: TerminalHead
    let model: AppModel
    let content: NSView
    let actions: MainBarActions
    /// The Browser page's model: its hold is the status bar's right on Browser.
    var browser: BrowserPageModel?

    var body: some View {
        VStack(spacing: 0) {
            MainBar(state: state, head: head, actions: actions)
                .frame(height: state.barHeight)
                .background(ChromeGround(color: Look.chrome))
            // The bar's edge (2026-10-01, user: 顶栏没有分界线): a solid line since 2026-10-03, as every edge.
            HairRule(color: Look.line)
            HStack(spacing: 0) {
                MainRail(state: state, switchPage: actions.switchPage, settings: actions.settings)
                    .background(ChromeGround(color: Look.sidebar))
                HairRule(color: Look.line, vertical: true)
                ContentHost(view: content)
            }
            HairRule(color: Look.line)
            MainStatusBar(state: state, head: head, model: model, browser: browser, seal: actions.seal)
                .frame(height: MainStatusBar.height)
                .background(ChromeGround(color: Look.chrome))
        }
        .background(Color(nsColor: state.page.ground))
        .ignoresSafeArea(.container, edges: .top)
        // The bars' spinners and marks stop while the window is not seen (ui-v0 §7.4).
        .followsWindow()
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
/// the title in the centre — the terminal on screen and its git, Dispatch's task or topic page as `‹` + mark + title,
/// the tab on screen —; at the end only the page's own action, `+` (a new terminal, a new tab; none on Dispatch). The
/// pages and what they have going on are the rail's, the trouble and the page's context the status bar's. Its empty
/// part moves the window and a double click zooms, as a title bar does. All of it changes with the page, at once.
struct MainBar: View {
    let state: MainWindowState
    let head: TerminalHead
    let actions: MainBarActions

    var body: some View {
        ZStack {
            WindowDragArea()
            if state.fullScreen {
                FullScreenLights(key: state.windowKey, close: actions.closeWindow, exitFullScreen: actions.exitFullScreen)
                    .padding(.leading, state.lightsStart)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 4) {
                ToolbarPixelButton(rows: PixelArt.toolbarList, help: state.page.hasList ? "List ⌘B" : "No List on This Page",
                                   enabled: state.page.hasList, action: actions.toggleList)
                Spacer(minLength: 0)
                switch state.page {
                case .terminals:
                    // The pane in focus split in two, the new half empty (docs/terminal-v0.md §1 分屏, 2026-10-03).
                    ToolbarPixelButton(rows: PixelArt.toolbarSplitRight, help: "Split Right ⌘D") { actions.split("right") }
                    ToolbarPixelButton(rows: PixelArt.toolbarSplitDown, help: "Split Down ⌘⇧D") { actions.split("down") }
                    ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Terminal ⌘T", action: actions.newTerminal)
                case .browser:
                    ToolbarPixelButton(rows: PixelArt.toolbarNew, help: "New Tab ⌘T", action: actions.newTab)
                case .dispatch:
                    EmptyView()
                }
            }
            .padding(.leading, state.lightsEnd + 10)
            .padding(.trailing, 8)
            switch state.page {
            case .terminals:
                TerminalTitleView(head: head).allowsHitTesting(false)
            case .dispatch:
                DispatchTitleView(title: state.dispatchTitle, back: state.showsBack, action: actions.back)
            case .browser:
                DispatchTitleView(title: state.browserTitle, back: false, action: {})
            }
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

/// Dispatch's title: nothing on the conversation; `‹` + mark + title on a task's or topic's page (the arrow goes back,
/// the rest lets the bar move the window). Browser's is the same without the arrow: the tab on screen.
private struct DispatchTitleView: View {
    let title: BarTitle?
    let back: Bool
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 8) {
            if back {
                Button(action: action) {
                    Group {
                        if look.isClassic {
                            Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                        } else {
                            Text("‹").font(.system(size: 15, design: .monospaced))
                        }
                    }
                    .foregroundStyle(hovering ? .primary : .secondary)
                    .padding(.horizontal, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .help(ClassicWords.help("Back esc", in: look))
                .accessibilityLabel("Back")
            }
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
private struct TerminalTitleView: View {
    let head: TerminalHead

    var body: some View {
        HStack(spacing: 7) {
            if !head.name.isEmpty {
                switch head.status {
                case "working": BrailleSpinner()
                case "waiting": PixelSprite(rows: PixelArt.square, pixel: 2, color: .waiting)
                case "exited": PixelSprite(rows: PixelArt.hollow, pixel: 2, color: .inkDim)
                default: PixelSprite(rows: PixelArt.square, pixel: 2, color: .ok)
                }
                Text(head.name).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                if !head.git.isEmpty {
                    Text(head.git).mono(11).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .help(head.help)
        .padding(.horizontal, 12)
        .frame(maxWidth: 460)
    }
}

/// A bar button as a pixel icon (1 pt cells): secondary ink, brighter with a faint square behind it under the pointer,
/// as the demo page's; dimmed to the edge's ink where it does nothing (the list's button on Dispatch), in its place.
struct ToolbarPixelButton: View {
    let rows: [String]
    let help: String
    var enabled = true
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            PixelSprite(rows: rows, pixel: 1, color: !enabled ? Look.line : hovering ? .primary : .secondary,
                        strength: !enabled ? 0.28 : hovering ? 1 : 0.85)
                .frame(width: 28, height: 24)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color(white: 0.5).opacity(enabled && hovering ? 0.16 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .onHover { hovering = $0 }
        .help(ClassicWords.help(help, in: look))
        .accessibilityLabel(help)
    }
}

/// The bar's empty part: it moves the window, and a double click does what the system's title bars do (zoom, minimise
/// or nothing, System Settings › Desktop & Dock).
private struct WindowDragArea: NSViewRepresentable {
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
