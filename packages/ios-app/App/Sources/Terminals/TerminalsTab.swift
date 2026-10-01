import AgentSwitchKit
import SwiftUI

/// Where the terminals tab leads by value: one terminal, one of the Mac's other sessions (read only, with resume).
enum TerminalRoute: Hashable {
    case terminal(TerminalInfo)
    case session(SessionSummary)
}

/// The terminals tab (docs/terminal-v0.md §1): a directory tree of the Mac's terminals and its earlier sessions, as the
/// web page's sidebar — each project folder with its running terminals (status mark, name, agent) and then its sessions
/// (resume); projects under one parent merged under it. A folder or parent row folds and unfolds (remembered); `▸ N
/// more` lists all of a folder's sessions, the rows drawn line by line; a long press on a session opens its menu
/// (resume, delete — a deleted row is wiped out). A terminal that needs you or exits glitches once. Menus and confirm
/// boxes are the desktop's pixel boxes; the list has its scanlines and a dotted rule under the bar. `new` starts one.
struct TerminalsTab: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()
    @State private var creating = false
    @State private var elsewhere: Elsewhere?
    @State private var opening: String?
    /// Folded folders and parents, by path, one per line.
    @AppStorage("terminals.folded") private var foldedRaw = ""
    /// Folders showing all their sessions (this visit).
    @State private var showingAll: Set<String> = []
    @State private var deletingSession: SessionSummary?
    /// The session whose menu is open (a long press), and where its row is.
    @State private var menuFor: SessionMenu?
    /// The folder just unfolded: its rows are drawn line by line.
    @State private var revealed: Reveal?
    /// Sessions being wiped out, and those gone from the list until the next one comes without them.
    @State private var wiping: Set<String> = []
    @State private var gone: Set<String> = []
    /// A session last run in bypass, asked about before it goes on.
    @State private var bypassResume: SessionSummary?
    /// Why continuing or deleting a session failed: a box over whatever page is open.
    @State private var failure: String?
    /// The search line (docs/terminal-v0.md §1 搜索); the Mac's answer for the words said in sessions, and what it was
    /// asked.
    @State private var query = ""
    @State private var said: [String: String] = [:]
    @State private var saidFor = ""

    static let pollInterval: Duration = .seconds(4)
    /// Sessions shown per folder before `▸ N more`.
    static let sessionsShown = 3

    var body: some View {
        let store = model.terminals
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.connection.endpoint == nil {
                        ConnectionBanner().padding(.bottom, Theme.Space.m)
                    }
                    if let error = store.error {
                        Text(error).font(.footnote).foregroundStyle(Theme.failed).padding(.bottom, Theme.Space.m)
                    }
                    if store.list != nil && store.nodes.isEmpty && query.isEmpty {
                        Text("尚无终端。点 New 在 Mac 上启动 agent。").font(.footnote).foregroundStyle(.secondary).padding(.top, 40)
                    }
                    if store.list != nil && !(store.nodes.isEmpty && query.isEmpty) { searchLine }
                    if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        ForEach(store.nodes) { node in nodeView(node) }
                    } else {
                        searchResults(TerminalSearch.run(store.nodes, query: query, said: saidFor == query ? said : [:]))
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            .background { ZStack { Theme.base; Scanlines() }.ignoresSafeArea() }
            .safeAreaInset(edge: .top, spacing: 0) { DottedRule() }
            .navigationTitle("Terminals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("New") { creating = true }.mono(15, weight: .medium)
                        .disabled(store.list == nil)
                }
            }
            .navigationDestination(for: TerminalRoute.self) { route in
                switch route {
                case .terminal(let t): TerminalPage(terminal: t)
                case .session(let s): SessionTranscriptView(session: s, resuming: opening == s.id, resume: { Task { await resume(s) } })
                }
            }
            .refreshable { await model.refreshTerminals(sessions: true) }
            // The words said in sessions, once typing pauses; an answer to an older query is not kept.
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard !q.isEmpty, let api = model.api else { said = [:]; saidFor = ""; return }
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, let hits = try? await api.searchSessions(q), !Task.isCancelled else { return }
                said = Dictionary(hits.map { ("\($0.harness):\($0.id)", $0.excerpt) }, uniquingKeysWith: { a, _ in a })
                saidFor = query
            }
            .onAppear {
                openRequested()
                #if DEBUG
                // The session menu and the delete box, as a long press and its delete would open them.
                if let first = store.nodes.first?.groups.first?.sessions.first {
                    switch UserDefaults.standard.string(forKey: "uiDemoScreen") {
                    case "terminalmenu": menuFor = SessionMenu(session: first, anchor: CGRect(x: 16, y: 210, width: 360, height: 36))
                    case "terminalsearch": query = "终端"
                    case "terminaldelete": deletingSession = first
                    default: break
                    }
                }
                #endif
            }
            .onChange(of: model.openTerminalRequest) { openRequested() }
            // A cold start from the Live Activity: the request is there before the list.
            .onChange(of: store.list == nil) { openRequested() }
            // The list itself is followed from every tab (MainTabs); the sessions and the folders' git while this tab
            // is on screen.
            .task(id: model.connection.endpoint) {
                while !Task.isCancelled {
                    await store.refreshSessions(model.api)
                    await store.refreshGit(model.api)
                    try? await Task.sleep(for: Self.pollInterval)
                }
            }
            .sheet(isPresented: $creating) {
                NewTerminalSheet { terminal in
                    store.add(terminal)
                    path.append(TerminalRoute.terminal(terminal))
                }
            }
            .pixelBox(item: $menuFor) { m in
                var items: [PixelBox.Action] = []
                if TerminalsTab.resumable.contains(m.session.harness) { items.append(.init(label: "Resume") { Task { await resume(m.session) } }) }
                if TerminalsTab.deletable.contains(m.session.harness) { items.append(.init(label: "Delete", role: .destructive) { deletingSession = m.session }) }
                return PixelBox(cancel: nil, actions: items, anchor: m.anchor)
            }
            .pixelBox(item: $bypassResume) { s in
                PixelBox(head: "Bypass", tone: .amber, message: "「\(s.displayTitle)」上次以 Bypass 运行。\(NewTerminalSheet.bypassNote)",
                         actions: [.init(label: "Auto") { Task { await resume(s, mode: "auto") } },
                                   .init(label: "Bypass", role: .primary) { Task { await resume(s, mode: "bypass") } }])
            }
            .pixelBox(item: $deletingSession) { s in
                PixelBox(head: "Delete Record", tone: .red, message: "删除会话记录「\(s.displayTitle)」？Mac 上这段会话的记录将被删除，无法恢复，也无法再继续。",
                         actions: [.init(label: "Delete", role: .primary) { Task { await deleteSession(s) } }])
            }
            .pixelBox(item: $elsewhere) { e in
                PixelBox(head: "In Use", tone: .amber,
                         message: "「\(e.session.displayTitle)」正在 \(e.app) 中运行。同一会话同时只能由一个程序写入。请先在 \(e.app) 中退出，或创建分支：新会话包含全部历史，原会话保持不变。",
                         actions: [.init(label: "Fork", role: .primary) { Task { await resume(e.session, fork: true, mode: e.mode) } }])
            }
        }
        .pixelBox(item: $failure) { message in
            PixelBox(head: "Error", tone: .red, message: message, cancel: nil, actions: [.init(label: "OK", role: .primary) {}])
        }
    }

    private var folded: Set<String> { Set(foldedRaw.split(separator: "\n").map(String.init)) }

    private func toggleFold(_ key: String) {
        var set = folded
        if set.remove(key) == nil { set.insert(key) } else { revealed = Reveal(key: key) }
        foldedRaw = set.sorted().joined(separator: "\n")
    }

    /// A row that came with the unfold of `keys` just now (either its folder or its parent) draws at its turn.
    private func stepIn(_ index: Int, under keys: String?...) -> StepIn {
        let active = revealed.map { r in keys.contains(r.key) && Date.now.timeIntervalSince(r.at) < 0.4 } ?? false
        return StepIn(index: index, active: active)
    }

    @ViewBuilder
    private func nodeView(_ node: TerminalTree.Node) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let parent = node.parent, let name = node.parentName {
                let isFolded = folded.contains(parent)
                Button { toggleFold(parent) } label: {
                    HStack(spacing: 6) {
                        Text("\(isFolded ? "▸" : "▾") \(name)/").mono(12).foregroundStyle(Theme.inkDim)
                        if isFolded { Text(count(node.groups)).mono(11).foregroundStyle(.tertiary) }
                        Spacer(minLength: 0)
                    }
                    .padding(.top, Theme.Space.m).padding(.bottom, 2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if !isFolded {
                    ForEach(Array(node.groups.enumerated()), id: \.element.id) { i, group in
                        folder(group, nested: true, parent: parent, base: node.groups.prefix(i).reduce(0) { $0 + 1 + rowCount($1) })
                    }
                }
            } else {
                ForEach(node.groups) { group in folder(group, nested: false) }
            }
        }
    }

    /// "2 · 5": running terminals · sessions, for a folded row.
    private func count(_ groups: [TerminalTree.Group]) -> String {
        let terminals = groups.reduce(0) { $0 + $1.terminals.count }, sessions = groups.reduce(0) { $0 + $1.sessions.count }
        return terminals > 0 ? "\(terminals) · \(sessions)" : "\(sessions)"
    }

    /// The sessions a folder lists: those not deleted just now, the first few unless all are asked for.
    private func listed(_ group: TerminalTree.Group) -> (sessions: [SessionSummary], more: Int, foot: Bool) {
        let kept = group.sessions.filter { !gone.contains($0.id) }
        let all = showingAll.contains(group.cwd)
        let sessions = all ? kept : Array(kept.prefix(Self.sessionsShown))
        return (sessions, kept.count - sessions.count, kept.count > Self.sessionsShown)
    }

    /// The rows under a folder's line while it is open (the folder's own line not counted).
    private func rowCount(_ group: TerminalTree.Group) -> Int {
        guard !folded.contains(group.cwd) else { return 0 }
        let l = listed(group)
        return group.terminals.count + l.sessions.count + (l.foot ? 1 : 0)
    }

    /// A folder and its rows; `base` is where its line falls among the rows an unfolded parent draws.
    private func folder(_ group: TerminalTree.Group, nested: Bool, parent: String? = nil, base: Int = 0) -> some View {
        let isFolded = folded.contains(group.cwd)
        let all = showingAll.contains(group.cwd)
        let (sessions, more, foot) = listed(group)
        let rows = rowCount(group)
        return VStack(alignment: .leading, spacing: 0) {
            Button { toggleFold(group.cwd) } label: {
                HStack(spacing: 6) {
                    Text("\(nested ? "  " : "")\(isFolded ? "▸" : "▾") \(group.name)/").mono(13, weight: .semibold)
                    if let git = group.git {
                        Text(git.said).mono(11).foregroundStyle(.tertiary).lineLimit(1)
                            .accessibilityLabel("git \(git.said)")
                    }
                    if isFolded { Text(count([group])).mono(11).foregroundStyle(.tertiary) }
                    Spacer(minLength: 0)
                }
                .padding(.top, nested ? Theme.Space.s : Theme.Space.m)
                .padding(.bottom, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(isFolded ? "展开" : "收起")
            .modifier(stepIn(base, under: parent))
            if !isFolded {
                ForEach(Array(group.terminals.enumerated()), id: \.element.id) { i, t in
                    Button { path.append(TerminalRoute.terminal(t)) } label: { terminalRow(t, last: i == rows - 1, nested: nested) }
                        .buttonStyle(.plain)
                        .modifier(stepIn(base + 1 + i, under: group.cwd, parent))
                    // Its sub-agents, one level under it; a tap opens the terminal.
                    if t.isRunning {
                        ForEach(Array(t.subagents.enumerated()), id: \.element.id) { k, agent in
                            Button { path.append(TerminalRoute.terminal(t)) } label: {
                                SubagentRow(agent: agent, underLast: i == rows - 1, last: k == t.subagents.count - 1, nested: nested)
                            }
                            .buttonStyle(.plain)
                            .modifier(stepIn(base + 1 + i, under: group.cwd, parent))
                        }
                    }
                }
                ForEach(Array(sessions.enumerated()), id: \.element.id) { i, s in
                    let index = group.terminals.count + i
                    SessionRow(session: s, last: index == rows - 1, nested: nested, opening: opening,
                               open: { path.append(TerminalRoute.session(s)) },
                               resume: { Task { await resume(s) } },
                               menu: { anchor in menuFor = SessionMenu(session: s, anchor: anchor) },
                               delete: { deletingSession = s })
                        .modifier(WipeOut(on: wiping.contains(s.id)))
                        // Those "more" brings are drawn from the first of them.
                        .modifier(stepIn(base + 1 + (all && i >= Self.sessionsShown ? index - Self.sessionsShown : index), under: group.cwd, parent))
                }
                if foot {
                    Button {
                        if all { showingAll.remove(group.cwd) } else { showingAll.insert(group.cwd); revealed = Reveal(key: group.cwd) }
                    } label: {
                        HStack(spacing: 6) {
                            TreeLine(last: true, nested: nested)
                            Text(all ? "▾ Less" : "▸ \(more) More").mono(12).foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .modifier(stepIn(base + rows, under: group.cwd, parent))
                }
            }
        }
    }

    private func terminalRow(_ t: TerminalInfo, last: Bool, nested: Bool, title: Text? = nil) -> some View {
        let status = t.permissions.isEmpty ? t.status : .waiting
        return HStack(spacing: 8) {
            TreeLine(last: last, nested: nested)
            TerminalStatusMark(status: status)
            (title ?? Text(t.name)).font(.subheadline).foregroundStyle(t.isRunning ? Theme.ink : .secondary).lineLimit(1)
            Spacer(minLength: 6)
            PixelSprite(rows: PixelArt.agents[t.harness] ?? PixelArt.square, pixel: 2, color: .secondary)
            Text("›").mono(13).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        // Now and then while it works (2026-10-01, user: 正在运行中的都改成这个效果); the full burst once, as it comes to
        // need you or exits.
        .runningGlitch(status == .working)
        .glitch(on: status, when: { $0 == .waiting || $0 == .exited })
    }

    // MARK: search

    /// A prompt line over the list: `/` as less and vim search, then what is typed; × clears it.
    private var searchLine: some View {
        HStack(spacing: 6) {
            Text("/").mono(14, weight: .bold).foregroundStyle(Theme.signal)
            TextField("", text: $query, prompt: Text("Search").foregroundStyle(Theme.inkDim))
                .font(.system(size: 14, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .tint(Theme.signal)
                .accessibilityLabel("搜索文件夹和会话")
            if !query.isEmpty {
                Button { query = "" } label: { Text("×").mono(15).foregroundStyle(.secondary).frame(minWidth: 24, minHeight: 24) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
        .padding(.top, 4)
        .padding(.bottom, 2)
    }

    /// What matched, in the tree's order and shape, the match marked; a match in the words shows them under the row.
    @ViewBuilder
    private func searchResults(_ result: TerminalSearch.Result) -> some View {
        if result.folders.isEmpty {
            Text("没有找到与“\(query.trimmingCharacters(in: .whitespaces))”相关的文件夹或会话。")
                .font(.footnote).foregroundStyle(.secondary).padding(.vertical, 18)
        } else {
            Text(result.summary).mono(11).foregroundStyle(.tertiary).padding(.top, 8)
            ForEach(result.folders) { folder in
                HStack(spacing: 6) {
                    (Text("▾ ") + marked(folder.name) + Text("/")).mono(13, weight: .semibold)
                    if let git = folder.git { Text(git.said).mono(11).foregroundStyle(.tertiary).lineLimit(1) }
                    Spacer(minLength: 0)
                }
                .padding(.top, Theme.Space.m)
                .padding(.bottom, 4)
                ForEach(Array(folder.rows.enumerated()), id: \.element.id) { i, row in
                    let last = i == folder.rows.count - 1
                    switch row.item {
                    case .terminal(let t):
                        Button { path.append(TerminalRoute.terminal(t)) } label: {
                            terminalRow(t, last: last, nested: false, title: row.titleHit ? marked(t.name) : nil)
                        }
                        .buttonStyle(.plain)
                        if let words = row.said { hitLine(words, last: last) { path.append(TerminalRoute.terminal(t)) } }
                    case .session(let s):
                        SessionRow(session: s, last: last, nested: false, opening: opening, title: row.titleHit ? marked(s.displayTitle) : nil,
                                   open: { path.append(TerminalRoute.session(s)) },
                                   resume: { Task { await resume(s) } },
                                   menu: { anchor in menuFor = SessionMenu(session: s, anchor: anchor) },
                                   delete: { deletingSession = s })
                        if let words = row.said { hitLine(words, last: last) { path.append(TerminalRoute.session(s)) } }
                    }
                }
            }
        }
    }

    /// A line of the words where a session matched, quiet, under its row.
    private func hitLine(_ words: String, last: Bool, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Text("\(last ? "  " : "│ ")└─").mono(13).foregroundStyle(Theme.inkDim)
                marked(TerminalSearch.near(query, in: words)).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.bottom, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// `text` with the match on the signal colour, as the web list marks it.
    private func marked(_ text: String) -> Text {
        var attributed = AttributedString(text)
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty, let range = attributed.range(of: q, options: [.caseInsensitive]) {
            attributed[range].backgroundColor = Theme.signal
            attributed[range].foregroundColor = .black
        }
        return Text(attributed)
    }

    /// Sessions whose record the Mac can delete (OpenCode keeps its own database).
    static let deletable: Set<String> = ["claude-code", "codex"]

    /// The row is wiped out while the Mac deletes the record; it comes back if that fails.
    private func deleteSession(_ s: SessionSummary) async {
        guard let api = model.api else { return }
        wiping.insert(s.id)
        async let deleted: Void = api.deleteSession(harness: s.harness, id: s.sessionId)
        try? await Task.sleep(for: .milliseconds(210))
        gone.insert(s.id)
        wiping.remove(s.id)
        do {
            try await deleted
            await model.refreshTerminals(sessions: true)
        } catch {
            gone.remove(s.id)
            failure = error.localizedDescription
        }
    }

    static let resumable: Set<String> = ["claude-code", "codex", "opencode"]

    /// `new`, or a terminal (from the Live Activity) in place of the page open now; one closed since is not found.
    private func openRequested() {
        guard let id = model.openTerminalRequest else { return }
        if id == "new" { model.openTerminalRequest = nil; creating = true; return }
        guard let list = model.terminals.list else { return }
        model.openTerminalRequest = nil
        if let t = list.terminals.first(where: { $0.id == id }) { path = NavigationPath([TerminalRoute.terminal(t)]) }
    }

    private struct Elsewhere: Equatable {
        let session: SessionSummary
        let app: String
        let mode: String?
    }

    /// Continue a session in place (one record, one writer): the terminal that has it already, a new one, or — open in
    /// another program — the choice to fork. It goes on in the mode it last had; bypass is asked about first.
    private func resume(_ s: SessionSummary, fork: Bool = false, mode chosen: String? = nil) async {
        guard let api = model.api else { return }
        if s.mode == "bypass" && chosen == nil { bypassResume = s; return }
        opening = s.id
        defer { opening = nil }
        let mode = chosen ?? s.mode
        do {
            switch try await api.resumeTerminal(ResumeTerminalRequest(harness: s.harness, cwd: s.cwd, agentSessionId: s.sessionId,
                                                                      title: s.title.isEmpty ? nil : s.title, mode: mode, fork: fork ? true : nil)) {
            case .started(let t), .existing(let t):
                model.terminals.add(t)
                path.append(TerminalRoute.terminal(t))
            case .elsewhere(let app, _):
                elsewhere = Elsewhere(session: s, app: app ?? "其他程序", mode: mode)
            }
        } catch {
            failure = error.localizedDescription
        }
    }
}

private struct SessionMenu: Equatable {
    let session: SessionSummary
    let anchor: CGRect
}

private struct Reveal {
    let key: String
    var at = Date.now
}

/// Where a view is on the screen, kept without redrawing anything as it scrolls (read when its menu opens).
private final class FrameRef {
    var rect: CGRect = .zero
}

/// One of the Mac's earlier sessions under its folder: a tap reads it, `resume` goes on with it, a long press opens
/// its menu by the row (the row is lit while held).
private struct SessionRow: View {
    let session: SessionSummary
    let last: Bool
    let nested: Bool
    let opening: String?
    /// Its title as a search marks it; else as it is.
    var title: Text? = nil
    let open: () -> Void
    let resume: () -> Void
    let menu: (CGRect) -> Void
    let delete: () -> Void
    @State private var held = false
    @State private var frame = FrameRef()

    var body: some View {
        let resumable = TerminalsTab.resumable.contains(session.harness)
        let deletable = TerminalsTab.deletable.contains(session.harness)
        HStack(spacing: 8) {
            TreeLine(last: last, nested: nested)
            HStack(spacing: 8) {
                (title ?? Text(session.displayTitle)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 6)
                // Which agent wrote it, before its time (as on the Mac): the mark a running terminal has, dimmed.
                PixelSprite(rows: PixelArt.agents[session.harness] ?? PixelArt.square, pixel: 2, color: Theme.inkDim)
                    .accessibilityLabel(NewTerminalSheet.agents.first { $0.id == session.harness }?.name ?? session.harness)
                Text(session.updated.relative).mono(11).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .onLongPressGesture(minimumDuration: 0.45) {
                guard resumable || deletable else { return }
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                menu(frame.rect)
            } onPressingChanged: { held = $0 }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: "delete") { if deletable { delete() } }
            if resumable {
                Button(action: resume) {
                    if opening == session.id { BrailleSpinner(color: .secondary) } else { Text("Resume").mono(12) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.ink)
                .disabled(opening != nil)
            }
        }
        .padding(.vertical, 8)
        .background(held ? Theme.raised : Color.clear)
        .contentShape(Rectangle())
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame.rect = $0 }
    }
}

/// `├─` / `└─` in front of a row (indented once more under a merged parent).
private struct TreeLine: View {
    let last: Bool
    var nested = false

    var body: some View {
        Text("\(nested ? "  " : "")\(last ? "└─" : "├─")").mono(13).foregroundStyle(Theme.inkDim)
    }
}

/// A terminal's sub-agent at work, one level under it (docs/terminal-v0.md §1): what it was sent to do and what it is
/// doing now, its kind at the end; the spinner while it works.
private struct SubagentRow: View {
    let agent: TerminalSubagent
    /// Its terminal is the folder's last row: no line runs on under it.
    let underLast: Bool
    let last: Bool
    let nested: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text("\(nested ? "  " : "")\(underLast ? "  " : "│ ")\(last ? "└─" : "├─")").mono(13).foregroundStyle(Theme.inkDim)
            BrailleSpinner()
            (Text(agent.name).foregroundStyle(.secondary) + Text(agent.doing.isEmpty ? "" : "  \(agent.doing)").foregroundStyle(.tertiary))
                .font(.footnote).lineLimit(1)
            Spacer(minLength: 6)
            Text(agent.type).mono(10).foregroundStyle(.tertiary).lineLimit(1)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("子代理 \(agent.name)，\(agent.type)\(agent.doing.isEmpty ? "" : "，\(agent.doing)")")
    }
}

/// A terminal's state in pixels (§7.2.5: only running terminals carry one): the spinner while busy, a square while
/// waiting (blinking) or idle, hollow once exited.
struct TerminalStatusMark: View {
    let status: TerminalStatus

    var body: some View {
        switch status {
        case .working: BrailleSpinner()
        case .waiting: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting).waitingBlink()
        case .exited: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Theme.inkDim)
        default: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done)
        }
    }
}
