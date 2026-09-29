import AgentSwitchKit
import SwiftUI

/// Where the terminals tab leads by value: one terminal, one of the Mac's other sessions (read only, with resume).
enum TerminalRoute: Hashable {
    case terminal(TerminalInfo)
    case session(SessionSummary)
}

/// The terminals tab (docs/terminal-v0.md §1): a directory tree of the Mac's terminals and its earlier sessions, as the
/// web page's sidebar — each project folder with its running terminals (status mark, name, agent) and then its sessions
/// (resume); projects under one parent merged under it. `new` starts one.
struct TerminalsTab: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()
    @State private var creating = false
    @State private var elsewhere: Elsewhere?
    @State private var opening: String?

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
                    if store.list != nil && store.nodes.isEmpty {
                        Text("尚无终端。点 new 在 Mac 上启动 agent。").font(.footnote).foregroundStyle(.secondary).padding(.top, 40)
                    }
                    ForEach(store.nodes) { node in nodeView(node) }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            .background(Theme.base)
            .navigationTitle("terminals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("new") { creating = true }.mono(15, weight: .medium)
                        .disabled(store.list == nil)
                }
            }
            .navigationDestination(for: TerminalRoute.self) { route in
                switch route {
                case .terminal(let t): TerminalPage(terminal: t)
                case .session(let s): SessionTranscriptView(session: s, resume: { Task { await resume(s) } })
                }
            }
            .refreshable { await model.refreshTerminals(sessions: true) }
            .onAppear { openRequested() }
            .onChange(of: model.openTerminalRequest) { openRequested() }
            // A cold start from the Live Activity: the request is there before the list.
            .onChange(of: store.list == nil) { openRequested() }
            // The list itself is followed from every tab (MainTabs); the sessions while this tab is on screen.
            .task(id: model.connection.endpoint) {
                while !Task.isCancelled {
                    await store.refreshSessions(model.api)
                    try? await Task.sleep(for: Self.pollInterval)
                }
            }
            .sheet(isPresented: $creating) {
                NewTerminalSheet { terminal in
                    store.add(terminal)
                    path.append(TerminalRoute.terminal(terminal))
                }
            }
            .confirmationDialog(elsewhere.map { "「\($0.session.displayTitle)」正在 \($0.app) 中运行" } ?? "", isPresented: Binding(
                get: { elsewhere != nil }, set: { if !$0 { elsewhere = nil } }), titleVisibility: .visible) {
                Button("fork") { if let e = elsewhere { Task { await resume(e.session, fork: true) } } }
            } message: {
                Text("同一会话同时只能由一个程序写入。请先在 \(elsewhere?.app ?? "该程序") 中退出，或创建分支：新会话包含全部历史，原会话保持不变。")
            }
        }
    }

    @ViewBuilder
    private func nodeView(_ node: TerminalTree.Node) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let parent = node.parentName {
                Text("▾ \(parent)/").mono(12).foregroundStyle(Theme.inkDim).padding(.top, Theme.Space.m).padding(.bottom, 2)
            }
            ForEach(node.groups) { group in
                folder(group, nested: node.parent != nil)
            }
        }
    }

    private func folder(_ group: TerminalTree.Group, nested: Bool) -> some View {
        let sessions = Array(group.sessions.prefix(Self.sessionsShown))
        let more = group.sessions.count - sessions.count
        let rows = group.terminals.count + sessions.count + (more > 0 ? 1 : 0)
        return VStack(alignment: .leading, spacing: 0) {
            Text("\(nested ? "  " : "")▾ \(group.name)/")
                .mono(13, weight: .semibold)
                .padding(.top, nested ? Theme.Space.s : Theme.Space.m)
                .padding(.bottom, 4)
            ForEach(Array(group.terminals.enumerated()), id: \.element.id) { i, t in
                Button { path.append(TerminalRoute.terminal(t)) } label: { terminalRow(t, last: i == rows - 1, nested: nested) }
                    .buttonStyle(.plain)
            }
            ForEach(Array(sessions.enumerated()), id: \.element.id) { i, s in
                sessionRow(s, last: group.terminals.count + i == rows - 1, nested: nested)
            }
            if more > 0 {
                HStack(spacing: 6) {
                    TreeLine(last: true, nested: nested)
                    Text("▸ \(more) more").mono(12).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
        }
    }

    private func terminalRow(_ t: TerminalInfo, last: Bool, nested: Bool) -> some View {
        HStack(spacing: 8) {
            TreeLine(last: last, nested: nested)
            TerminalStatusMark(status: t.permissions.isEmpty ? t.status : .waiting)
            Text(t.name).font(.subheadline).foregroundStyle(t.isRunning ? Theme.ink : .secondary).lineLimit(1)
            Spacer(minLength: 6)
            PixelSprite(rows: PixelArt.agents[t.harness] ?? PixelArt.square, pixel: 2, color: .secondary)
            Text("›").mono(13).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }

    private func sessionRow(_ s: SessionSummary, last: Bool, nested: Bool) -> some View {
        HStack(spacing: 8) {
            TreeLine(last: last, nested: nested)
            Button { path.append(TerminalRoute.session(s)) } label: {
                HStack(spacing: 8) {
                    Text(s.displayTitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(s.updated.relative).mono(11).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if TerminalsTab.resumable.contains(s.harness) {
                Button { Task { await resume(s) } } label: {
                    if opening == s.id { BrailleSpinner(color: .secondary) } else { Text("resume").mono(12) }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.ink)
                .disabled(opening != nil)
            }
        }
        .padding(.vertical, 8)
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

    private struct Elsewhere {
        let session: SessionSummary
        let app: String
    }

    /// Continue a session in place (one record, one writer): the terminal that has it already, a new one, or — open in
    /// another program — the choice to fork. Bypass is the Mac's to choose: a bypass session goes on here in auto.
    private func resume(_ s: SessionSummary, fork: Bool = false) async {
        guard let api = model.api else { return }
        opening = s.id
        defer { opening = nil }
        let mode = s.mode == "bypass" ? "auto" : s.mode
        do {
            switch try await api.resumeTerminal(ResumeTerminalRequest(harness: s.harness, cwd: s.cwd, agentSessionId: s.sessionId,
                                                                      title: s.title.isEmpty ? nil : s.title, mode: mode, fork: fork ? true : nil)) {
            case .started(let t), .existing(let t):
                model.terminals.add(t)
                path.append(TerminalRoute.terminal(t))
            case .elsewhere(let app, _):
                elsewhere = Elsewhere(session: s, app: app ?? "其他程序")
            }
        } catch {
            model.terminals.error = error.localizedDescription
        }
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

/// A terminal's state in pixels (§7.2.5: only running terminals carry one): the spinner while busy, a square while
/// waiting or idle, hollow once exited.
struct TerminalStatusMark: View {
    let status: TerminalStatus

    var body: some View {
        switch status {
        case .working: BrailleSpinner()
        case .waiting: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting)
        case .exited: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Theme.inkDim)
        default: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done)
        }
    }
}
