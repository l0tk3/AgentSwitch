import AgentSwitchKit
import SwiftUI

/// What you said, on the right, in the accent colour. Ciphertexts show as a lock mark; the Mac's legend is not shown.
struct UserBubble: View {
    let text: String
    var attachments: Int = 0
    var faded = false

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: Theme.Space.xs) {
                Text(MessageDisplay.readable(text))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.fill, in: RoundedRectangle(cornerRadius: Theme.Radius.bubble, style: .continuous))
                    .textSelection(.enabled)
                    .opacity(faded ? 0.55 : 1)
                if attachments > 0 {
                    Label("\(attachments) 个附件", systemImage: "paperclip").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// AgentSwitch's side of the conversation: plain text on the left, no bubble (docs/ui-v0.md: not a chat robot). A
/// notice carries a small dot in the state of the task it is about; the tasks an answer created hang under it as
/// cards, the ones it only talks about as small links.
struct AssistantBubble: View {
    let message: AssistantMessage
    let created: [AgentTask]
    let entry: (AgentTask) -> FeedEntry
    let open: (String) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                if let dot { Circle().fill(dot).frame(width: 7, height: 7).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 } }
                Text(MessageDisplay.readable(message.text))
                    .foregroundStyle(message.unprompted ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contextMenu { readAloud }
            if isAnswer { playButton }
            ForEach(created) { task in entry(task) }
            ForEach(mentioned) { task in TaskLink(task: task, waiting: waiting(task)) { open(task.id) } }
        }
    }

    /// A notice or progress line: the state of its task; nothing for plain answers.
    private var dot: Color? {
        guard message.unprompted else { return nil }
        guard let task = message.taskIds.first.flatMap({ id in model.tasks.first { $0.id == id } }) else { return .secondary }
        return waiting(task) ? Theme.waiting : Theme.color(task.status)
    }

    private func waiting(_ task: AgentTask) -> Bool {
        !ActivityFeed.pending(model.approvals, for: task.id).isEmpty
    }

    private var mentioned: [AgentTask] {
        guard !message.createdTasks, !message.unprompted else { return [] }
        return message.taskIds.compactMap { id in model.tasks.first { $0.id == id } }
    }

    /// An answer to what you asked (not a task created, not a notice): it gets a visible 朗读 under it.
    private var isAnswer: Bool { message.kind == .reply || message.kind == .status }

    private var speakKey: String { "m\(message.seq)" }

    private func toggleSpeech() {
        if model.speaker.speakingTaskId == speakKey { model.speaker.stop() } else { model.speaker.say(MessageDisplay.readable(message.text), key: speakKey) }
    }

    private var playButton: some View {
        let speaking = model.speaker.speakingTaskId == speakKey
        return Button(action: toggleSpeech) {
            Label(speaking ? "停止" : "朗读", systemImage: speaking ? "stop.fill" : "speaker.wave.2")
                .font(.footnote)
                .foregroundStyle(speaking ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var readAloud: some View {
        let speaking = model.speaker.speakingTaskId == speakKey
        Button(speaking ? "停止朗读" : "朗读", systemImage: speaking ? "stop.circle" : "speaker.wave.2", action: toggleSpeech)
        Button("拷贝", systemImage: "doc.on.doc") { UIPasteboard.general.string = MessageDisplay.readable(message.text) }
    }
}

/// A task an answer talks about: its state and its words, one line.
struct TaskLink: View {
    let task: AgentTask
    var waiting = false
    let open: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        Button(action: open) {
            HStack(spacing: Theme.Space.s) {
                StatusLabel(task: task, waiting: waiting)
                Text(title).font(.subheadline).foregroundStyle(.primary).lineLimit(1)
                Spacer(minLength: 0)
                if model.isUnread(task) { UnreadDot() }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, 10)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var title: String {
        task.threadId.flatMap { model.thread($0)?.title } ?? MessageDisplay.readable(task.task)
    }
}

/// The message on its way: faded while it is being sent; on failure, why, with a resend (the same message to the Mac)
/// or back into the box to change it.
struct OutgoingBubble: View {
    let message: OutgoingMessage
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .trailing, spacing: Theme.Space.s) {
            UserBubble(text: message.text, attachments: message.attachments.count, faded: message.failure == nil)
            if let failure = message.failure {
                Text(failure).font(.footnote).foregroundStyle(Theme.failed).multilineTextAlignment(.trailing)
                HStack(spacing: Theme.Space.m) {
                    Button("修改") { model.editOutgoing() }.buttonStyle(.bordered)
                    Button("重发") { Task { await model.resend() } }.buttonStyle(.borderedProminent).tint(Theme.fill)
                }
                .controlSize(.small)
                .disabled(model.sending)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(message.staged == nil && !message.attachments.isEmpty ? "上传附件中" : "发送中")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
