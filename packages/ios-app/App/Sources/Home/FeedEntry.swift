import AgentSwitchKit
import SwiftUI

/// One task as a card (docs/ui-v0.md): its title (the thread's, else what was asked), a status line (dot, word,
/// model, time), then what it is doing or what came of it; a question or approval waiting for you sits in the same card,
/// under a line. Tapping the upper part opens the task. Under the reply that created it, what you said is already
/// above: `showsRequest` false leaves it out.
struct FeedEntry: View {
    let task: AgentTask
    var showsRequest = true
    let tail: [TaskEvent]
    let pending: [Approval]
    /// Files the executor handed back, once known (FeedModel looks once per finished task): listed on the card, a tap
    /// downloads and previews one.
    var files: [TaskFile] = []
    var opener: TaskFileOpener?
    /// When the live stream last delivered an event (any, shown or not); nil without a stream.
    var lastEventAt: Int64?
    let open: () -> Void
    /// Long press: delete this task or its whole thread (confirmed by the home screen).
    var delete: (DeleteRequest) -> Void = { _ in }
    /// Opens the task's thread page; nil on the thread page itself.
    var openThread: ((String) -> Void)?
    @Environment(AppModel.self) private var model

    static let resultLines = 5
    static let scriptLines = 4
    static let filesShown = 4

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            if showsRequest {
                UserBubble(text: task.task, attachments: task.attachments?.count ?? 0)
            }
            VStack(alignment: .leading, spacing: Theme.Space.m) {
                Button(action: open) { summary }
                    .buttonStyle(.plain)
                    .contextMenu { menu }
                if !task.status.isActive && !files.isEmpty { fileList }
                ForEach(pending) { approval in
                    DottedRule()
                    ApprovalCard(approval: approval,
                                 onDecide: { decision in await model.decide(approval, decision) },
                                 onAnswer: { answers in await model.answer(approval, answers) })
                }
            }
            .card()
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: Theme.Space.s)
                Text(task.updated.relative).mono(11).foregroundStyle(.tertiary)
                if model.isUnread(task) { UnreadDot() }
            }
            HStack(spacing: 6) {
                StatusLabel(task: task, waiting: !pending.isEmpty)
                if let model = task.modelName {
                    Text("·").foregroundStyle(.tertiary)
                    Text(model).foregroundStyle(.secondary)
                }
                StaleNote(task: task, lastEventAt: lastEventAt, waiting: !pending.isEmpty, separated: true)
            }
            .mono(12)
            .lineLimit(1)
            detail
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var detail: some View {
        if task.status.isActive {
            if let step = LiveSummary.currentStep(task, tail: tail) {
                Text(step).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
        } else {
            let script = task.speech.map(Speech.speakable).flatMap { $0.isEmpty ? nil : $0 }
            if let script {
                Text(script).font(.subheadline).lineLimit(Self.scriptLines)
                    .foregroundStyle(model.speaker.speakingTaskId == task.id ? Color.accentColor : .primary)
            } else if let result = task.result, !result.isEmpty {
                Text(Markdown.flattened(result)).font(.subheadline).lineLimit(Self.resultLines)
            }
            // A restart of the Mac's service is not the task failing: said plainly, not in red.
            if let error = task.error, !error.isEmpty, task.status != .done {
                Text(Markdown.flattened(error)).font(.footnote).foregroundStyle(task.isInterrupted ? Color.secondary : Theme.failed).lineLimit(3)
            }
        }
    }

    /// The files handed back, each its own button (outside the card's open button, so a tap reaches it).
    private var fileList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(files.prefix(Self.filesShown)) { file in
                Button { Task { await opener?.open(file, taskId: task.id, model: model) } } label: {
                    HStack(spacing: 8) {
                        Text(file.name).font(.footnote).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 6)
                        Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file)).mono(11).foregroundStyle(.tertiary)
                        FileStateMark(state: opener?.state(file, taskId: task.id) ?? .remote).frame(width: 14)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(opener?.downloading != nil)
            }
            if files.count > Self.filesShown {
                Button(action: open) { Text("+\(files.count - Self.filesShown) files").mono(11).foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .padding(.vertical, 4)
            }
        }
        .padding(.horizontal, 10)
        .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
    }

    private var title: String {
        model.title(of: task)
    }

    @ViewBuilder
    private var menu: some View {
        Button("open") { open() }
        if let threadId = task.threadId, let openThread {
            Button("topic") { openThread(threadId) }
        }
        if task.status.isTerminal {
            let speaking = model.speaker.speakingTaskId == task.id
            Button(speaking ? "stop" : "read aloud") { model.speaker.toggle(task) }
        }
        Divider()
        Button("delete", role: .destructive) { delete(.task(task)) }
            .disabled(task.status.isActive)
    }
}
