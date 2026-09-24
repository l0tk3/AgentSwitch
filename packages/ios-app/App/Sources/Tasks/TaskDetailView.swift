import AgentSwitchKit
import QuickLook
import SwiftUI

/// A task: what was asked, its state, pending approvals and questions, the result, and the live event stream.
/// Actions: cancel while active, hand off to another executor, delete the task or its whole thread.
struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detail: TaskDetailModel
    @State private var targets: Targets?
    @State private var confirmCancel = false
    @State private var deleting: DeleteRequest?
    @State private var previewURL: URL?
    @State private var sourceFile: SourceFile?
    @State private var files: [TaskFile] = []

    init(taskId: String) {
        _detail = State(initialValue: TaskDetailModel(taskId: taskId))
    }

    var body: some View {
        List {
            if let task = detail.task {
                header(task)
                if !detail.pending.isEmpty {
                    Section("等你处理") {
                        ForEach(detail.pending) { approval in
                            ApprovalCard(approval: approval,
                                         onDecide: { d in await detail.decide(approval, d, model) },
                                         onAnswer: { a in await detail.answer(approval, a, model) })
                        }
                    }
                }
                if task.status.isTerminal { spokenSection(task) }
                if let result = task.result, !result.isEmpty {
                    Section("结果") { MarkdownView(text: result).textSelection(.enabled) }
                }
                if let error = task.error, !error.isEmpty {
                    Section("错误") { MarkdownView(text: error).foregroundStyle(.red).textSelection(.enabled) }
                }
                TaskFilesSection(taskId: task.id, files: files, preview: $previewURL, source: $sourceFile)
                if let next = detail.handedOffTo {
                    Section { NavigationLink("已交接为新任务，打开", value: next.id) }
                }
            } else if detail.error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let error = detail.error {
                Section { ErrorText(message: $detail.error).id(error) }
            }
            Section {
                ForEach(detail.events) { EventRow(event: $0) }
            } header: {
                HStack {
                    Text("事件")
                    Spacer()
                    if detail.live { Label("实时", systemImage: "dot.radiowaves.left.and.right").labelStyle(.titleAndIcon).foregroundStyle(.green) }
                }
            }
        }
        .navigationTitle("任务")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { actions }
        .confirmationDialog("取消这个任务？", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("取消任务", role: .destructive) { Task { await detail.cancel(model) } }
        }
        .deleteConfirmation($deleting, error: $detail.error) { _ in dismiss() }
        .quickLookPreview($previewURL)
        .sheet(item: $sourceFile) { SourceFileView(file: $0) }
        // Deliverables appear as the task runs: list them again whenever its state changes.
        .task(id: detail.task?.status) { await loadFiles() }
        .onDisappear { if model.speaker.speakingTaskId == detail.task?.id { model.speaker.stop() } }
        .onAppear { detail.start(model) }
        .onDisappear { detail.stop() }
        .refreshable { if let api = model.api { await detail.reload(api, model) } }
        .task { targets = try? await model.api?.targets() }
    }

    private func header(_ task: AgentTask) -> some View {
        Section {
            Text(MessageDisplay.readable(task.task)).textSelection(.enabled)
            HStack {
                StatusBadge(task: task)
                if let target = task.targetLabel { Text(target).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Text(task.created.relative).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// 口播: exactly what 朗读 reads (the cleaned script, or its fallback), with the play / stop button beside it.
    private func spokenSection(_ task: AgentTask) -> some View {
        Section {
            HStack(alignment: .top, spacing: 10) {
                Text(Speaker.script(for: task)).textSelection(.enabled)
                Spacer(minLength: 0)
                let speaking = model.speaker.speakingTaskId == task.id
                Button { model.speaker.toggle(task) } label: {
                    Image(systemName: speaking ? "stop.circle.fill" : "speaker.wave.2.circle.fill").font(.title2)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(speaking ? "停止朗读" : "朗读")
            }
            if task.speech == nil {
                Text(detail.awaitingSummary ? "口播稿生成中…" : "这个任务没有口播稿，朗读时念上面这段。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("口播")
        }
    }

    private func loadFiles() async {
        guard let api = model.api else { return }
        // Deliverables first: they are what the task was for.
        if let listed = try? await api.taskFiles(detail.taskId) {
            files = listed.sorted { ($0.isDeliverable ? 0 : 1, $0.path) < ($1.isDeliverable ? 0 : 1, $1.path) }
        }
    }

    @ToolbarContentBuilder
    private var actions: some ToolbarContent {
        if let task = detail.task, task.status.isTerminal {
            ToolbarItem(placement: .primaryAction) {
                let speaking = model.speaker.speakingTaskId == task.id
                Button { model.speaker.toggle(task) } label: { Image(systemName: speaking ? "stop.circle" : "speaker.wave.2") }
                    .accessibilityLabel(speaking ? "停止朗读" : "朗读")
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
                if detail.task?.status.isActive == true {
                    Button("取消任务", systemImage: "stop.circle", role: .destructive) { confirmCancel = true }
                }
                Menu("交接给…", systemImage: "arrow.triangle.branch") {
                    Button("让路由器另选") { Task { await detail.handoff(to: nil, model) } }
                    ForEach(targets?.pinOptions ?? [], id: \.self) { ref in
                        Button(ref.label) { Task { await detail.handoff(to: ref, model) } }
                    }
                }
                if let task = detail.task {
                    Section {
                        Button("删除这条任务", systemImage: "trash", role: .destructive) { deleting = .task(task) }
                            .disabled(task.status.isActive)
                        if let threadId = task.threadId {
                            Button("删除整个会话", systemImage: "trash.slash", role: .destructive) { deleting = .thread(id: threadId, title: nil) }
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .disabled(detail.task == nil)
        }
    }
}

struct EventRow: View {
    let event: TaskEvent

    /// Model-written lines (its text, the final result or error) are Markdown; the daemon's own lines (tool calls,
    /// routing) stay plain, so a `*` in a command is never taken for emphasis.
    static let markdownTypes: Set<String> = ["text", "done", "partial", "blocked", "failed"]

    static func formatted(_ event: TaskEvent) -> AttributedString {
        let line = EventDescriber.line(event)
        return markdownTypes.contains(event.type) ? Markdown.flattened(line) : AttributedString(line)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Self.formatted(event))
                .font(event.type == "text" ? .body : .footnote)
                .foregroundStyle(color)
                .textSelection(.enabled)
            Text("#\(event.seq) · \(event.date.formatted(date: .omitted, time: .standard))")
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private var color: Color {
        switch EventDescriber.tone(event) {
        case .normal: return .primary
        case .muted: return .secondary
        case .attention: return .purple
        case .success: return .green
        case .failure: return .red
        }
    }
}
