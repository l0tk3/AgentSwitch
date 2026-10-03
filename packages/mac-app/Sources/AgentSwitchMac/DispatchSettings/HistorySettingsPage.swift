import AgentSwitchMacCore
import SwiftUI

/// History (docs/dispatch-v0.md §3; demo `mac-window.html?set=history`, the phone's Settings › Manage): search through
/// every task and its result (control-v0 §4), the topics — open or archived — to archive, reopen, rename or delete, and
/// clearing every record. A hit or a topic opens in the main window's Dispatch page (a topic at its latest task).
struct HistorySettingsPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dispatchSettings) private var dispatch
    @State private var search = HistorySearch()
    @State private var query = ""
    @State private var filter = DispatchThreadFilter.open
    @State private var topics: [DispatchThread]?
    @State private var topicProblem: String?
    @State private var busy: Set<String> = []
    @State private var deleting: DispatchThread?
    @State private var renaming: DispatchThread?
    @State private var newTitle = ""
    @State private var confirmClear = false
    @State private var clearing = false
    @State private var cleared = false
    @State private var clearProblem: String?

    private var source: DispatchSettingsSource { DispatchSettingsSource(model: model, environment: dispatch) }

    var body: some View {
        DispatchSettingsGate { form }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await loadTopics() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                        .help("Refresh")
                        .disabled(!source.ready)
                }
            }
            .onAppear {
                if query.isEmpty && !dispatch.preset.historyQuery.isEmpty { query = dispatch.preset.historyQuery }
            }
            // Once the service runs, and again for the other segment.
            .task(id: "\(source.ready) \(filter.rawValue)") { if source.ready { await loadTopics() } }
            .task(id: query) { await search.run(query, source.service) }
            .confirmationDialog("删除话题「\(deleting?.displayTitle ?? "")」？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                                presenting: deleting) { topic in
                Button("Delete Topic", role: .destructive) { Task { await act(on: topic) { try await $0.deleteThread(id: topic.id) } } }
            } message: { _ in
                Text("话题中所有任务的结果和文件，以及对话中关于这些任务的内容将一并删除，且无法恢复。")
            }
            .confirmationDialog("清空全部记录？", isPresented: $confirmClear) {
                Button("Clear History", role: .destructive) { Task { await clear() } }
            } message: {
                Text("全部任务（结果与文件）、话题和对话记录将被删除，这些任务的调度日志、记忆与平台经验一并删除，且无法恢复。有任务正在进行或等你处理时不删除任何内容。环境说明、扩展、密钥和终端不受影响。")
            }
            .alert("Rename Topic", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { topic in
                TextField("Title", text: $newTitle)
                Button("Rename") { Task { await rename(topic) } }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("留空则恢复为自动生成的标题。")
            }
    }

    private var form: some View {
        Form {
            Section {
                SettingsSearchField(text: $query, prompt: "搜索任务和结果")
            } footer: {
                Footer("在全部任务的请求、结果、错误和摘要中搜索。")
            }
            if search.isActive(query) {
                HistorySearchResults(search: search) { dispatch.openTask($0) }
            }
            topicsSection
            Section {
                LabeledContent("清空全部记录") {
                    SettingsDeleteButton("Clear History…") { confirmClear = true }
                        .disabled(clearing)
                }
                if let clearProblem { SettingsProblemLine(text: clearProblem) }
                if cleared { Label("记录已清空。", systemImage: "checkmark.circle.fill").foregroundStyle(Color.ok) }
            } header: {
                SectionLabel("Records")
            } footer: {
                Footer("删除全部任务、话题和对话记录，无法恢复。有任务正在进行时无法清空。")
            }
        }
        .formStyle(.grouped)
    }

    private var topicsSection: some View {
        Section {
            if let topicProblem { SettingsProblemLine(text: topicProblem) }
            if let topics {
                if topics.isEmpty {
                    Text(filter == .archived ? "No Archived Topics" : "No Topics").foregroundStyle(.secondary)
                }
                ForEach(topics) { topic in row(topic) }
            } else if topicProblem == nil {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity)
            }
        } header: {
            HStack {
                SectionLabel("Topics")
                Spacer()
                Picker("Topics", selection: $filter) {
                    Text("Open").tag(DispatchThreadFilter.open)
                    Text("Archived").tag(DispatchThreadFilter.archived)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
            }
        } footer: {
            if filter == .archived { Footer("归档的话题在 7 天后自动删除，期间可恢复。") }
        }
    }

    private func row(_ topic: DispatchThread) -> some View {
        HStack(spacing: 10) {
            Button { Task { await open(topic) } } label: {
                HStack(spacing: 10) {
                    SettingsTopicSquare(id: topic.id)
                    Text(DispatchMessageDisplay.readable(topic.displayTitle)).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(TimeText.moment(topic.lastActive)).mono(11.5).foregroundStyle(.secondary).fixedSize()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(topic.meta())
            if topic.isArchived {
                Button("Reopen") { Task { await act(on: topic) { _ = try await $0.reopenThread(id: topic.id) } } }
                    .disabled(busy.contains(topic.id))
            } else {
                Button("Archive") { Task { await act(on: topic) { _ = try await $0.archiveThread(id: topic.id) } } }
                    .disabled(busy.contains(topic.id))
            }
            SettingsDeleteButton("Delete…") { deleting = topic }
                .disabled(busy.contains(topic.id))
        }
        .contextMenu {
            Button("Open", systemImage: "arrow.up.right.square") { Task { await open(topic) } }
            Button("Rename…", systemImage: "pencil") { newTitle = topic.title ?? ""; renaming = topic }
            Button("Delete…", systemImage: "trash", role: .destructive) { deleting = topic }
        }
    }

    // MARK: calls

    private func loadTopics() async {
        do {
            topics = try await source.service.threads(filter)
            topicProblem = nil
        } catch {
            topicProblem = DispatchSettingsProblem.text(error)
        }
    }

    /// Archive, reopen, rename or delete one topic, then the list again; a topic with a task still running is refused.
    private func act(on topic: DispatchThread, _ call: (any DispatchService) async throws -> Void) async {
        busy.insert(topic.id)
        defer { busy.remove(topic.id) }
        do {
            try await call(source.service)
            topicProblem = nil
        } catch {
            topicProblem = DispatchSettingsProblem.busy(error)
        }
        await loadTopics()
    }

    private func rename(_ topic: DispatchThread) async {
        if let problem = DispatchLimits.topicTitleProblem(newTitle) { topicProblem = problem; return }
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        await act(on: topic) { _ = try await $0.renameThread(id: topic.id, title: title.isEmpty ? nil : title) }
    }

    /// A topic opens at its latest task.
    private func open(_ topic: DispatchThread) async {
        do {
            guard let latest = try await source.service.thread(id: topic.id).tasks.last else {
                topicProblem = "此话题中没有任务。"
                return
            }
            dispatch.openTask(latest.id)
        } catch {
            topicProblem = DispatchSettingsProblem.text(error)
        }
    }

    private func clear() async {
        clearing = true
        defer { clearing = false }
        do {
            try await source.service.clearHistory()
            (cleared, clearProblem, query) = (true, nil, "")
        } catch {
            (cleared, clearProblem) = (false, DispatchSettingsProblem.busy(error))
        }
        await loadTopics()
    }
}
