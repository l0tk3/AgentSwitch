import AgentSwitchKit
import SwiftUI

/// What you said, on the right. Ciphertexts show as a lock mark; the Mac's legend is not shown.
struct UserBubble: View {
    let text: String
    var attachments: Int = 0
    var faded = false

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 4) {
                Text(MessageDisplay.readable(text))
                    .padding(10)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                    .textSelection(.enabled)
                    .opacity(faded ? 0.6 : 1)
                if attachments > 0 {
                    Label("\(attachments) 个附件", systemImage: "paperclip").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// The assistant's answer on the left, the tasks it created right under it (their live cards), and small links to the
/// tasks a progress or cancel answer is about.
struct AssistantBubble: View {
    let message: AssistantMessage
    let created: [AgentTask]
    let entry: (AgentTask) -> FeedEntry
    let open: (String) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label { Text(MessageDisplay.readable(message.text)) } icon: { Self.icon(message.kind) }
                    .labelStyle(KindLabelStyle())
                    .padding(10)
                    .background(Color(.systemGray5), in: RoundedRectangle(cornerRadius: 14))
                    .textSelection(.enabled)
                    .contextMenu {
                        let key = "m\(message.seq)"
                        let speaking = model.speaker.speakingTaskId == key
                        Button(speaking ? "停止朗读" : "朗读", systemImage: speaking ? "stop.circle" : "speaker.wave.2") {
                            if speaking { model.speaker.stop() } else { model.speaker.say(MessageDisplay.readable(message.text), key: key) }
                        }
                    }
                Spacer(minLength: 48)
            }
            ForEach(created) { task in entry(task) }
            if !mentioned.isEmpty {
                FlowLinks(tasks: mentioned, open: open)
            }
        }
    }

    /// Said on its own (a report, a progress line) or setting a watch: a small sign in front, nothing for answers.
    @ViewBuilder
    static func icon(_ kind: AssistantMessage.Kind) -> some View {
        switch kind {
        case .notice: Image(systemName: "bell.fill").foregroundStyle(.orange)
        case .progress: Image(systemName: "clock").foregroundStyle(.secondary)
        case .watch: Image(systemName: "eye").foregroundStyle(.secondary)
        default: EmptyView()
        }
    }

    private var mentioned: [AgentTask] {
        guard !message.createdTasks else { return [] }
        return message.taskIds.compactMap { id in model.tasks.first { $0.id == id } }
    }
}

/// Icon and text side by side; with no icon the text alone, not an empty gap.
private struct KindLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.font(.footnote)
            configuration.title
        }
    }
}

/// Links to the tasks an answer talks about: their words, shortened.
private struct FlowLinks: View {
    let tasks: [AgentTask]
    let open: (String) -> Void

    static let titleChars = 18

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(tasks) { task in
                Button { open(task.id) } label: {
                    HStack(spacing: 6) {
                        StatusBadge(task: task)
                        Text(Self.title(task)).lineLimit(1)
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    }
                    .font(.footnote)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color(.secondarySystemBackground), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    static func title(_ task: AgentTask) -> String {
        let words = MessageDisplay.readable(task.task).replacingOccurrences(of: "\n", with: " ")
        return words.count > titleChars ? String(words.prefix(titleChars)) + "…" : words
    }
}

/// The message on its way: faded while the assistant thinks; on failure, why, with a resend (same message to the Mac)
/// or back into the box to change it.
struct OutgoingBubble: View {
    let message: OutgoingMessage
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            UserBubble(text: message.text, attachments: message.attachments.count, faded: message.failure == nil)
            if let failure = message.failure {
                Text(failure).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.trailing)
                HStack(spacing: 12) {
                    Button("改一改") { model.editOutgoing() }
                    Button("重发") { Task { await model.resend() } }.buttonStyle(.borderedProminent)
                }
                .font(.footnote)
                .disabled(model.sending)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(message.staged == nil && !message.attachments.isEmpty ? "正在上传附件…" : "助理在想…")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
