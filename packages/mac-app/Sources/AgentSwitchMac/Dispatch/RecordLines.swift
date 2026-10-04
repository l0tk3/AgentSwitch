import AgentSwitchMacCore
import SwiftUI

// The record's lines (docs/dispatch-v0.md §2, demo `mac-window.html`): what you said on the right in a raised square box,
// the answers as plain text on the left (a report with the square of its task's state, `▸ Read Aloud` under an answer),
// a task's end further down than its card as one line, tasks an answer only talks about as one-line links, the message
// on its way, the day labels and the banner.

/// Where a click on the record goes: a task's page or a topic's.
enum DispatchRoute: Hashable {
    case task(String)
    case topic(String)
}

/// What you said, right-aligned in a raised square box, as you typed it (its code drawn as code, TypedText); `N attached`
/// under it.
struct UserBox: View {
    let text: String
    var attached = 0
    var faded = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 140)
            VStack(alignment: .trailing, spacing: 4) {
                // The classic look's bubble: the accent's colour, round (docs/ui-v0.md §8); the pixel look keeps its
                // signal off text grounds.
                TypedText(text: text, size: 14, lineSpacing: 5)
                    .foregroundStyle(look.isClassic ? Color.white : Look.ink)
                    .padding(.horizontal, 13)
                    .padding(.vertical, look.isClassic ? 8 : 9)
                    .grounded(look.isClassic ? Color.signal : Look.raised, radius: Look.bubbleRadius)
                    .framed(look.isClassic ? Color.clear : Look.line, radius: Look.bubbleRadius)
                    .opacity(faded ? 0.55 : 1)
                if attached > 0 { Text("\(attached) attached").mono(11).foregroundStyle(Look.ink2) }
            }
        }
    }
}

/// The assistant's line and what hangs under it: the cards of the tasks it created, links to the ones it talks about.
struct AssistantLineView: View {
    let line: DispatchAssistantLine
    let model: DispatchModel
    let open: (DispatchRoute) -> Void
    let delete: (DeleteRequest) -> Void
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let ended = line.endedTask {
                EndLine(task: ended, title: model.title(of: ended)) { open(.task(ended.id)) }
                    .contextMenu { menu }
            } else {
                said
            }
            ForEach(line.created) { task in TaskCardView(card: model.card(task), model: model, open: open, delete: delete) }
            ForEach(line.mentioned) { task in
                TaskLinkRow(task: task, title: model.title(of: task), waiting: !model.pending(task.id).isEmpty,
                            unread: model.isUnread(task)) { open(.task(task.id)) }
            }
        }
    }

    private var key: String { DispatchSpeaker.key(line.message) }

    private var said: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let dot = line.dot {
                    Group {
                        let color = dot == .busy ? Color.busy : dot == .off ? Look.faint : dot.color
                        if look.isClassic { Circle().fill(color) } else { Rectangle().fill(color) }
                    }
                    .frame(width: 6, height: 6)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                }
                // Reports in the secondary ink; both are model output, so Markdown (their code as code).
                MarkdownBlocks(text: line.message.text, size: 14, color: line.isSecondary ? Look.ink2 : Look.ink, lineSpacing: 6)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .contextMenu { menu }
            if line.isAnswer {
                let speaking = model.speaker.isSpeaking(key)
                Button { model.speaker.toggle(key, text: line.text) } label: {
                    if look.isClassic {
                        Label(speaking ? "Stop" : "Read Aloud", systemImage: speaking ? "stop.fill" : "speaker.wave.2").font(.system(size: 11.5))
                    } else {
                        Text(speaking ? "■ Stop" : "▸ Read Aloud").mono(11.5)
                    }
                }
                .buttonStyle(QuietButtonStyle(active: speaking))
            }
        }
    }

    private var menu: some View {
        RecordMenu(items: DispatchMenuItem.assistantMessage(speaking: model.speaker.isSpeaking(key))) { item in
            switch item {
            case .readAloud: model.speaker.toggle(key, text: line.text)
            case .copy: Clipboard.copy(line.text)
            case .delete: delete(.entry(model.log.entry(of: line.message)))
            default: break
            }
        }
    }
}

/// A secondary word that brightens under the pointer (`▸ Read Aloud`, `+N Files`).
struct QuietButtonStyle: ButtonStyle {
    var active = false

    func makeBody(configuration: Configuration) -> some View {
        QuietButtonBody(configuration: configuration, active: active)
    }
}

private struct QuietButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let active: Bool
    @State private var hovering = false

    var body: some View {
        configuration.label
            .foregroundStyle(active ? Color.signal : hovering || configuration.isPressed ? Look.ink : Look.ink2)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}

/// A task's end, further down than its card: its state, title and word, opening it; the result is on the card.
struct EndLine: View {
    let task: DispatchTask
    let title: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                StatusMark(level: task.status.level)
                Text(DispatchMarkdown.codeSpans(title).codeWashed()).font(.system(size: 13)).foregroundStyle(Look.ink2).lineLimit(1)
                LookWord(task.statusLabel).mono(12).foregroundStyle(task.status.level.wordColor)
                Spacer(minLength: 0)
                LookGlyph(glyph: "›", symbol: "chevron.right").foregroundStyle(Look.faint)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A task an answer talks about: its state and its words, one line in a frame.
struct TaskLinkRow: View {
    let task: DispatchTask
    let title: String
    var waiting = false
    var unread = false
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                TaskMark(level: waiting ? .warning : task.status.level, waiting: waiting || task.waitsForYou)
                LookWord(waiting ? DispatchTaskStatus.waitingApproval.label : task.statusLabel).mono(12)
                    .foregroundStyle((waiting ? StatusLevel.warning : task.status.level).wordColor)
                Text(DispatchMarkdown.codeSpans(title).codeWashed()).font(.system(size: 13)).foregroundStyle(Look.ink).lineLimit(1)
                Spacer(minLength: 0)
                if unread { UnreadSquare() }
                LookGlyph(glyph: "›", symbol: "chevron.right").foregroundStyle(Look.faint)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Look.panel)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .modifier(HoverFrame())
    }
}

/// The message on its way: faded while it goes; on failure, why, with `[ Edit ]` and `[ Resend ]`.
struct OutgoingBox: View {
    let message: OutgoingMessage
    let model: DispatchModel

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            UserBox(text: DispatchMessageDisplay.readable(message.text), attached: message.files.count, faded: message.failure == nil)
            if let failure = message.failure {
                Text(failure).font(.system(size: 12)).foregroundStyle(Color.failed).multilineTextAlignment(.trailing)
                HStack(spacing: 14) {
                    Button { model.editOutgoing() } label: { BracketLabel(word: "Edit") }
                        .buttonStyle(BracketButtonStyle())
                    Button { Task { await model.resend() } } label: { BracketLabel(word: "Resend") }
                        .buttonStyle(BracketButtonStyle(role: .primary))
                }
                .disabled(model.sending)
            } else {
                HStack(spacing: 6) {
                    BrailleSpinner()
                    Text(message.staged == nil && !message.files.isEmpty ? "Uploading" : "Sending").mono(11).foregroundStyle(Look.ink2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// `Yesterday`, `Today`: the first item of each day.
struct DayLabel: View {
    let text: String

    var body: some View {
        Text(text).mono(11).foregroundStyle(Look.faint)
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
    }
}

/// What went wrong, one line in the failed colour, closed with `×`.
struct BannerLine: View {
    let text: String
    let close: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PixelSprite(rows: PixelArt.square, pixel: 2, color: .failed)
            Text(text).font(.system(size: 12.5)).foregroundStyle(Look.ink).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button(action: close) { LookGlyph(glyph: "×", symbol: "xmark", size: 14) }
                .buttonStyle(QuietButtonStyle())
                .help("Close")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .framed(Color.failed, radius: 8)
    }
}
