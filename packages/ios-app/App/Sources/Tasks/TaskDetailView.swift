import AgentSwitchKit
import QuickLook
import SwiftUI

/// A task (docs/ui-v0.md): what was asked and its state on top; what waits for you; the summary, the result, the
/// files; then the whole process, one line per event. Actions: cancel while active, give it to another model, delete
/// the task or its whole thread.
struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detail: TaskDetailModel
    @State private var targets: Targets?
    @State private var confirmCancel = false
    @State private var deleting: DeleteRequest?
    @State private var opener = TaskFileOpener()
    @State private var files: [TaskFile] = []

    init(taskId: String) {
        _detail = State(initialValue: TaskDetailModel(taskId: taskId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.xl) {
                if let task = detail.task {
                    header(task)
                    ForEach(detail.pending) { approval in
                        ApprovalCard(approval: approval,
                                     onDecide: { d in await detail.decide(approval, d, model) },
                                     onAnswer: { a in await detail.answer(approval, a, model) })
                            .card()
                    }
                    outcome(task)
                    TaskFilesSection(taskId: task.id, files: files, opener: opener)
                    if let next = detail.handedOffTo {
                        NavigationLink(value: next.id) {
                            LinkRow(title: "已交给新任务", detail: next.modelName)
                        }
                        .buttonStyle(.plain)
                    }
                } else if detail.error == nil {
                    BrailleSpinner(color: .secondary).frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                }
                if let error = detail.error {
                    ErrorText(message: $detail.error).id(error)
                }
                process
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.vertical, Theme.Space.m)
        }
        .background(Theme.base)
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { actions }
        .confirmationDialog("取消此任务？", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel Task", role: .destructive) { Task { await detail.cancel(model) } }
        }
        .deleteConfirmation($deleting, error: $detail.error) { _ in dismiss() }
        .taskFilePreview(opener)
        // Deliverables appear as the task runs: list them again whenever its state changes.
        .task(id: detail.task?.status) { await loadFiles() }
        .onDisappear { if model.speaker.speakingTaskId == detail.task?.id { model.speaker.stop() } }
        .onAppear { detail.start(model) }
        .onDisappear { detail.stop() }
        // Opening a task reads it (control-v0 §4); one that ends or changes while it is open is read again.
        .onChange(of: detail.task?.updatedAt, initial: true) { acknowledge() }
        .refreshable { if let api = model.api { await detail.reload(api, model) } }
        .task { targets = try? await model.api?.targets() }
    }

    /// What was asked, then one line of state: status, model, harness, when; the thread it belongs to under it.
    private func header(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            // As typed, its code drawn as code (TypedText).
            TypedText(text: MessageDisplay.readable(task.task), font: .title3.weight(.semibold))
                .textSelection(.enabled)
            HStack(spacing: 6) {
                StatusLabel(task: task, waiting: !detail.pending.isEmpty)
                ForEach(meta(task), id: \.self) { part in
                    Text("·").foregroundStyle(.tertiary)
                    Text(part).foregroundStyle(.secondary)
                }
            }
            .mono(12)
            .lineLimit(1)
            StaleNote(task: task, lastEventAt: detail.events.last?.ts, waiting: !detail.pending.isEmpty).mono(12)
            if let threadId = task.threadId, let title = model.thread(threadId)?.title, !title.isEmpty {
                NavigationLink(value: ThreadRoute(id: threadId)) {
                    HStack(spacing: 6) {
                        Text("Topic").mono(12).foregroundStyle(.tertiary)
                        Text(title).font(.footnote).foregroundStyle(.secondary)
                        Text("›").mono(12).foregroundStyle(.tertiary)
                    }
                    .lineLimit(1)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func meta(_ task: AgentTask) -> [String] {
        let harness = task.model == nil ? nil : task.harness.map(ModelName.harness)
        return [task.modelName, harness, task.created.relative].compactMap { $0 }
    }

    /// The spoken summary (what 朗读 reads), the result, and for a task that did not finish, why.
    @ViewBuilder
    private func outcome(_ task: AgentTask) -> some View {
        if task.status.isTerminal, let speech = task.speech.map(Speech.speakable), !speech.isEmpty {
            Block("Summary") { Text(speech).textSelection(.enabled) }
        } else if task.status.isTerminal, detail.awaitingSummary {
            Text("摘要生成中").font(.footnote).foregroundStyle(.secondary)
        }
        if let result = task.result, !result.isEmpty {
            Block("Result") { MarkdownView(text: result).textSelection(.enabled) }
        }
        if task.isInterrupted {
            interrupted(task)
        } else if let error = task.error, !error.isEmpty, task.status != .done {
            Block("Reason") { MarkdownView(text: error).foregroundStyle(Theme.failed).textSelection(.enabled) }
        }
    }

    /// Stopped by a restart of the Mac's service (control-v0 §4): not a failure, just unknown how far it got. It is
    /// never rerun by itself; 继续执行 hands it on, the way 交给其他模型 does with the choice left to the router.
    private func interrupted(_ task: AgentTask) -> some View {
        Block("Reason") {
            VStack(alignment: .leading, spacing: Theme.Space.m) {
                Text(task.error.map(MessageDisplay.readable) ?? AgentTask.interruptedText)
                    .textSelection(.enabled)
                if detail.handedOffTo == nil {
                    Button("[ Continue ]") { Task { await detail.handoff(to: nil, model) } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
    }

    private func acknowledge() {
        guard let task = detail.task, model.isUnread(task) else { return }
        Task { await model.acknowledge(task) }
    }

    /// Every event, oldest first; "实时" while the stream is open. A tool call opens to its input and result; the
    /// results are not rows of their own. Calls in a row fold into one line (control-v0 §5); a finished task ends
    /// with how long it took.
    private var process: some View {
        let results = Dictionary(detail.events.filter { $0.type == "tool_result" }.compactMap { e in e.payload["id"]?.string.map { ($0, e) } },
                                 uniquingKeysWith: { first, _ in first })
        let active = detail.task?.status.isActive ?? false
        let items = ProcessFolding.items(detail.events)
        return Block("Process", trailing: detail.live ? "Live" : nil) {
            if detail.events.isEmpty {
                Text(detail.live ? "暂无记录" : "无记录").font(.footnote).foregroundStyle(.tertiary)
            } else {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(items) { item in
                        switch item {
                        case .event(let event):
                            ProcessEventRow(event: event, results: results, active: active)
                        case .tools(let calls):
                            ToolGroupRow(calls: calls, results: results, active: active, ongoing: active && item.id == items.last?.id)
                        }
                    }
                    // Not for a task a restart stopped: its end is when the service went down, not when it finished.
                    if let task = detail.task, !task.isInterrupted, let seconds = TaskDuration.seconds(task, events: detail.events) {
                        HStack(spacing: 10) {
                            Color.clear.frame(width: EventRow.timeWidth, height: 1)
                            Text(TaskDuration.text(seconds)).font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
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
                    Button("Cancel Task", systemImage: "xmark.circle", role: .destructive) { confirmCancel = true }
                }
                Menu("Hand to Another Model", systemImage: "arrow.right.arrow.left") {
                    Button("Auto") { Task { await detail.handoff(to: nil, model) } }
                    ForEach(targets?.pinOptions ?? [], id: \.self) { ref in
                        Button(ref.displayName) { Task { await detail.handoff(to: ref, model) } }
                    }
                }
                if let task = detail.task {
                    Section {
                        Button("Delete Task", systemImage: "trash", role: .destructive) { deleting = .task(task) }
                            .disabled(task.status.isActive)
                    }
                }
            } label: {
                Text("⋯").mono(17)
            }
            .disabled(detail.task == nil)
        }
    }
}

/// A part of a content page: a `// label` heading, then its content; no box (docs/ui-v0.md §1.3, §7.2.7).
struct Block<Content: View>: View {
    let title: String
    var trailing: String?
    @ViewBuilder let content: Content

    init(_ title: String, trailing: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            HStack(spacing: 6) {
                SectionLabel(title)
                Spacer()
                if let trailing {
                    BrailleSpinner()
                    Text(trailing).mono(11).foregroundStyle(Theme.busy)
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A card that leads somewhere: a title, a grey detail, a chevron.
struct LinkRow: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(spacing: Theme.Space.s) {
            Text(title).font(.subheadline)
            if let detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .card()
    }
}

/// One event: its time, then the line. What the model wrote reads as text; the rest is smaller and grey, with the
/// status colours for questions, the end and failures.
struct EventRow: View {
    let event: TaskEvent

    /// Model-written lines (its text, the final result or error) are Markdown; the daemon's own lines (tool calls,
    /// routing) stay plain, so a `*` in a command is never taken for emphasis.
    static let markdownTypes: Set<String> = ["text", "done", "partial", "blocked", "failed"]

    static func formatted(_ event: TaskEvent) -> AttributedString {
        let line = EventDescriber.line(event)
        return markdownTypes.contains(event.type) ? Markdown.flattened(line).codeWashed() : AttributedString(line)
    }

    /// The time column, one width for every row so an opened tool call lines up under its text.
    static let timeWidth: CGFloat = 52

    static func time(_ event: TaskEvent) -> some View {
        Text(event.date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits)))
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.tertiary)
            .frame(width: timeWidth, alignment: .leading)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Self.time(event)
            Text(Self.formatted(event))
                .font(event.type == "text" ? .subheadline : .footnote)
                .foregroundStyle(color)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var color: Color {
        switch EventDescriber.tone(event) {
        case .normal: return .primary
        case .muted: return .secondary
        case .attention: return Theme.waiting
        case .success: return Theme.done
        case .failure: return Theme.failed
        }
    }
}
