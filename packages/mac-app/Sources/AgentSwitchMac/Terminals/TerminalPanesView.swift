import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Terminals page's panes (docs/terminal-v0.md §1 分屏; demo `split.html`): each pane its native screen and what
// floats over it — the requests' cards and the sealed reply in the pane in focus, the placeholder where a terminal is
// in use elsewhere, what an empty pane offers, the new-terminal panel —; among several, a header a pane (its number, the
// terminal's mark and name, its folder and git, ×), the lines between them to drag, and where a row dragged from the
// list would land.

struct TerminalPanesArea: View {
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    static let space = "AgentSwitchTerminalPanes"

    var body: some View {
        GeometryReader { geometry in
            let placed = model.placed(in: geometry.size)
            ZStack(alignment: .topLeading) {
                ForEach(placed.panes) { pane in
                    TerminalPaneView(placed: pane, number: (model.paneList.firstIndex { $0.id == pane.id } ?? 0) + 1, model: model)
                        .frame(width: pane.rect.width, height: pane.rect.height)
                        .offset(x: pane.rect.minX, y: pane.rect.minY)
                        .id(pane.id)
                }
                ForEach(placed.lines) { line in
                    PaneLine(line: line, model: model)
                }
                if let target = model.dropTarget, let pane = placed.panes.first(where: { $0.id == target.pane }) {
                    DropMark(drop: target.drop, header: model.many ? PaneHeader.height(look) : 0)
                        .frame(width: target.drop.rect.width, height: target.drop.rect.height)
                        .offset(x: pane.rect.minX + target.drop.rect.minX, y: pane.rect.minY + target.drop.rect.minY)
                        .allowsHitTesting(false)
                }
                if let notice = model.notice {
                    PageNotice(text: notice)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 12)
                        .allowsHitTesting(false)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
            .coordinateSpace(.named(Self.space))
            .onDrop(of: [.text], delegate: RowDrop(model: model, panes: placed.panes))
            .onChange(of: geometry.size, initial: true) { model.area = geometry.size }
        }
    }
}

/// A row dragged over the panes: the pane under it shows where it would land; let go, it lands there.
private struct RowDrop: DropDelegate {
    let model: TerminalsModel
    let panes: [TerminalPanes.Placed]

    private func target(_ info: DropInfo) -> (pane: Int, drop: TerminalPanes.Drop)? {
        guard model.dragging != nil, let pane = panes.first(where: { $0.rect.contains(info.location) }) else { return nil }
        let local = CGPoint(x: info.location.x - pane.rect.minX, y: info.location.y - pane.rect.minY)
        return (pane.id, TerminalPanes.zone(in: CGRect(origin: .zero, size: pane.rect.size), at: local, count: model.paneList.count))
    }

    func validateDrop(info: DropInfo) -> Bool { model.dragging != nil }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        let next = target(info)
        if next?.pane != model.dropTarget?.pane || next?.drop != model.dropTarget?.drop { model.dropTarget = next }
        return DropProposal(operation: next == nil ? .cancel : .move)
    }

    func dropExited(info: DropInfo) { model.dropTarget = nil }

    func performDrop(info: DropInfo) -> Bool {
        defer { model.dragging = nil; model.dropTarget = nil }
        guard let item = model.dragging, let target = target(info) else { return false }
        model.drop(item, on: target.pane, target.drop.zone)
        return true
    }
}

/// Where a dragged row would land: the pane's middle (`Open Here`) or the half on one side (`Split Right`).
private struct DropMark: View {
    let drop: TerminalPanes.Drop
    let header: CGFloat
    @Environment(\.interfaceLook) private var look

    private var word: String {
        if drop.full { return "最多 \(TerminalPanes.maxPanes) 个分屏" }
        switch drop.zone {
        case .center: return "Open Here"
        case .side(.left): return "Split Left"
        case .side(.right): return "Split Right"
        case .side(.top): return "Split Up"
        case .side(.bottom): return "Split Down"
        }
    }

    var body: some View {
        let tint = look.isClassic ? Color.signal : Color.busy
        ZStack {
            RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).fill(tint.opacity(look.isClassic ? 0.12 : 0.09))
            RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).strokeBorder(tint, style: StrokeStyle(lineWidth: look.isClassic ? 1.5 : 1, dash: [4, 3]))
            Text(word).font(.system(size: 12, design: look.isClassic ? .default : .monospaced))
                .foregroundStyle(look.isClassic ? Color.white : Color.black)
                .padding(.horizontal, look.isClassic ? 10 : 8).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: look.isClassic ? 999 : 0).fill(tint))
        }
    }
}

/// The line between two panes: 2 pt drawn in a grey that shows on a light record and on a dark terminal alike, 7 to
/// take hold of (2026-10-10, user: 分屏的分界线看上去不显眼，经常不能一眼看到哪个分屏在哪里; it was 1 pt in the bars'
/// edge colour); dragged it resizes (every pane keeping its least size), a double click evens its two sides.
private struct PaneLine: View {
    let line: TerminalPanes.Line
    let model: TerminalsModel
    @State private var hovering = false
    @State private var dragging = false
    private static let drawn: CGFloat = 2
    private static let color = Color(white: 0.5).opacity(0.6)

    var body: some View {
        let across = line.dir == .row
        Rectangle()
            .fill(hovering || dragging ? Color.signal : Self.color)
            .frame(width: across ? Self.drawn : line.rect.width, height: across ? line.rect.height : Self.drawn)
            .frame(width: across ? 7 : line.rect.width, height: across ? line.rect.height : 7)
            .contentShape(Rectangle())
            .offset(x: across ? line.rect.minX - 3 : line.rect.minX, y: across ? line.rect.minY : line.rect.minY - 3)
            .onHover { inside in
                hovering = inside
                if inside { (across ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .named(TerminalPanesArea.space))
                .onChanged { value in
                    dragging = true
                    model.dragLine(line, to: across ? value.location.x - line.box.minX : value.location.y - line.box.minY)
                }
                .onEnded { _ in
                    dragging = false
                    model.endLineDrag()
                })
            .simultaneousGesture(TapGesture(count: 2).onEnded { model.evenLine(line.id) })
            .help("Drag · Double-Click Evens")
    }
}

// MARK: - a pane

struct TerminalPaneView: View {
    let placed: TerminalPanes.Placed
    let number: Int
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look
    /// The window's light or dark: a record's pane keeps it, a terminal's is dark whatever it is.
    @Environment(\.colorScheme) private var scheme

    private var focused: Bool { placed.id == model.focusPane }
    /// A terminal is being made here.
    private var making: Bool { model.creating && focused }

    var body: some View {
        let state = model.panes[placed.id]
        let record = state?.simple == true && state?.session != nil && !making
        // The simple view's look: a record, and a pane that waits as one (split off a record) — its empty state and
        // the new-terminal panel over it with it.
        let light = model.isLight(pane: placed.id)
        VStack(spacing: 0) {
            if model.many {
                PaneHeader(pane: placed.id, number: number, state: state, making: making, model: model)
            }
            ZStack {
                if let state {
                    // The screen stays where it is under the record, put away (it shows no terminal then): taken out of
                    // the window and handed to a new host on the way back, it was never put in again — the pane stayed
                    // black (2026-10-07, user: 从简略模式切换到终端模式就变成黑屏了).
                    PaneStageHost(view: state.stage, compact: model.many).id(placed.id)
                        .allowsHitTesting(!record)
                }
                if let state, record {
                    // The terminal's record in place of its screen (docs/simple-view-v0.md §5.2): the system's light or
                    // dark, where the terminal is always dark.
                    TerminalRecordPane(state: state, model: model, focused: focused)
                } else if let state {
                    if let session = state.session {
                        // The cards and the sealed reply are the pane in focus's; the placeholder shows in any pane.
                        TerminalWindowOverlays(model: session, cards: focused && !making)
                        if let loading = state.loading { LoadingLine(text: loading, ground: model.ground) }
                    }
                    if model.sizing, state.session != nil, let grid = state.grid { SizeBadge(cols: grid.cols, rows: grid.rows) }
                }
                if making {
                    TerminalCreatePanel(model: model, compact: model.many)
                } else if state?.session == nil {
                    EmptyPane(pane: placed.id, model: model)
                }
            }
        }
        // A terminal's pane is the terminal's dark block whatever the window around it (a record beside it may be light).
        .background(light ? Look.ground : Color(nsColor: model.ground))
        .environment(\.colorScheme, light ? scheme : .dark)
        .simultaneousGesture(TapGesture().onEnded { if !focused { model.focus(pane: placed.id) } })
    }
}

/// A pane's screen in SwiftUI. Among several panes it sits a little closer to the pane's edge.
private struct PaneStageHost: NSViewRepresentable {
    let view: ItemTerminalStage
    let compact: Bool

    func makeNSView(context: Context) -> ItemTerminalStage { view }
    func updateNSView(_ view: ItemTerminalStage, context: Context) {
        let left: CGFloat = compact ? 10 : 16
        if view.leftInset != left { view.leftInset = left }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ItemTerminalStage, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}

/// A pane's header among several: `2 ■ name  folder · main ±3 … [!] Approval ✳ ×`; a signal edge on the one in focus.
struct PaneHeader: View {
    let pane: Int
    let number: Int
    let state: TerminalPaneState?
    let making: Bool
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    static func height(_ look: InterfaceLook) -> CGFloat { look.isClassic ? 26 : 24 }
    private var focused: Bool { pane == model.focusPane }

    var body: some View {
        let session = making ? nil : state?.session
        let info = session?.info
        HStack(spacing: 8) {
            PaneNumber(number: number, focused: focused)
            if let info {
                switch info.status {
                case "working": BrailleSpinner(size: 12).foregroundStyle(Color.busy)
                case "waiting": TaskMark(level: .warning, waiting: true)
                case "exited": StatusMark(level: .off)
                default: StatusMark(level: .ok)
                }
            }
            if making {
                Text("New Terminal").font(.system(size: 12.5, weight: .semibold))
            } else if let info {
                Text(info.name).font(.system(size: 12.5, weight: .semibold)).layoutPriority(1)
                Text([session?.folder ?? "", session?.gitWords ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            } else {
                Text("Empty").font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            }
            Spacer(minLength: 4)
            if model.zoomed {
                Text("Pane \(number) of \(model.paneList.count) · ⌘⇧↩").font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            }
            // A request waiting in a pane out of focus: its card shows once the pane has the focus.
            if !focused, let session, !session.requests.isEmpty {
                Text(ClassicWords.word("[!] Approval", in: look)).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Color.waiting)
            }
            if let info { AgentSprite(harness: info.harness).opacity(0.75) }
            // The other view of the same session (docs/simple-view-v0.md §1): each pane has its own.
            if info != nil, let state {
                Button { model.focus(pane: pane); model.toggleSimple(pane: pane) } label: {
                    Group {
                        if look.isClassic { Image(systemName: state.simple ? "terminal" : "text.alignleft").font(.system(size: 10.5, weight: .medium)) }
                        else { PixelSprite(rows: state.simple ? PixelArt.terminalWindow : PixelArt.toolbarRecord, pixel: 1, color: Look.ink2) }
                    }
                    .foregroundStyle(Look.ink2)
                    .frame(width: 22, height: 20).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(state.simple ? "Terminal View ⌘⇧E" : "Simple View ⌘⇧E")
            }
            if !model.zoomed {
                Button { model.closePane(pane) } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Look.faint)
                        .frame(width: 20, height: 20).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Close Pane")
            }
        }
        .lineLimit(1)
        .foregroundStyle(focused ? Look.ink : Look.ink2)
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .frame(height: Self.height(look))
        .background(look.isClassic ? (focused ? Color.signal.opacity(0.16) : Look.ink.opacity(0.05)) : Color.clear)
        .overlay(alignment: .top) { if focused, !look.isClassic { Rectangle().fill(Color.signal).frame(height: 2) } }
        .overlay(alignment: .bottom) { Rectangle().fill(Look.line).frame(height: 1) }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { model.toggleZoom() }
        .simultaneousGesture(TapGesture().onEnded { model.focus(pane: pane) })
    }
}

/// What an empty pane offers: a row from the list, the session it ran before, a new terminal.
private struct EmptyPane: View {
    let pane: Int
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let was = TerminalPanes.pane(model.layout, pane)?.was.flatMap { was in
            model.sessions.first { $0.harness == was.harness && $0.sessionId == was.session && TerminalListText.resumable.contains($0.harness) }
        }
        VStack(spacing: 12) {
            Text("将左侧的终端或会话拖到这里，或先点这一块、再在左侧点选。")
                .font(.system(size: 13)).foregroundStyle(Look.ink2).lineSpacing(5).multilineTextAlignment(.center).frame(maxWidth: 360)
            if let was {
                Button { model.focus(pane: pane, force: true); model.resume(was) } label: {
                    BracketLabel(word: "Resume 「\(was.title.isEmpty ? "会话" : was.title)」")
                }
                .buttonStyle(BracketButtonStyle(role: .primary, size: 12.5))
            }
            Button { model.focus(pane: pane, force: true); model.showCreate() } label: { BracketLabel(word: "+ New Terminal") }
                .buttonStyle(BracketButtonStyle(size: 12.5))
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(model.isLight(pane: pane) ? Look.ground : Color(nsColor: model.ground))
        .contentShape(Rectangle())
    }
}

/// `⠋ Starting Claude Code`: over the screen until the agent has drawn something.
private struct LoadingLine: View {
    let text: String
    let ground: NSColor
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 8) {
            BrailleSpinner(size: 12).foregroundStyle(Color.busy)
            Text(text).font(.system(size: 12.5, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.ink2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: ground))
        .allowsHitTesting(false)
    }
}

/// `104 × 33`: a pane's grid while a line is dragged.
private struct SizeBadge: View {
    let cols: Int
    let rows: Int
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Text("\(cols) × \(rows)")
            .font(look.isClassic ? .system(size: 15, weight: .semibold) : .system(size: 14, design: .monospaced))
            .foregroundStyle(Look.ink)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).fill(Look.panel.opacity(0.9)))
            .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).strokeBorder(look.isClassic ? Color.clear : Look.ink2, lineWidth: 1))
            .allowsHitTesting(false)
    }
}

/// The page's own sentence at the foot of the panes (a split refused, a session that could not be continued).
private struct PageNotice: View {
    let text: String

    var body: some View {
        Text(text).font(.system(size: 12.5)).foregroundStyle(Look.ink).lineLimit(2)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .grounded(Look.raised, radius: 8)
            .framed(Look.ink2, radius: 8)
            .glitch(on: text, onAppear: { true })
    }
}
