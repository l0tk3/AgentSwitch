import AgentSwitchKit
import SwiftUI

/// One task in the log: what you said, then what happened (state, executor, live lines, result or error), then this
/// task's pending approvals and questions to answer in place. Tapping the middle part opens the full event stream.
/// Under the assistant's reply that created it, what you said is already above: `showsRequest` false leaves it out.
struct FeedEntry: View {
    let task: AgentTask
    var showsRequest = true
    let tail: [TaskEvent]
    let pending: [Approval]
    /// Files the executor handed back, once known (FeedModel looks once per finished task).
    var deliverables: Int = 0
    let open: () -> Void
    /// Long press on the entry: delete this task or its whole thread (confirmed by the home screen).
    var delete: (DeleteRequest) -> Void = { _ in }
    /// Opens the task's thread page from its tag; nil hides the tag (on the thread page itself).
    var openThread: ((String) -> Void)?
    @Environment(AppModel.self) private var model

    static let resultLines = 8
    /// With a spoken script shown above it, the result preview is shorter.
    static let resultLinesUnderScript = 4
    static let scriptLines = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let threadId = task.threadId, let openThread {
                ThreadTag(threadId: threadId, title: model.thread(threadId)?.title) { openThread(threadId) }
            }
            if showsRequest {
                UserBubble(text: task.task, attachments: task.attachments?.count ?? 0)
            }
            Button(action: open) { outcome }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("打开完整日志", systemImage: "list.bullet.rectangle") { open() }
                    if task.status.isTerminal {
                        let speaking = model.speaker.speakingTaskId == task.id
                        Button(speaking ? "停止朗读" : "朗读", systemImage: speaking ? "stop.circle" : "speaker.wave.2") { model.speaker.toggle(task) }
                    }
                    Button("删除这条任务", systemImage: "trash", role: .destructive) { delete(.task(task)) }
                        .disabled(task.status.isActive)
                    if let threadId = task.threadId {
                        Button("删除整个会话", systemImage: "trash.slash", role: .destructive) { delete(.thread(id: threadId, title: nil)) }
                    }
                }
            ForEach(pending) { approval in
                ApprovalCard(approval: approval,
                             onDecide: { decision in await model.decide(approval, decision) },
                             onAnswer: { answers in await model.answer(approval, answers) })
                    .padding(10)
                    .background(.purple.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    private var outcome: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                StatusBadge(task: task)
                if let target = task.targetLabel {
                    Text(target).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(task.updated.relative).font(.caption2).foregroundStyle(.tertiary)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }
            if task.status.isActive {
                if tail.isEmpty, let spoken = task.spoken {
                    Text(spoken).font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(tail) { event in
                    Text(EventRow.formatted(event)).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            let script = task.status.isTerminal ? task.speech.map(Speech.speakable).flatMap { $0.isEmpty ? nil : $0 } : nil
            if let script {
                Label { Text(script).lineLimit(Self.scriptLines) } icon: { Image(systemName: "speaker.wave.2") }
                    .font(.callout)
                    .foregroundStyle(model.speaker.speakingTaskId == task.id ? Color.accentColor : .primary)
            }
            if let result = task.result, !result.isEmpty {
                Text(Markdown.flattened(result)).lineLimit(script == nil ? Self.resultLines : Self.resultLinesUnderScript)
                    .foregroundStyle(script == nil ? .primary : .secondary)
            }
            if deliverables > 0 {
                Label("\(deliverables) 个文件", systemImage: "paperclip").font(.caption).foregroundStyle(.tint)
            }
            if let error = task.error, !error.isEmpty {
                Text(Markdown.flattened(error)).font(.footnote).foregroundStyle(.red).lineLimit(4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .contentShape(Rectangle())
    }
}
