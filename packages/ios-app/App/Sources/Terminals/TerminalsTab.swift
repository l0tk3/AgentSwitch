import AgentSwitchKit
import SwiftUI

/// Where the terminals tab leads by value: one terminal, one of the Mac's other sessions (read only, with resume).
enum TerminalRoute: Hashable {
    case terminal(TerminalInfo)
    case session(SessionSummary)
}

/// The terminals tab (docs/terminal-v0.md §1): a directory tree of the Mac's terminals and its earlier sessions, as the
/// web page's sidebar — each project folder with its running terminals (status mark, name, agent), then its sessions
/// (resume), then the folders under it (TerminalTree has the rules). A folder's line folds and unfolds (remembered); `▸ N
/// more` lists all of a folder's sessions, the rows drawn line by line; a long press on a session opens its menu
/// (resume, delete — a deleted row is wiped out). A terminal that needs you or exits glitches once. Menus and confirm
/// boxes are the desktop's pixel boxes; the list has its scanlines and a rule under the bar. `new` starts one.
/// In the classic look (docs/ui-v0.md §8) the tree is drawn by indentation: a chevron and a folder for a folder's line,
/// dots for the terminals' states, a clock before a session; the search line is a round field.
struct TerminalsTab: View {
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
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
    /// A session to continue whose folder is gone: a folder is picked for it (docs/terminal-v0.md §5).
    @State private var movedFolder: MovedFolder?
    /// The search line (docs/terminal-v0.md §1 搜索); the Mac's answer for the words said in sessions, and what it was
    /// asked.
    @State private var query = ""
    @State private var said: [String: String] = [:]
    @State private var saidFor = ""

    static let pollInterval: Duration = .seconds(4)
    /// The sessions are read every this many rounds (20 s, as the web page).
    static let sessionsEvery = 5
    /// Sessions shown per folder before `▸ N more`.
    static let sessionsShown = 3

    var body: some View {
        let store = model.terminals
        let folders = store.folders
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.connection.endpoint == nil {
                        ConnectionBanner().padding(.bottom, Theme.Space.m)
                    }
                    if let error = store.error {
                        Text(error).font(.footnote).foregroundStyle(Theme.failed).padding(.bottom, Theme.Space.m)
                    }
                    if store.list != nil && folders.isEmpty && query.isEmpty {
                        Text("尚无终端。点 New 在 Mac 上启动 agent。").font(.footnote).foregroundStyle(.secondary).padding(.top, 40)
                    }
                    if store.list != nil && !(folders.isEmpty && query.isEmpty) { searchLine }
                    if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        ForEach(folders) { f in folderView(f, depth: 0, at: 0, above: []) }
                    } else {
                        searchResults(TerminalSearch.run(folders, query: query, said: saidFor == query ? said : [:]))
                    }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            .background { ZStack { Theme.base; Scanlines() }.ignoresSafeArea() }
            .safeAreaInset(edge: .top, spacing: 0) { HairRule() }
            .navigationTitle("Terminals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: {
                        if look.isClassic { Image(systemName: "plus") } else { Text("New").mono(15, weight: .medium) }
                    }
                    .accessibilityLabel("New")
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
                if let first = folders.flatMap(\.allSessions).first {
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
            // The list itself is followed from every tab (MainTabs); the folders' git and the sessions while this tab
            // is on screen — the sessions, all of them now (docs/terminal-v0.md §4), every fifth time: they change
            // slowly, and the whole list is the larger read (pull to refresh reads them at once).
            .task(id: model.connection.endpoint) {
                var round = 0
                while !Task.isCancelled {
                    if round % Self.sessionsEvery == 0 { await store.refreshSessions(model.api) }
                    await store.refreshGit(model.api)
                    round += 1
                    try? await Task.sleep(for: Self.pollInterval)
                }
            }
            .sheet(isPresented: $creating) {
                NewTerminalSheet { terminal in
                    store.add(terminal)
                    unfold(terminal.cwd)
                    path.append(TerminalRoute.terminal(terminal))
                }
            }
            .sheet(item: $movedFolder) { m in
                MovedFolderSheet(gone: m) { folder in Task { await resume(m.session, fork: m.fork, mode: m.mode, in: folder, after: m) } }
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
                         actions: [.init(label: "Fork", role: .primary) { Task { await resume(e.session, fork: true, mode: e.mode, in: e.folder) } }])
            }
        }
        .pixelBox(item: $failure) { message in
            PixelBox(head: "Error", tone: .red, message: message, cancel: nil, actions: [.init(label: "OK", role: .primary) {}])
        }
    }

    private var folded: Set<String> { Set(foldedRaw.split(separator: "\n").map(String.init)) }

    /// A terminal just started or continued shows in the list: its folder and every folder above it open
    /// (docs/terminal-v0.md §1, as the web page).
    private func unfold(_ cwd: String) {
        let set = folded.subtracting(TerminalTree.foldersAbove(cwd))
        if set.count != folded.count { foldedRaw = set.sorted().joined(separator: "\n") }
    }

    private func toggleFold(_ key: String) {
        var set = folded
        if set.remove(key) == nil { set.insert(key) } else { revealed = Reveal(key: key) }
        foldedRaw = set.sorted().joined(separator: "\n")
    }

    /// A folder a line sits in, and where that folder's own line falls.
    private struct Within {
        let key: String
        let at: Int
    }

    /// A line that came with the unfold of one of the folders it sits in just now draws at its turn after that
    /// folder's line.
    private func stepIn(_ at: Int, within: [Within]) -> StepIn {
        guard let r = revealed, Date.now.timeIntervalSince(r.at) < 0.4, let w = within.first(where: { $0.key == r.key }) else {
            return StepIn(index: 0, active: false)
        }
        return StepIn(index: max(0, at - w.at), active: true)
    }

    /// "2 · 5": terminals · sessions in the folder and the folders under it, for a folded line.
    private func count(_ f: TerminalTree.Folder) -> String {
        let terminals = f.allTerminals.count, sessions = f.allSessions.count
        return terminals > 0 ? "\(terminals) · \(sessions)" : "\(sessions)"
    }

    /// The sessions a folder lists: those not deleted just now, the first few unless all are asked for.
    private func listed(_ f: TerminalTree.Folder) -> (sessions: [SessionSummary], more: Int, foot: Bool) {
        let kept = f.sessions.filter { !gone.contains($0.id) }
        let all = showingAll.contains(f.cwd)
        let sessions = all ? kept : Array(kept.prefix(Self.sessionsShown))
        return (sessions, kept.count - sessions.count, kept.count > Self.sessionsShown)
    }

    /// A folder's own rows while it is open: its terminals, its sessions, `▸ N More`.
    private func ownRows(_ f: TerminalTree.Folder) -> Int {
        let l = listed(f)
        return f.terminals.count + l.sessions.count + (l.foot ? 1 : 0)
    }

    /// The lines under a folder's own line while it is open: its rows, then the folders under it with theirs.
    private func drawn(_ f: TerminalTree.Folder) -> Int {
        guard !folded.contains(f.cwd) else { return 0 }
        return ownRows(f) + f.children.reduce(0) { $0 + 1 + drawn($1) }
    }

    /// A folder's line, its own terminals and sessions, then the folders under it one step further in. `at` is where
    /// its line falls among the lines its top folder draws; `above`, the folders it sits in. A folder that only gathers
    /// others has the quieter line.
    private func folderView(_ f: TerminalTree.Folder, depth: Int, at: Int, above: [Within]) -> AnyView {
        let isFolded = folded.contains(f.cwd)
        let all = showingAll.contains(f.cwd)
        let (sessions, more, foot) = listed(f)
        let rows = isFolded ? 0 : ownRows(f)
        let within = [Within(key: f.cwd, at: at)] + above
        let line = "\(String(repeating: "  ", count: depth))\(isFolded ? "▸" : "▾") \(TerminalTree.slashed(f.name))"
        return AnyView(VStack(alignment: .leading, spacing: 0) {
            Button { toggleFold(f.cwd) } label: {
                HStack(spacing: 6) {
                    if look.isClassic {
                        ClassicFolderLine(name: f.name, folded: isFolded, depth: depth, own: f.holdsOwn)
                    } else if f.holdsOwn {
                        Text(line).mono(13, weight: .semibold)
                    } else {
                        Text(line).mono(12).foregroundStyle(Theme.inkDim)
                    }
                    if let git = f.git {
                        Text(git.said).mono(11).foregroundStyle(.tertiary).lineLimit(1)
                            .accessibilityLabel("git \(git.said)")
                    }
                    if isFolded { Text(count(f)).mono(11).foregroundStyle(.tertiary) }
                    Spacer(minLength: 0)
                }
                .padding(.top, depth == 0 ? Theme.Space.m : Theme.Space.s)
                .padding(.bottom, f.holdsOwn ? 4 : 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(isFolded ? "展开" : "收起")
            .modifier(stepIn(at, within: above))
            if !isFolded {
                ForEach(Array(f.terminals.enumerated()), id: \.element.id) { i, t in
                    Button { path.append(TerminalRoute.terminal(t)) } label: { terminalRow(t, last: i == rows - 1, depth: depth) }
                        .buttonStyle(.plain)
                        .modifier(stepIn(at + 1 + i, within: within))
                    // Its sub-agents, one level under it; a tap opens the terminal.
                    if t.isRunning {
                        ForEach(Array(t.subagents.enumerated()), id: \.element.id) { k, agent in
                            Button { path.append(TerminalRoute.terminal(t)) } label: {
                                SubagentRow(agent: agent, underLast: i == rows - 1, last: k == t.subagents.count - 1, depth: depth)
                            }
                            .buttonStyle(.plain)
                            .modifier(stepIn(at + 1 + i, within: within))
                        }
                    }
                }
                ForEach(Array(sessions.enumerated()), id: \.element.recordID) { i, s in
                    let index = f.terminals.count + i
                    SessionRow(session: s, last: index == rows - 1, depth: depth, opening: opening,
                               open: { path.append(TerminalRoute.session(s)) },
                               resume: { Task { await resume(s) } },
                               menu: { anchor in menuFor = SessionMenu(session: s, anchor: anchor) },
                               delete: { deletingSession = s })
                        .modifier(WipeOut(on: wiping.contains(s.id)))
                        // Those "more" brings are drawn from the first of them.
                        .modifier(stepIn(at + 1 + (all && i >= Self.sessionsShown ? index - Self.sessionsShown : index), within: within))
                }
                // ▸ opens the rest under it; ▴ folds them back up (2026-10-03, user: 这个图标也有问题吧，有点误导人 — ▾ under
                // the list read as a folder still to open).
                if foot {
                    Button {
                        if all { showingAll.remove(f.cwd) } else { showingAll.insert(f.cwd); revealed = Reveal(key: f.cwd) }
                    } label: {
                        HStack(spacing: 6) {
                            TreeLine(last: true, depth: depth)
                            if look.isClassic {
                                Image(systemName: all ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold)).frame(width: 16)
                                Text(all ? "Less" : "\(more) More").mono(13)
                            } else {
                                Text(all ? "▴ Less" : "▸ \(more) More").mono(12)
                            }
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .modifier(stepIn(at + rows, within: within))
                }
                ForEach(Array(f.children.enumerated()), id: \.element.id) { i, child in
                    folderView(child, depth: depth + 1, at: at + 1 + rows + f.children.prefix(i).reduce(0) { $0 + 1 + drawn($1) }, above: within)
                }
            }
        })
    }

    private func terminalRow(_ t: TerminalInfo, last: Bool, depth: Int, title: Text? = nil) -> some View {
        let status = t.permissions.isEmpty ? t.status : .waiting
        return HStack(spacing: 8) {
            TreeLine(last: last, depth: depth)
            TerminalStatusMark(status: status).frame(width: look.isClassic ? 16 : nil)
            (title ?? Text(t.name)).font(.subheadline).foregroundStyle(t.isRunning ? Theme.ink : .secondary).lineLimit(1)
            Spacer(minLength: 6)
            // The classic look says what its dot means (the pixel look's square blinks).
            if look.isClassic && status == .waiting { NeedsYouPill() }
            PixelSprite(rows: PixelArt.agents[t.harness] ?? PixelArt.square, pixel: 2, color: .secondary, strength: 0.8, shadow: false)
            LookGlyph(glyph: "›", symbol: "chevron.right").foregroundStyle(.tertiary)
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
            if look.isClassic {
                Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.inkDim)
            } else {
                Text("/").mono(14, weight: .bold).foregroundStyle(Theme.signal)
            }
            TextField("", text: $query, prompt: Text("Search").foregroundStyle(Theme.inkDim))
                .mono(look.isClassic ? 15 : 14)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .tint(Theme.signal)
                .accessibilityLabel("搜索文件夹和会话")
            if !query.isEmpty {
                Button { query = "" } label: {
                    Group {
                        if look.isClassic { Image(systemName: "xmark.circle.fill").font(.system(size: 15)) } else { Text("×").mono(15) }
                    }
                    .foregroundStyle(.secondary).frame(minWidth: 24, minHeight: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, look.isClassic ? 7 : 6)
        // A framed prompt line; a round field on a quiet ground in the classic look.
        .grounded(look.isClassic ? Theme.raised : Color.clear, radius: 10)
        .framed(look.isClassic ? Color.clear : Theme.line, radius: 10)
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
                    if look.isClassic {
                        ClassicFolderLine(name: folder.name, folded: false, depth: 0, own: true, title: marked(folder.name.hasSuffix("/") ? String(folder.name.dropLast()) : folder.name))
                    } else {
                        (Text("▾ ") + marked(folder.name) + Text(folder.name.hasSuffix("/") ? "" : "/")).mono(13, weight: .semibold)
                    }
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
                            terminalRow(t, last: last, depth: 0, title: row.titleHit ? marked(t.name) : nil)
                        }
                        .buttonStyle(.plain)
                        if let words = row.said { hitLine(words, last: last) { path.append(TerminalRoute.terminal(t)) } }
                    case .session(let s):
                        SessionRow(session: s, last: last, depth: 0, opening: opening, title: row.titleHit ? marked(s.displayTitle) : nil,
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
                if look.isClassic {
                    Color.clear.frame(width: ClassicTree.lead + ClassicTree.step, height: 1)
                } else {
                    Text("\(last ? "  " : "│ ")└─").mono(13).foregroundStyle(Theme.inkDim)
                }
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
            // On the signal colour, in black; a wash of the accent in the classic look.
            attributed[range].backgroundColor = look.isClassic ? Theme.signal.opacity(0.3) : Theme.signal
            if !look.isClassic { attributed[range].foregroundColor = .black }
        }
        return Text(attributed)
    }

    /// Sessions whose record the Mac can delete: every agent's (docs/terminal-v0.md §5; OpenCode, through its own command,
    /// and pi since 2026-10-01, user: opencode、pi 都加上删除支持).
    static let deletable: Set<String> = ["claude-code", "codex", "opencode", "pi"]

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
        /// The folder picked for it, its own being gone.
        let folder: String?
    }

    /// Continue a session in place (one record, one writer): the terminal that has it already, a new one, or — open in
    /// another program — the choice to fork. It goes on in the mode it last had; bypass is asked about first. Its folder
    /// gone, a folder is picked and it goes on `in` that one (`after` the box it was picked in).
    private func resume(_ s: SessionSummary, fork: Bool = false, mode chosen: String? = nil, in folder: String? = nil, after picking: MovedFolder? = nil) async {
        guard let api = model.api else { return }
        if s.mode == "bypass" && chosen == nil { bypassResume = s; return }
        opening = s.id
        defer { opening = nil }
        let mode = chosen ?? s.mode
        let request = ResumeTerminalRequest(harness: s.harness, cwd: s.cwd, agentSessionId: s.sessionId,
                                            title: s.title.isEmpty ? nil : s.title, mode: mode, fork: fork ? true : nil)
        do {
            switch try await api.resumeTerminal(folder.map(request.continuing) ?? request) {
            case .started(let t), .existing(let t):
                model.terminals.add(t)
                unfold(t.cwd)
                path.append(TerminalRoute.terminal(t))
            case .elsewhere(let app, _):
                elsewhere = Elsewhere(session: s, app: app ?? "其他程序", mode: mode, folder: folder)
            case .folderGone(let cwd, let alike, let near):
                if let picking, let folder { movedFolder = picking.picked(folder) }
                else { movedFolder = MovedFolder(session: s, cwd: cwd, alike: alike, near: near, fork: fork, mode: mode) }
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
    /// How many folders it sits in under the top one.
    let depth: Int
    let opening: String?
    /// Its title as a search marks it; else as it is.
    var title: Text? = nil
    let open: () -> Void
    let resume: () -> Void
    let menu: (CGRect) -> Void
    let delete: () -> Void
    @State private var held = false
    @State private var frame = FrameRef()
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let resumable = TerminalsTab.resumable.contains(session.harness)
        let deletable = TerminalsTab.deletable.contains(session.harness)
        HStack(spacing: 8) {
            TreeLine(last: last, depth: depth)
            // The classic look: a clock where a terminal has its dot (an earlier session, to go on with).
            if look.isClassic { Image(systemName: "clock").font(.system(size: 12)).foregroundStyle(Theme.inkDim).frame(width: 16) }
            HStack(spacing: 8) {
                (title ?? Text(session.displayTitle)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 6)
                // Which agent wrote it, before its time (as on the Mac): the mark a running terminal has, dimmed.
                PixelSprite(rows: PixelArt.agents[session.harness] ?? PixelArt.square, pixel: 2, color: Theme.inkDim, strength: 0.55, shadow: false)
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
                .foregroundStyle(look.isClassic ? Theme.signal : Theme.ink)
                .disabled(opening != nil)
            }
        }
        .padding(.vertical, 8)
        .background(held ? Theme.raised : Color.clear)
        .contentShape(Rectangle())
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame.rect = $0 }
    }
}

/// `├─` / `└─` in front of a row, indented once more for each folder it sits in under the top one. In the classic look
/// only the indentation: the row starts under its folder's name.
private struct TreeLine: View {
    let last: Bool
    var depth = 0
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            Color.clear.frame(width: ClassicTree.lead + CGFloat(depth) * ClassicTree.step - 8, height: 1)
        } else {
            Text("\(String(repeating: "  ", count: depth))\(last ? "└─" : "├─")").mono(13).foregroundStyle(Theme.inkDim)
        }
    }
}

/// The classic look's tree: how far a folder's rows sit in from its line, and each level from the one above.
private enum ClassicTree {
    /// A chevron and the gap after it: a row's mark sits under its folder's icon.
    static let lead: CGFloat = 20
    static let step: CGFloat = 16
}

/// A folder's line in the classic look: a chevron (down while open), a folder, its name without the slash. A folder
/// that only gathers others is quieter.
private struct ClassicFolderLine: View {
    let name: String
    let folded: Bool
    let depth: Int
    let own: Bool
    /// The name as a search marks it.
    var title: Text? = nil

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: folded ? "chevron.right" : "chevron.down").font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.inkDim).frame(width: 12)
            Image(systemName: "folder").font(.system(size: 14)).foregroundStyle(Theme.secondaryInk)
            (title ?? Text(name.hasSuffix("/") ? String(name.dropLast()) : name))
                .font(.system(size: 13.5, weight: own ? .semibold : .regular))
                .foregroundStyle(own ? Theme.ink : Theme.secondaryInk)
                .lineLimit(1)
        }
        .padding(.leading, CGFloat(depth) * ClassicTree.step)
    }
}

/// `Needs You` on a terminal's row in the classic look: the amber dot said in words.
private struct NeedsYouPill: View {
    var body: some View {
        LookWord("Waiting")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.waiting)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Theme.waiting.opacity(0.18), in: Capsule())
    }
}

/// A terminal's sub-agent at work, one level under it (docs/terminal-v0.md §1): what it was sent to do and what it is
/// doing now, its kind at the end; the spinner while it works.
private struct SubagentRow: View {
    let agent: TerminalSubagent
    /// Its terminal is the folder's last row: no line runs on under it.
    let underLast: Bool
    let last: Bool
    let depth: Int
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 8) {
            if look.isClassic {
                Color.clear.frame(width: ClassicTree.lead + CGFloat(depth + 1) * ClassicTree.step - 8, height: 1)
            } else {
                Text("\(String(repeating: "  ", count: depth))\(underLast ? "  " : "│ ")\(last ? "└─" : "├─")").mono(13).foregroundStyle(Theme.inkDim)
            }
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
/// In the classic look: the system's spinner, a dot (its ring breathing while it waits), a ring once exited.
struct TerminalStatusMark: View {
    let status: TerminalStatus
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch status {
        case .working: BrailleSpinner()
        case .waiting:
            if look.isClassic { ClassicWaitingDot() } else { PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting).waitingBlink() }
        case .exited: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Theme.inkDim)
        default: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done)
        }
    }
}
