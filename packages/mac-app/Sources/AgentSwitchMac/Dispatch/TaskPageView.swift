import AgentSwitchMacCore
import SwiftUI

/// A task's page, pushed in the record's column (docs/dispatch-v0.md §2, demo `?task`): your request, the status line
/// and title, the progress while it runs, what waits for you, the summary, result and reason (Markdown), `// Process`,
/// `// Files`, `// Task`, then the actions — `[ Cancel ]` while it runs, `[ Retry ]`, `[ Hand to ▾ ]`, the rating and
/// `[ Delete ]` once it ended. Live while open and seen: its event stream is followed, stopped while the page is not
/// seen and resumed after the last event when it is again. Opening it reads it.
struct TaskPageView: View {
    let model: DispatchModel
    let open: (DispatchRoute) -> Void
    let close: () -> Void
    /// The page is on screen in a visible window (DispatchPage `seen`).
    let visible: Bool
    @Environment(MainWindowState.self) private var window
    @State private var page: TaskPageModel
    @State private var deleting: DeleteRequest?
    @State private var cancelling = false

    init(taskId: String, model: DispatchModel, open: @escaping (DispatchRoute) -> Void, close: @escaping () -> Void,
         visible: Bool) {
        self.model = model
        self.open = open
        self.close = close
        self.visible = visible
        _page = State(initialValue: TaskPageModel(taskId: taskId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let banner = model.banner { BannerLine(text: banner) { model.banner = nil } }
                if let task = page.task(model) {
                    content(task)
                } else {
                    BrailleSpinner().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.top, 18)
            .padding(.bottom, 28)
            .dispatchColumn()
        }
        .onChange(of: visible, initial: true) { _, visible in
            if visible { page.start(model) } else { page.stop() }
        }
        .onDisappear {
            page.stop()
            if model.speaker.isSpeaking(page.taskId) { model.speaker.stop() }
        }
        // Opening a task reads it (control-v0 §4); one that ends or changes while it is open is read again.
        .onChange(of: page.task(model)?.updatedAt, initial: true) { acknowledge() }
        .onChange(of: barTitle, initial: true) { _, title in window.dispatchTitle = title }
        .onChange(of: model.windowKey) { acknowledge() }
        .deleteConfirmation($deleting, model: model) { _ in close() }
        .confirmationDialog("取消此任务？", isPresented: $cancelling, titleVisibility: .visible) {
            Button("Cancel Task", role: .destructive) { Task { await page.cancel(model) } }
        } message: {
            Text("已完成的步骤不会撤销。")
        }
    }

    /// The bar's centre: the task's mark and title.
    private var barTitle: BarTitle? {
        guard let task = page.task(model) else { return nil }
        let card = model.card(task)
        return BarTitle(card.title, mark: card.waiting || task.waitsForYou ? .waiting : Self.mark(card.level))
    }

    static func mark(_ level: StatusLevel) -> BarTitle.Mark {
        switch level {
        case .busy: return .busy
        case .ok: return .done
        case .warning, .error: return .failed
        case .off: return .off
        }
    }

    private func acknowledge() {
        guard model.windowKey, let task = page.task(model), model.isUnread(task) else { return }
        Task { await model.acknowledge(task) }
    }

    @ViewBuilder
    private func content(_ task: DispatchTask) -> some View {
        let card = model.card(task)
        UserBox(text: DispatchRecordLookup.request(of: task, messages: model.log.messages), attached: task.attachments.count)
        VStack(alignment: .leading, spacing: 2) {
            TaskStatusLine(card: card)
            Text(DispatchMarkdown.codeSpans(card.title).codeWashed())
                .font(.system(size: 20, weight: .semibold))
                .lineSpacing(4)
                .foregroundStyle(Look.ink)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let threadId = task.threadId, let thread = model.thread(threadId) {
                Button { open(.topic(threadId)) } label: {
                    HStack(spacing: 6) {
                        Text("Topic").foregroundStyle(Look.faint)
                        Text(thread.displayTitle).foregroundStyle(Look.ink2)
                        Text("›").foregroundStyle(Look.faint)
                    }
                    .mono(11.5)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
        if task.status.isActive && (card.progress != nil || card.step != nil) {
            VStack(alignment: .leading, spacing: 4) {
                if let progress = card.progress { ProgressBlocks(progress: progress) }
                if let step = card.step { StepLine(text: step) }
            }
        }
        ForEach(page.pending(model)) { approval in
            ApprovalBoxView(approval: approval, task: task, step: card.progress?.step, model: model,
                            keys: model.takesKeys(approval.id, onRecord: false),
                            hints: model.takesKeys(approval.id, onRecord: false, typing: false))
        }
        outcome(task)
        ProcessList(events: page.events, task: task, live: page.live)
        if !listedFiles.isEmpty { files }
        facts(task)
        actions(task)
    }

    /// The spoken summary, the result and why it did not finish; a summary still being written says so.
    @ViewBuilder
    private func outcome(_ task: DispatchTask) -> some View {
        if let summary = DispatchTaskPage.summary(task) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(DispatchMarkdown.codeSpans(summary).codeWashed()).font(.system(size: 14)).lineSpacing(6)
                    .foregroundStyle(model.speaker.isSpeaking(task.id) ? Color.signal : Look.ink)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { model.speaker.toggle(task) } label: {
                    Text(model.speaker.isSpeaking(task.id) ? "■ Stop" : "▸ Read Aloud").mono(11.5)
                }
                .buttonStyle(QuietButtonStyle(active: model.speaker.isSpeaking(task.id)))
            }
        } else if page.awaitingSummary {
            Text("摘要生成中").font(.system(size: 12)).foregroundStyle(Look.ink2)
        }
        if let result = task.result, !result.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                PartLabel("Result")
                MarkdownBlocks(text: result, size: Look.typed, lineSpacing: 6)
            }
        }
        if let reason = DispatchTaskPage.reason(task) {
            VStack(alignment: .leading, spacing: 6) {
                PartLabel("Reason")
                MarkdownBlocks(text: reason, size: Look.typed, color: task.isInterrupted ? Look.ink2 : Look.ink, lineSpacing: 6)
            }
        }
    }

    /// The newest list: the page's, or the one opening a file read since.
    private var listedFiles: [DispatchTaskFile] {
        model.taskFiles[page.taskId].map(DispatchTaskFile.pageOrder) ?? page.files
    }

    private var files: some View {
        VStack(alignment: .leading, spacing: 6) {
            PartLabel("Files")
            VStack(alignment: .leading, spacing: 0) {
                ForEach(listedFiles) { file in
                    let state = model.fileState(file, taskId: page.taskId)
                    Button { Task { await model.open(file, taskId: page.taskId) } } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            FileMark(state: state).frame(width: 14, alignment: .leading)
                            Text(file.name).font(.system(size: 13)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 8)
                            Text("\(file.isDeliverable ? "Returned" : "Sent") · \(file.sizeText)").mono(11).foregroundStyle(Look.faint)
                            Text(state == .remote ? "↓" : "").mono(12).foregroundStyle(Look.faint).frame(width: 12)
                        }
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(file.path)
                }
            }
        }
    }

    private func facts(_ task: DispatchTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            PartLabel("Task")
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                ForEach(Array(DispatchTaskPage.facts(task).enumerated()), id: \.offset) { _, fact in
                    GridRow {
                        Text(fact.label).foregroundStyle(Look.ink2)
                        Text(fact.value).foregroundStyle(Look.ink).textSelection(.enabled)
                    }
                }
            }
            .mono(12)
        }
    }

    private func actions(_ task: DispatchTask) -> some View {
        HStack(spacing: 14) {
            TaskActions(actions: DispatchTaskAction.page(task), task: task, model: model, open: open,
                        cancel: { cancelling = true }, delete: { deleting = .task(task) }, opensNext: true)
            Spacer(minLength: 8)
            if task.status.isTerminal { rating(task) }
        }
        .padding(.top, 4)
    }

    /// `<x> Useful  < > Not Useful`: one of two, the same one again clears it.
    private func rating(_ task: DispatchTask) -> some View {
        HStack(spacing: 14) {
            ForEach([(1, "Useful"), (-1, "Not Useful")], id: \.0) { value, word in
                Button { Task { await page.rate(value, model) } } label: {
                    HStack(spacing: 6) {
                        LookChoice(on: task.rating == value, size: 12.5).foregroundStyle(task.rating == value ? Color.signal : Look.ink2)
                        Text(word).foregroundStyle(Look.ink)
                    }
                    .mono(12.5)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
