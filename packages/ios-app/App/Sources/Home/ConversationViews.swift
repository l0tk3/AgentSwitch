import AgentSwitchKit
import SwiftUI

/// What you said, on the right, in a raised square box (the signal colour is not for text backgrounds), as you typed it
/// with its code drawn as code (TypedText). Ciphertexts show as a lock mark; the Mac's legend is not shown.
/// In the classic look a round bubble in the accent's colour (docs/ui-v0.md §8).
struct UserBubble: View {
    let text: String
    var attachments: Int = 0
    var faded = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack {
            Spacer(minLength: 56)
            VStack(alignment: .trailing, spacing: Theme.Space.xs) {
                TypedText(text: MessageDisplay.readable(text))
                    .foregroundStyle(look.isClassic ? Color.white : Theme.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, look.isClassic ? 9 : 10)
                    .grounded(look.isClassic ? Theme.signal : Theme.raised, radius: Theme.Radius.bubble)
                    .framed(look.isClassic ? Color.clear : Theme.line, radius: Theme.Radius.bubble)
                    .textSelection(.enabled)
                    .opacity(faded ? 0.55 : 1)
                if attachments > 0 {
                    Text("\(attachments) attached").mono(11).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// AgentSwitch's side of the conversation: plain text on the left, no bubble (docs/ui-v0.md: not a chat robot). A
/// notice carries a small dot in the state of the task it is about; the tasks an answer created hang under it as
/// cards, the ones it only talks about as small links. Long press: read aloud, copy, its links (each: Open in Browser,
/// Copy Link, Open in Safari; browser-v0 §1 入口, 2026-10-03), delete (the whole entry). A tap on a link opens it in the
/// Mac's browser (RootView).
struct AssistantBubble: View {
    let message: AssistantMessage
    let created: [AgentTask]
    let entry: (AgentTask) -> FeedEntry
    let open: (String) -> Void
    let delete: (DeleteRequest) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            if let ended { endLine(ended) } else { line }
            ForEach(created) { task in entry(task) }
            ForEach(mentioned) { task in TaskLink(task: task, waiting: waiting(task)) { open(task.id) } }
        }
    }

    private var line: some View {
        VStack(alignment: .leading, spacing: Theme.Space.m) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                if let dot {
                    Group { if look.isClassic { Circle().fill(dot) } else { Rectangle().fill(dot) } }
                        .frame(width: 6, height: 6).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                }
                // Model output: Markdown, as on the Mac (its code as code).
                MarkdownView(text: message.text)
                    .foregroundStyle(message.unprompted ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contextMenu { readAloud }
            if isAnswer { playButton }
        }
    }

    /// A task's end, further down than its card (Conversation.timeline leaves out one right under it): one line — its
    /// state, its title, the word — that opens it; the result is on the card, not said twice (ui-v0 §7.4).
    private var ended: AgentTask? {
        guard message.kind == .notice, let id = message.taskIds.first else { return nil }
        return model.tasks.first { $0.id == id }
    }

    private func endLine(_ task: AgentTask) -> some View {
        Button { open(task.id) } label: {
            HStack(spacing: Theme.Space.s) {
                StatusMark(status: task.status)
                Text(Markdown.codeSpans(model.title(of: task)).codeWashed())
                    .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                LookWord(task.status.label).mono(11).foregroundStyle(Theme.color(task.status))
                Spacer(minLength: 0)
                LookGlyph(glyph: "›", symbol: "chevron.right", size: 12).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu { readAloud }
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
            Label(speaking ? "Stop" : "Read Aloud", systemImage: speaking ? "stop.fill" : "speaker.wave.2")
                .mono(12)
                .foregroundStyle(speaking ? Color.accentColor : .secondary)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var readAloud: some View {
        let speaking = model.speaker.speakingTaskId == speakKey
        Button(speaking ? "Stop" : "Read Aloud", systemImage: speaking ? "stop.fill" : "speaker.wave.2", action: toggleSpeech)
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = MessageDisplay.readable(message.text) }
        LinkMenuItems(text: message.text)
        Divider()
        Button("Delete", systemImage: "trash", role: .destructive) { delete(.entry(model.conversation.entry(of: message))) }
    }
}

/// A task an answer talks about: its state and its words, one line.
struct TaskLink: View {
    let task: AgentTask
    var waiting = false
    let open: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: open) {
            HStack(spacing: Theme.Space.s) {
                StatusLabel(task: task, waiting: waiting)
                Text(Markdown.codeSpans(title).codeWashed()).font(.subheadline).foregroundStyle(.primary).lineLimit(1)
                Spacer(minLength: 0)
                if model.isUnread(task) { UnreadDot() }
                LookGlyph(glyph: "›", symbol: "chevron.right").foregroundStyle(.tertiary)
            }
            .padding(.horizontal, Theme.Space.m)
            .padding(.vertical, 10)
            // A framed line; a round card on its own ground in the classic look.
            .grounded(look.isClassic ? Theme.panel : Color.clear, radius: Theme.Radius.card)
            .framed(look.isClassic ? Color.clear : Theme.line, radius: Theme.Radius.card)
        }
        .buttonStyle(.plain)
    }

    private var title: String {
        model.title(of: task)
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
                    Button { model.editOutgoing() } label: { ButtonWord("Edit") }.buttonStyle(SquareButtonStyle(expand: false))
                    Button { Task { await model.resend() } } label: { ButtonWord("Resend") }.buttonStyle(SquareButtonStyle(prominent: true, expand: false))
                }
                .disabled(model.sending)
            } else {
                HStack(spacing: 6) {
                    BrailleSpinner(color: .secondary)
                    Text(message.staged == nil && !message.attachments.isEmpty ? "Uploading" : "Sending")
                }
                .mono(11)
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
