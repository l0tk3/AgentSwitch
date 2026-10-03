import AgentSwitchMacCore
import SwiftUI

/// Log (docs/dispatch-v0.md §3; demo `mac-window.html?set=log`, the web's Log page): the dispatch model's decision for
/// each task, newest first — when, where the target came from, the target, the folder and the task; a click opens the
/// decision itself. The segments (DispatchRoutingLogFilter) split what was dispatched, answered with a question instead,
/// or refused.
struct RoutingLogSettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @State private var entries: [DispatchRoutingLogEntry]?
    /// Task id → what was asked, from the newest tasks (the log keeps only a hash of the text).
    @State private var titles: [String: String] = [:]
    @State private var filter = DispatchRoutingLogFilter.all
    @State private var expanded: Set<Int> = []
    @State private var problem: String?
    @State private var loading = false

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }

    var body: some View {
        DispatchSettingsGate {
            if let entries {
                form(entries.filter(filter.matches))
            } else if let problem {
                EmptyPage(title: "Log: Unavailable", symbol: "exclamationmark.triangle", message: problem) {
                    Button("Retry") { Task { await load() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Picker("Show", selection: $filter) {
                    ForEach(DispatchRoutingLogFilter.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("Show")
                Button { Task { await load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh")
                    .disabled(!source.ready || loading)
            }
        }
        .task(id: source.ready) {
            expanded = dispatch.preset.expandedLogRows
            if source.ready { await load() }
        }
    }

    private func form(_ rows: [DispatchRoutingLogEntry]) -> some View {
        Form {
            Section {
                if rows.isEmpty {
                    Text(filter == .all ? "No Decisions" : "No \(filter.title) Decisions").foregroundStyle(.secondary)
                }
                ForEach(rows) { entry in
                    LogRow(entry: entry, title: title(entry), open: expanded.contains(entry.id),
                           home: model.paths.userHome.path, toggle: { toggle(entry.id) },
                           openTask: entry.taskId.map { id in { dispatch.openTask(id) } })
                }
            } footer: {
                Footer("调度模型每次的决定：交给谁、在哪个目录、为什么。点击一行查看完整决定。")
            }
            if let problem, entries != nil {
                Section { SettingsProblemLine(text: problem) }
            }
        }
        .formStyle(.grouped)
    }

    /// What was asked, else the decision's reason, else a dash.
    private func title(_ entry: DispatchRoutingLogEntry) -> String {
        entry.taskId.flatMap { titles[$0] } ?? entry.reason ?? "—"
    }

    private func toggle(_ id: Int) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            entries = try await source.service.routingLog()
            problem = nil
        } catch {
            problem = DispatchSettingsProblem.text(error)
            return
        }
        // The titles are a nicety: the log stands without them.
        if let tasks = try? await source.service.tasks() {
            titles = Dictionary(tasks.map { ($0.id, DispatchText.clip(DispatchText.firstLine(DispatchMessageDisplay.readable($0.task)), 80)) },
                                uniquingKeysWith: { first, _ in first })
        }
    }
}

/// One decision: `10:40  Auto  claude-code/opus-5.5  AgentSwitch  构建 AgentSwitch.app… ▸`; open, the decision as
/// pretty JSON, the notes, a router error, how long it took and how it ended, and the way to its task.
private struct LogRow: View {
    let entry: DispatchRoutingLogEntry
    let title: String
    let open: Bool
    let home: String
    let toggle: () -> Void
    let openTask: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    Text(entry.timeColumn()).mono(12).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
                        .help(TimeText.moment(entry.date))
                    Text(entry.sourceWord).mono(12).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
                    Text(entry.target?.label ?? "—").mono(12).lineLimit(1).truncationMode(.middle)
                        .frame(width: 156, alignment: .leading)
                    Text(folder).mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        .frame(width: 76, alignment: .leading)
                        .help(DisplayPath.short(entry.cwd, home: home))
                    Text(DispatchMessageDisplay.readable(title)).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(open ? "▾" : "▸").mono(11).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open { detail.padding(.leading, 50) }
        }
        .contextMenu {
            if let openTask { Button("Open Task", systemImage: "arrow.up.right.square", action: openTask) }
            if let text = entry.decisionText { Button("Copy Decision", systemImage: "doc.on.doc") { Clipboard.copy(text) } }
        }
    }

    /// The folder's own name (the whole path on hover).
    private var folder: String {
        entry.cwd.isEmpty ? "—" : (entry.cwd as NSString).lastPathComponent
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let text = entry.decisionText {
                Text(text).mono(11.5).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(entry.source == "pin" ? "已指定模型，未经调度模型判断。" : "无调度决定。").font(.callout).foregroundStyle(.secondary)
            }
            if !entry.notes.isEmpty {
                Text(entry.notes).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let error = entry.routerError {
                Text(error).mono(11).foregroundStyle(Color.failed).textSelection(.enabled)
            }
            HStack(spacing: 10) {
                Text(meta).mono(11).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let openTask { Button("Open Task", action: openTask).controlSize(.small) }
            }
        }
    }

    /// `Task 1e04b10a · 1.2s · done`.
    private var meta: String {
        [entry.taskId.map { "Task \($0.prefix(8))" }, entry.routerTime, entry.outcome].compactMap { $0 }.joined(separator: " · ")
    }
}
