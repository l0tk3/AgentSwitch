import AgentSwitchMacCore
import AppKit
import SwiftUI

// The Terminals page's list (docs/terminal-v0.md §1; demos `terminal.html`, `classic.html`): the search line, then the
// directory tree — a folder's line, its running terminals (each with its sub-agents at work), its earlier sessions, the
// folders under it. Pixel look: tree lines in characters, a 3 pt signal bar on the row on screen; classic look: rows
// with round corners, set in by depth. The rows themselves come from TerminalListRows (MacCore).

/// The page's greys over the terminal's black (terminal.css `--hover`, `--sel`).
enum ListLook {
    /// `text` with the search's match marked in the signal colour (nothing marked while nothing is searched for).
    static func marked(_ text: String, query: String, classic: Bool) -> AttributedString {
        var out = AttributedString(text)
        guard let range = TerminalSearch.match(query, in: text), let hit = Range(range, in: out) else { return out }
        out[hit].backgroundColor = Color.signal.opacity(classic ? 0.36 : 1)
        if !classic { out[hit].foregroundColor = .black }
        return out
    }

    static let hover = Color.white.opacity(0.04)
    static let selected = Color.white.opacity(0.07)
    /// A character's width in the list's 12.5 pt monospaced type.
    static let ch: CGFloat = 7.55
}

struct TerminalSidebar: View {
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(spacing: 0) {
            SearchLine(model: model)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(model.rows) { row in
                        ListRow(row: row, model: model)
                    }
                }
                .padding(.top, 2)
                .padding(.bottom, 12)
                .padding(.horizontal, look.isClassic ? 8 : 0)
            }
            .scrollIndicators(.never)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background { if look.isClassic { Look.sidebar } else { ScanLines() } }
    }
}

/// The pixel look's list has a screen's faint lines: one in three a little lighter.
private struct ScanLines: View {
    var body: some View {
        Canvas { context, size in
            var path = Path()
            var y: CGFloat = 0
            while y < size.height {
                path.addRect(CGRect(x: 0, y: y, width: size.width, height: 1))
                y += 3
            }
            context.fill(path, with: .color(.white.opacity(0.022)))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// `/ Search ⌘F`: folders by name, terminals and sessions by name and by what was said in them.
private struct SearchLine: View {
    let model: TerminalsModel
    @State private var focused = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var model = model
        HStack(spacing: look.isClassic ? 6 : 4) {
            if look.isClassic {
                Image(systemName: "magnifyingglass").font(.system(size: 11.5)).foregroundStyle(Look.faint)
            } else {
                Text("/").font(.system(size: 12.5, weight: .bold, design: .monospaced)).foregroundStyle(Color.signal)
            }
            PlainField(text: $model.query, placeholder: "Search",
                       font: look.isClassic ? .systemFont(ofSize: 13) : .monospacedSystemFont(ofSize: 12.5, weight: .regular),
                       focusRequests: model.searchFocus, onSubmit: {}, onCancel: model.leaveSearch, onFocus: { focused = $0 })
            if !focused { Text("⌘F").font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint) }
        }
        .padding(.horizontal, look.isClassic ? 8 : 6)
        .frame(height: look.isClassic ? 28 : 26)
        .background(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).fill(look.isClassic ? Look.ink.opacity(0.07) : Color.clear))
        .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0)
            .strokeBorder(look.isClassic ? (focused ? Color.signal.opacity(0.45) : Color.clear) : (focused ? Look.ink2 : Look.line), lineWidth: look.isClassic ? 2.5 : 1))
        .padding(EdgeInsets(top: look.isClassic ? 10 : 8, leading: look.isClassic ? 8 : 10, bottom: look.isClassic ? 6 : 4, trailing: look.isClassic ? 8 : 10))
    }
}

private struct ListRow: View {
    let row: TerminalListRow
    let model: TerminalsModel

    var body: some View {
        switch row {
        case .folder(let folder): FolderLine(folder: folder, model: model)
        case .terminal(let terminal, let twig, let depth, let index): TerminalRow(terminal: terminal, twig: twig, depth: depth, index: index, model: model)
        case .subagent(let agent, let terminal, let twig, let depth): SubagentRow(agent: agent, terminal: terminal, twig: twig, depth: depth, model: model)
        case .session(let session, let twig, let depth): SessionRow(session: session, twig: twig, depth: depth, model: model)
        case .more(let cwd, let twig, let depth, let hidden, let all): MoreRow(cwd: cwd, twig: twig, depth: depth, hidden: hidden, all: all, model: model)
        case .hit(_, let text, let twig, let terminal, let session): HitRow(text: text, twig: twig, terminal: terminal, session: session, model: model)
        case .found(let said): FoundLine(text: said)
        case .note(let said): NoteLine(text: said)
        }
    }
}

// MARK: - a folder's line

private struct FolderLine: View {
    let folder: TerminalListRow.Folder
    let model: TerminalsModel
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: look.isClassic ? 6 : 0) {
            chevron
            name
            Spacer(minLength: 6)
            if hovering, !folder.found {
                Button { model.showCreate(folder: folder.cwd) } label: {
                    Group {
                        if look.isClassic { Image(systemName: "plus").font(.system(size: 10.5, weight: .semibold)) } else { Text("+").font(.system(size: 12.5, design: .monospaced)) }
                    }
                    .foregroundStyle(Look.ink2)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("New Terminal Here")
            } else {
                counts
            }
        }
        .padding(.leading, look.isClassic ? 6 + CGFloat(folder.depth) * 14 : 10 + CGFloat(folder.depth) * 2 * ListLook.ch)
        .padding(.trailing, look.isClassic ? 8 : 12)
        .frame(height: look.isClassic ? 26 : 22)
        .background(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0).fill(folder.holds ? ListLook.selected : hovering ? ListLook.hover : Color.clear))
        .overlay(alignment: .leading) { if folder.holds, !look.isClassic { Rectangle().fill(Color.signal).frame(width: 3) } }
        .contentShape(Rectangle())
        .onTapGesture { if !folder.found { model.toggleFolder(folder.cwd) } }
        .onHover { hovering = $0 }
        .help(TerminalTree.tilde(folder.cwd))
        .padding(.top, look.isClassic ? (folder.depth == 0 ? 6 : 0) : (folder.own || folder.depth == 0 ? 8 : 2))
    }

    @ViewBuilder
    private var chevron: some View {
        if look.isClassic {
            HStack(spacing: 5) {
                Image(systemName: folder.closed ? "chevron.right" : "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Look.faint).frame(width: 10)
                Image(systemName: "folder").font(.system(size: 11.5)).foregroundStyle(Look.ink2)
            }
        } else {
            Text(folder.closed ? "▸" : "▾").font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Look.faint).frame(width: 2 * ListLook.ch, alignment: .leading)
        }
    }

    private var name: some View {
        HStack(spacing: look.isClassic ? 8 : ListLook.ch) {
            Text(ListLook.marked(look.isClassic ? folder.name : TerminalTree.slashed(folder.name), query: folder.found ? model.query : "", classic: look.isClassic))
                .font(look.isClassic ? .system(size: 12, weight: folder.own ? .semibold : .medium) : .system(size: 12.5, weight: folder.own ? .bold : .medium, design: .monospaced))
                .foregroundStyle(look.isClassic || !folder.own ? Look.ink2 : Look.ink)
                .lineLimit(1).truncationMode(.middle)
            if let git = folder.git {
                Text(TerminalWindowText.git(git)).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint).lineLimit(1)
                    .layoutPriority(-1)
            }
        }
    }

    /// `▪2 5`: the running terminals (amber while one waits for you) and the sessions, in the folder and under it.
    @ViewBuilder
    private var counts: some View {
        HStack(spacing: 6) {
            if folder.live > 0 {
                if look.isClassic {
                    Text(String(folder.live)).font(.system(size: 10, weight: .bold))
                        .foregroundStyle(folder.waiting ? Color.white : Look.ink2)
                        .padding(.horizontal, 4).frame(minWidth: 15, minHeight: 15)
                        .background(Capsule().fill(folder.waiting ? Color.waiting : Look.line))
                } else {
                    // Amber and blinking while one waits for you (it may be folded away).
                    Text("▪\(folder.live)").font(.system(size: 11, design: .monospaced)).foregroundStyle(folder.waiting ? Color.waiting : Color.ok)
                        .blinks(folder.waiting)
                }
            }
            if folder.sessions > 0 {
                Text(String(folder.sessions)).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            }
        }
    }
}

// MARK: - rows

/// A row's frame: its number, its branch of the tree, its mark, its name, and at its end what it says of itself — or,
/// under the pointer, what can be done to it.
private struct RowFrame<Mark: View, Name: View, Meta: View, Actions: View>: View {
    var index: Int?
    let twig: String
    let depth: Int
    var selected = false
    var dimmed = false
    @ViewBuilder let mark: Mark
    @ViewBuilder let name: Name
    @ViewBuilder let meta: Meta
    @ViewBuilder let actions: Actions
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 0) {
            if look.isClassic {
                Color.clear.frame(width: CGFloat(depth) * 14 + 27 - 8)
            } else {
                Text(index.flatMap { $0 < 9 ? String(format: "%02d", $0 + 1) : nil } ?? "")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(selected ? Color.signal : Look.faint)
                    .frame(width: 3 * ListLook.ch, alignment: .leading)
                Text(twig).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Look.line)
                    .padding(.leading, CGFloat(depth) * 2 * ListLook.ch)
                    .frame(minWidth: 3 * ListLook.ch, alignment: .leading)
            }
            // The mark's column keeps its width also for a row without a mark (an earlier session in the pixel look).
            Color.clear.frame(width: look.isClassic ? 24 : 2.4 * ListLook.ch, height: 1)
                .overlay(alignment: look.isClassic ? .center : .leading) { mark }
            name.frame(maxWidth: .infinity, alignment: .leading)
            // What the row says of itself, or does, keeps its width: the name gives way.
            Group { if hovering { actions } else { meta } }
                .fixedSize()
                .padding(.leading, look.isClassic ? 8 : 10)
        }
        .lineLimit(1)
        .padding(.leading, look.isClassic ? 8 : 10)
        .padding(.trailing, look.isClassic ? 8 : 12)
        .frame(height: look.isClassic ? 28 : 22)
        .background(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0).fill(selected ? ListLook.selected : hovering ? ListLook.hover : Color.clear))
        .overlay(alignment: .leading) { if selected, !look.isClassic { Rectangle().fill(Color.signal).frame(width: 3) } }
        .opacity(dimmed ? 0.6 : 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct TerminalRow: View {
    let terminal: TerminalInfo
    let twig: String
    let depth: Int
    let index: Int?
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    private var selected: Bool { model.current?.id == terminal.id }
    private var out: Bool { !model.here(terminal.id) }

    var body: some View {
        RowFrame(index: index, twig: twig, depth: depth, selected: selected) {
            statusMark
        } name: {
            if model.renaming == terminal.id { renameField } else {
                Text(ListLook.marked(terminal.name, query: model.query, classic: look.isClassic))
                    .font(look.isClassic ? .system(size: 13, weight: selected || terminal.status == "waiting" ? .medium : .regular)
                                         : .system(size: 12.5, weight: selected || terminal.status == "waiting" ? .bold : .regular, design: .monospaced))
                    .foregroundStyle(terminal.running ? Look.ink : look.isClassic ? Look.faint : Look.ink2)
                    .truncationMode(.tail)
                    // An ended terminal's name is dithered in the pixel look.
                    .mask { if terminal.running || look.isClassic { Rectangle() } else { Checker(color: .black) } }
            }
        } meta: {
            HStack(spacing: look.isClassic ? 6 : 8) {
                meta
                if let badge = paneBadge { badge }
                if out { Text("↗").font(.system(size: 12, design: .monospaced)).foregroundStyle(Look.ink2).help("In Its Own Window") }
            }
        } actions: {
            Button { model.close(terminal) } label: {
                Group { if look.isClassic { Image(systemName: "xmark").font(.system(size: 9.5, weight: .semibold)) } else { Text("×").font(.system(size: 12.5, design: .monospaced)) } }
                    .foregroundStyle(Look.ink2).frame(width: 20, height: 20).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(look.isClassic ? "Close (⌘W)" : "Close ⌘W")
        }
        .onTapGesture(count: 2) { model.startRename(terminal.id) }
        .simultaneousGesture(TapGesture().onEnded { model.open(.terminal(terminal.id), beside: NSEvent.modifierFlags.contains(.command)) })
        .onDrag {
            guard !out else { return NSItemProvider() }
            model.dragging = .terminal(terminal.id)
            return NSItemProvider(object: terminal.id as NSString)
        }
        .contextMenu { menu }
        // It flashes once as it starts waiting for you or ends with an error, and flickers now and then while it works.
        .glitch(on: model.flashes[terminal.id] ?? 0)
        .flickers(while: terminal.status == "working")
        .help("\(TerminalListText.agentName(terminal.harness))\(index.flatMap { $0 < 9 ? " · ⌘\($0 + 1)" : nil } ?? "")")
    }

    @ViewBuilder
    private var statusMark: some View {
        switch terminal.status {
        case "working": BrailleSpinner(size: 12).foregroundStyle(Color.busy)
        case "waiting": TaskMark(level: .warning, waiting: true)
        case "exited": StatusMark(level: .off)
        default: StatusMark(level: .ok)
        }
    }

    @ViewBuilder
    private var meta: some View {
        switch terminal.status {
        case "waiting":
            if look.isClassic {
                Text(ClassicWords.word("Waiting", in: look)).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Color.waiting)
                    .padding(.horizontal, 7).padding(.vertical, 1.5).background(Capsule().fill(Color.waiting.opacity(0.2)))
            } else {
                Text("Waiting").font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.waiting)
            }
        case "exited":
            if let code = terminal.exitCode, code != 0 {
                Text("Exit \(code)").font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Color.failed)
            } else {
                Text(ClassicWords.word("Exited", in: look)).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            }
        default:
            AgentSprite(harness: terminal.harness).opacity(0.75)
        }
    }

    /// The pane it is shown in, among several: its number (the one in focus in the signal colour).
    private var paneBadge: PaneNumber? {
        let all = model.paneList
        guard all.count > 1, let at = all.firstIndex(where: { $0.term == terminal.id }) else { return nil }
        return PaneNumber(number: at + 1, focused: all[at].id == model.focusPane)
    }

    private var renameField: some View {
        @Bindable var model = model
        return PlainField(text: $model.renameText,
                          font: look.isClassic ? .systemFont(ofSize: 13, weight: .medium) : .monospacedSystemFont(ofSize: 12.5, weight: .bold),
                          focusRequests: model.renameFocus, takesFocusAtFirst: true,
                          onSubmit: { model.finishRename(save: true) }, onCancel: { model.finishRename(save: false) },
                          onFocus: { if !$0 { model.finishRename(save: true) } })
            .padding(.horizontal, 4)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 5 : 0).fill(look.isClassic ? Look.ink.opacity(0.07) : Color.black))
            .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 5 : 0).strokeBorder(Color.signal.opacity(look.isClassic ? 0.45 : 1), lineWidth: look.isClassic ? 2.5 : 1))
    }

    @ViewBuilder
    private var menu: some View {
        Button("Rename") { model.startRename(terminal.id) }
        if out {
            Button("Move Back Here") { model.onAttach(terminal.id) }
        } else {
            Button("Open in New Window") { model.onDetach(terminal.id) }
        }
        Button("Encrypt & Send…") {
            model.select(terminal.id)
            model.focused?.session?.toggleSeal()
        }
        .keyboardShortcut("v", modifiers: [.command, .shift])
        .disabled(!terminal.running || out)
        Divider()
        Button("Close", role: .destructive) { model.close(terminal) }
            .keyboardShortcut("w", modifiers: .command)
    }
}

/// A pane's number in a small box, as on the pane's own header.
struct PaneNumber: View {
    let number: Int
    let focused: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Text(String(number))
            .font(.system(size: 10.5, design: look.isClassic ? .default : .monospaced))
            .foregroundStyle(focused ? (look.isClassic ? Color.white : Color.signal) : (look.isClassic ? Look.ink2 : Look.faint))
            .padding(.horizontal, look.isClassic ? 4 : 3)
            .frame(height: 13)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 4 : 0).fill(focused && look.isClassic ? Color.signal : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 4 : 0)
                .strokeBorder(focused ? (look.isClassic ? Color.clear : Color.signal) : Look.faint, lineWidth: look.isClassic ? 0.5 : 1))
    }
}

/// A terminal's sub-agent at work, a step under it: what it was sent to do, what it is doing now, its kind.
private struct SubagentRow: View {
    let agent: TerminalSubagent
    let terminal: String
    let twig: String
    let depth: Int
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        RowFrame(twig: twig, depth: look.isClassic ? depth + 1 : depth) {
            BrailleSpinner(size: 12).foregroundStyle(Color.busy)
        } name: {
            HStack(spacing: look.isClassic ? 8 : ListLook.ch) {
                Text(agent.name).foregroundStyle(Look.ink2)
                if !agent.doing.isEmpty { Text(agent.doing).foregroundStyle(Look.faint) }
            }
            .font(look.isClassic ? .system(size: 13) : .system(size: 12.5, design: .monospaced))
        } meta: {
            Text(agent.type).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
        } actions: {
            Text(agent.type).font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
        }
        .onTapGesture { model.select(terminal) }
        .help([agent.type, agent.doing].filter { !$0.isEmpty }.joined(separator: " · "))
    }
}

/// An earlier session: its name, its agent, when it was last written; under the pointer `Resume` and `Delete`.
private struct SessionRow: View {
    let session: SessionSummary
    let twig: String
    let depth: Int
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    private var resumable: Bool { TerminalListText.resumable.contains(session.harness) }
    private var opening: Bool { model.opening == session.sessionId }

    var body: some View {
        RowFrame(twig: twig, depth: depth, dimmed: opening) {
            if look.isClassic { Image(systemName: "clock").font(.system(size: 11.5)).foregroundStyle(Look.faint) }
        } name: {
            Text(ListLook.marked(session.title.isEmpty ? "(Untitled)" : session.title, query: model.query, classic: look.isClassic))
                .font(look.isClassic ? .system(size: 13) : .system(size: 12.5, design: .monospaced))
                .foregroundStyle(Look.ink2).truncationMode(.tail)
        } meta: {
            HStack(spacing: look.isClassic ? 6 : 8) {
                AgentSprite(harness: session.harness).opacity(0.75)
                Text(opening ? "Opening" : session.active ? ClassicWords.word("Busy", in: look) : TerminalListText.age(since: session.updatedAt, classic: look.isClassic))
                    .font(.system(size: 11, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Look.faint)
            }
        } actions: {
            HStack(spacing: look.isClassic ? 4 : 2) {
                if resumable { RowButton(word: "Resume", primary: true) { model.resume(session) } }
                RowButton(word: "Delete", destructive: true) { model.delete(session) }
            }
        }
        .onTapGesture { if resumable { model.open(.session(session), beside: NSEvent.modifierFlags.contains(.command)) } }
        .onDrag {
            guard resumable else { return NSItemProvider() }
            model.dragging = .session(session)
            return NSItemProvider(object: session.sessionId as NSString)
        }
        .allowsHitTesting(!opening)
        .help("\(TerminalListText.agentName(session.harness)) · \(TerminalTree.tilde(session.cwd))")
    }
}

/// A word on a row under the pointer: `Resume`, `Delete`.
private struct RowButton: View {
    let word: String
    var primary = false
    var destructive = false
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            Text(word)
                .font(.system(size: 11.5, design: look.isClassic ? .default : .monospaced))
                .foregroundStyle(foreground)
                .padding(.horizontal, look.isClassic ? 8 : 4)
                .frame(height: look.isClassic ? 20 : 18)
                .background(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0).fill(ground))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    private var foreground: Color {
        if look.isClassic { return primary || (destructive && hovering) ? .white : Look.ink }
        if hovering { return .black }
        return primary ? Look.ink : Look.ink2
    }

    private var ground: Color {
        if look.isClassic { return destructive && hovering ? .failed : primary ? Color.signal.opacity(hovering ? 0.88 : 1) : Look.raised }
        guard hovering else { return .clear }
        return destructive ? .failed : Look.ink
    }
}

/// `▸ 3 More` / `▴ Less` under a folder's first sessions.
private struct MoreRow: View {
    let cwd: String
    let twig: String
    let depth: Int
    let hidden: Int
    let all: Bool
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        RowFrame(twig: twig, depth: depth) {
            if look.isClassic { Image(systemName: all ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Look.faint) }
        } name: {
            Text(look.isClassic ? (all ? "Less" : "\(hidden) More") : all ? "▴ Less" : "▸ \(hidden) More")
                .font(look.isClassic ? .system(size: 13) : .system(size: 12.5, design: .monospaced))
                .foregroundStyle(look.isClassic ? Look.ink2 : Look.faint)
        } meta: { EmptyView() } actions: { EmptyView() }
        .onTapGesture { model.toggleMore(cwd) }
    }
}

/// A search's words around the match, under the row they were said in.
private struct HitRow: View {
    let text: String
    let twig: String
    let terminal: String?
    let session: SessionSummary?
    let model: TerminalsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        RowFrame(twig: twig, depth: look.isClassic ? 1 : 0) { EmptyView() } name: {
            Text(marked).font(.system(size: look.isClassic ? 12 : 11.5, design: look.isClassic ? .default : .monospaced)).truncationMode(.tail)
        } meta: { EmptyView() } actions: { EmptyView() }
        .onTapGesture {
            if let terminal { model.select(terminal) } else if let session, TerminalListText.resumable.contains(session.harness) { model.resume(session) }
        }
    }

    /// The words, the match marked in the signal colour.
    private var marked: AttributedString {
        var out = ListLook.marked(text, query: model.query, classic: look.isClassic)
        out.foregroundColor = look.isClassic ? Look.ink2 : Look.faint
        if !look.isClassic, let range = TerminalSearch.match(model.query, in: text), let hit = Range(range, in: out) { out[hit].foregroundColor = .black }
        return out
    }
}

private struct FoundLine: View {
    let text: String
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Text(look.isClassic ? String(text.dropFirst(3)) : text)
            .font(look.isClassic ? .system(size: 11.5, weight: .semibold) : .system(size: 11, design: .monospaced))
            .foregroundStyle(look.isClassic ? Look.ink2 : Look.faint)
            .padding(.horizontal, look.isClassic ? 8 : 12)
            .padding(.vertical, look.isClassic ? 4 : 2)
    }
}

private struct NoteLine: View {
    let text: String
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Text(text).font(.system(size: 12.5)).foregroundStyle(look.isClassic ? Look.ink2 : Look.faint).lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, look.isClassic ? 8 : 14)
            .padding(.vertical, 12)
    }
}
