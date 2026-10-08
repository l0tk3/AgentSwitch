import AgentSwitchMacCore
import SwiftUI

/// The rail (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo `implemented/window-bars.html`, proposal B,
/// 2026-10-03): the window's pages down its left edge, 44 pt wide and the same on every page — Dispatch (the app's mark),
/// Terminals (a terminal window), Browser (a globe) — and the settings at its foot. Fine pixel icons (1 pt cells, as the
/// bar's buttons) in one ink: secondary, ink under the pointer and for the page on screen, which also has a 2 pt signal
/// bar at the rail's edge. What a page has going on is a mark off its icon's top right corner, ringed in the ground so it
/// never touches the icon — amber while something there waits for you, the spinner while something is busy —, the page
/// on screen too. No names under the icons: the help says them, with their keys.
///
/// It can be put away (docs/dispatch-v0.md §1 图标栏可以收起, 2026-10-04; MainRailLayout): by `«` at the status bar's
/// left end (`RailToggle`), by its edge, by its empty part clicked twice, by its menu under a right click, by ⌥⌘B. It leaves no column then: `RailStrip` lies over the
/// page's edge, and `RailOut` is the rail out over it while the pointer is there.
struct MainRail: View {
    let state: MainWindowState
    let switchPage: (MainPage) -> Void
    let settings: () -> Void

    static let width = CGFloat(MainRailLayout.width)
    /// An icon's row, and the space between two: a bar of the strip stands where its icon was.
    static let row: CGFloat = 36
    static let gap: CGFloat = 2
    static let inset: CGFloat = 6

    var body: some View {
        VStack(spacing: Self.gap) {
            ForEach(MainPage.allCases, id: \.self) { page in
                RailButton(rows: page.railIcon, help: page.railHelp, current: state.page == page,
                           mark: state.activity(of: page).mark) { switchPage(page) }
                    .accessibilityLabel(page.title)
            }
            RailEmptyPart(state: state)
            RailButton(rows: PixelArt.toolbarSettings, help: "Settings ⌘,", current: false, mark: .none, action: settings)
                .accessibilityLabel("Settings")
        }
        .padding(.vertical, Self.inset)
        .padding(.horizontal, 4)
        .frame(width: Self.width)
        .contextMenu { RailMenu(state: state) }
    }
}

/// `«` at the status bar's left end, under the rail: the rail put away; `»` in the same place once it is: the rail
/// brought back. The one thing in the window that says the rail can be put away and brought back, always there and
/// never moved (2026-10-05, user, of a rail whose ways back were its edge, a double click, its menu and a key: 那怎么展开
/// 呢; then, of `»` on the rail that came out under the pointer: 折叠起来的时候我怎么按>>) — where JetBrains' IDEs keep the
/// button that hides their tool window bars. Faint until the pointer is on it.
struct RailToggle: View {
    let state: MainWindowState
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    /// A bar button's size (26 × 22 in the classic look, 28 × 22 in the pixel one), its middle under the rail's.
    static let classicLeading = (MainRail.width - 26) / 2
    static let pixelLeading = (MainRail.width - 28) / 2

    var body: some View {
        Button { state.toggleRail() } label: {
            Group {
                if look.isClassic {
                    Image(systemName: state.railHidden ? "chevron.right.2" : "chevron.left.2").font(.system(size: 10.5, weight: .medium))
                } else {
                    Text(state.railHidden ? "»" : "«").font(.system(size: 13, design: .monospaced))
                }
            }
            .foregroundStyle(hovering ? Look.ink : Look.ink2)
            .frame(width: look.isClassic ? 26 : 28, height: 22)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? Look.controlRadius : 0).fill(Color(white: 0.5).opacity(hovering ? 0.16 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(ClassicWords.help(MainRailLayout.help(hidden: state.railHidden), in: look))
        .accessibilityLabel(state.railHidden ? "Show Rail" : "Hide Rail")
    }
}

/// The rail's empty part, between the pages and the settings: clicked twice it puts the rail away, or brings back the
/// one that is put away.
private struct RailEmptyPart: View {
    let state: MainWindowState

    var body: some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { state.toggleRail() }
            .accessibilityHidden(true)
    }
}

/// The rail's menu under a right click: `Hide Rail` or `Show Rail`, with its key.
private struct RailMenu: View {
    let state: MainWindowState

    var body: some View {
        Button(state.railHidden ? "Show Rail" : "Hide Rail") { state.toggleRail() }
            .keyboardShortcut("b", modifiers: [.command, .option])
    }
}

/// The strip a put-away rail leaves: the first 8 pt of the page along the window's edge, with no column or ground of
/// its own. Half a pill stands out of the edge where an icon was (`RailBar`: its colour, its length, whether it
/// breathes) — as Discord's server list marks its servers; a page that is not on screen and has nothing going on has
/// none. A bar's place clicked goes to its page (the settings' place, at the foot, opens the settings); the pointer
/// resting on the strip brings the rail out (`RailOut`).
struct RailStrip: View {
    let state: MainWindowState
    let switchPage: (MainPage) -> Void
    let settings: () -> Void

    static let width = CGFloat(MainRailLayout.stripWidth)

    var body: some View {
        VStack(spacing: MainRail.gap) {
            ForEach(MainPage.allCases, id: \.self) { page in
                StripBar(bar: .of(current: state.page == page, activity: state.activity(of: page).mark), help: page.railHelp) { switchPage(page) }
                    .accessibilityLabel(page.title)
            }
            RailEmptyPart(state: state)
            StripBar(bar: nil, help: "Settings ⌘,", action: settings)
                .accessibilityLabel("Settings")
        }
        .padding(.vertical, MainRail.inset)
        .frame(width: Self.width)
        .onHover { state.railPointer(strip: $0) }
        .contextMenu { RailMenu(state: state) }
    }
}

/// One bar of the strip, in its icon's row: out of the window's edge, its far corners rounded in the classic look.
/// Core Animation breathes it (LayerMotion): nothing is drawn again as it does; still while it is not seen and under
/// Reduce Motion. Without a bar the row still takes the click.
private struct StripBar: View {
    let bar: RailBar?
    let help: String
    let action: () -> Void
    @Environment(\.interfaceLook) private var look
    @Environment(\.onScreen) private var onScreen
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            // In a stack: the row keeps its place where there is no bar.
            ZStack {
                if let bar {
                    BreathingLight(color: color(bar.tone), radius: look.isClassic ? 2 : 0, corners: [.layerMaxXMinYCorner, .layerMaxXMaxYCorner],
                                   breath: onScreen && !reduceMotion ? .of(bar.pace, classic: look.isClassic) : nil)
                        .frame(width: MainRailLayout.barWidth, height: bar.long ? MainRailLayout.longBar : MainRailLayout.shortBar)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: MainRail.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(ClassicWords.help(help, in: look))
        .accessibilityAddTraits(bar?.long == true ? .isSelected : [])
        .accessibilityValue(bar?.tone == .waiting ? "Waiting" : bar?.pace == .slow ? "Busy" : "")
    }

    private func color(_ tone: RailBar.Tone) -> NSColor {
        switch tone {
        case .selected: NSColor(Color.signal)
        case .ink: NSColor(Look.ink)
        case .waiting: NSColor(Color.waiting)
        }
    }
}

/// The put-away rail out over the page's edge (the pointer rested on the strip): the rail as it is, on its own ground,
/// with its edge. It lies over the page and moves nothing of it — a terminal keeps its size — and goes back when the
/// pointer has left it. In the classic look it slides out and back; in the pixel look, and under Reduce Motion, it is
/// there at once.
struct RailOut: View {
    let state: MainWindowState
    let switchPage: (MainPage) -> Void
    let settings: () -> Void
    @Environment(\.interfaceLook) private var look
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .leading) {
            if state.railHidden, state.railOut {
                HStack(spacing: 0) {
                    MainRail(state: state, switchPage: switchPage, settings: settings)
                        .background(look.isClassic ? Look.sidebar : Look.ground)
                    RailEdge(state: state)
                }
                .onHover { state.railPointer(rail: $0) }
                .transition(.move(edge: .leading))
            }
        }
        .animation(look.isClassic && !reduceMotion ? .easeOut(duration: 0.16) : nil, value: state.railOut)
    }
}

/// The rail's edge: the line between it and the page, and over it a handle 5 pt wide — dragged towards the window's
/// edge it puts the rail away, and clicked twice too; on the put-away rail that is out, dragged away from the window's
/// edge or clicked twice it brings the rail back.
struct RailEdge: View {
    let state: MainWindowState
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HairRule(color: Look.line, vertical: true)
            .overlay {
                RailEdgeHandle(hidden: state.railHidden) { state.toggleRail() }
                    .frame(width: 5)
                    .help(ClassicWords.help(MainRailLayout.help(hidden: state.railHidden), in: look))
            }
    }
}

private struct RailEdgeHandle: NSViewRepresentable {
    let hidden: Bool
    let toggle: () -> Void

    func makeNSView(context: Context) -> HandleView { HandleView() }

    func updateNSView(_ view: HandleView, context: Context) {
        view.railHidden = hidden
        view.toggle = toggle
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: HandleView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }

    final class HandleView: NSView {
        /// The rail is put away: the edge dragged away from the window's edge brings it back.
        var railHidden = false
        var toggle: () -> Void = {}
        private var pressedAt: CGFloat?

        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override var mouseDownCanMoveWindow: Bool { false }

        override func mouseDown(with event: NSEvent) {
            guard event.clickCount < 2 else {
                pressedAt = nil
                return toggle()
            }
            pressedAt = event.locationInWindow.x
        }

        override func mouseDragged(with event: NSEvent) {
            guard let pressedAt else { return }
            let moved = event.locationInWindow.x - pressedAt
            guard railHidden ? moved >= MainRailLayout.dragDistance : moved <= -MainRailLayout.dragDistance else { return }
            self.pressedAt = nil
            toggle()
        }

        override func mouseUp(with event: NSEvent) { pressedAt = nil }
    }
}

extension MainPage {
    /// The page's icon in the rail.
    var railIcon: [String] {
        switch self {
        case .dispatch: PixelArt.railDispatch
        case .terminals: PixelArt.railTerminals
        case .browser: PixelArt.railBrowser
        case .clash: PixelArt.railClash
        }
    }
}

/// One of the rail's icons: 36 pt tall across the rail, the faint hover ground behind it under the pointer; the page on
/// screen with the signal bar at the rail's edge (4 pt to its left, 18 pt tall); its mark off the icon's corner.
private struct RailButton: View {
    let rows: [String]
    let help: String
    let current: Bool
    let mark: PageActivity.Mark
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            if look.isClassic { classic } else { pixel }
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            if current, !look.isClassic { Rectangle().fill(Color.signal).frame(width: 2, height: 18).offset(x: -4) }
        }
        .onHover { hovering = $0 }
        .help(ClassicWords.help(help, in: look))
        .accessibilityAddTraits(current ? .isSelected : [])
        .accessibilityValue(mark == .waiting ? "Waiting" : mark == .busy ? "Busy" : "")
    }
}

private extension RailButton {
    var pixel: some View {
        // The page's shaded picture (docs/ui-v0.md §9): whole for the page on screen or under the pointer, fainter
        // for the others.
        PixelSprite(rows: rows, pixel: 1, color: current || hovering ? Look.ink : Look.ink2, strength: current || hovering ? 1 : 0.7)
            .overlay(alignment: .topTrailing) { RailMark(mark: mark).offset(x: 6, y: -4) }
            .frame(maxWidth: .infinity)
            .frame(height: MainRail.row)
            .background(hovering ? Look.hover : Color.clear)
            .contentShape(Rectangle())
    }

    /// The classic look (docs/ui-v0.md §8): the page on screen has a round highlight and its icon the accent's colour,
    /// in place of the signal bar at the rail's edge.
    var classic: some View {
        PixelSprite(rows: rows, pixel: 1, color: current ? Color.signal : hovering ? Look.ink : Look.ink2)
            .overlay(alignment: .topTrailing) { RailMark(mark: mark).offset(x: 8, y: -5) }
            .frame(maxWidth: .infinity)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(current ? Look.raised : hovering ? Look.hover : Color.clear))
            .padding(.vertical, 3)
            .contentShape(Rectangle())
    }
}

/// The mark off an icon's corner: an 8 pt square of the ground (the ring that keeps it off the icon) holding a 4 pt amber
/// square that blinks as everything waiting for you does, or a small spinner; nothing for a page with nothing going on.
private struct RailMark: View {
    let mark: PageActivity.Mark
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch mark {
        case .none:
            EmptyView()
        case .waiting:
            ring { BlinkingSquare(pixel: look.isClassic ? 1.5 : 1) }
        case .busy:
            ring { BrailleSpinner(size: 9) }
        }
    }

    /// The ring: a square of the ground in the pixel look; a disc of the rail's own grey in the classic one.
    @ViewBuilder
    private func ring(@ViewBuilder _ content: () -> some View) -> some View {
        if look.isClassic {
            content().frame(width: 10, height: 10).background(Circle().fill(Look.sidebar))
        } else {
            content().frame(width: 8, height: 8).background(Look.ground)
        }
    }
}
