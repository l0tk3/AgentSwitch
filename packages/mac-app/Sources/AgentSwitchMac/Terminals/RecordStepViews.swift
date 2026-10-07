import AgentSwitchMacCore
import SwiftUI

// A step of a run of work in a pane's simple view (docs/simple-view-v0.md §5.1): on its line what the agent said it is
// for, where it said; opened, a command as it was written — whole, in colour — and all it printed.

/// The steps read whole so far: a step that has ended does not change (one still running is asked again when it has
/// printed).
@MainActor
final class RecordStepStore {
    static let shared = RecordStepStore()
    private var held: [String: RecordStepDetail] = [:]

    func held(_ key: String) -> RecordStepDetail? { held[key] }

    func detail(_ source: RecordSource, work: String, n: Int, key: String) async -> RecordStepDetail? {
        if let detail = held[key] { return detail }
        guard let detail = await source.client().sessionStep(harness: source.harness, id: source.session, work: work, n: n) else { return nil }
        if held.count > 400 { held.removeAll() }
        held[key] = detail
        return detail
    }

    #if DEBUG
    /// The design preview's: a step without a service.
    func stage(_ key: String, _ detail: RecordStepDetail) { held[key] = detail }
    #endif
}

struct RecordStepLine: View {
    let step: RecordStep
    let verbose: Bool
    /// Where the step is read whole, the run it is of and its place in it (absent: its line is all there is).
    let source: RecordSource?
    let work: String
    let index: Int
    /// The design preview opens one.
    var opened = false
    @State private var whole = false
    @State private var detail: RecordStepDetail?
    @Environment(\.interfaceLook) private var look

    /// A command opens into itself whole, a step that brought pictures back into them (2026-10-07, user: 这种readpng
    /// 能不能展开后看到真的png内容呢); the other steps say all there is on their line.
    private var opens: Bool { (step.kind == .run || step.images > 0) && source != nil }
    private var isCommand: Bool { step.kind == .run }
    /// Asked again once it has printed (a command still running has not).
    private var key: String { "\(source?.key(work, index) ?? "")/\(step.out?.count ?? -1)" }

    var body: some View {
        let shown = whole || opened
        VStack(alignment: .leading, spacing: 4) {
            if opens {
                Button { whole.toggle() } label: { head(open: shown).contentShape(Rectangle()) }.buttonStyle(.plain)
            } else {
                head(open: false)
            }
            if shown, opens {
                if isCommand {
                    RecordCommandBlock(command: detail?.text ?? step.text)
                    if let out = detail?.out ?? step.out, !out.isEmpty { output(out, lines: nil) }
                    if detail?.clipped == true { Text("很长：只有命令的开头和输出的末尾。").font(.system(size: Look.size(11, look))).foregroundStyle(Look.faint) }
                }
                if step.images > 0, let source { RecordPictures(source: source, item: work, count: step.images, step: index, height: 150).padding(.top, 2) }
            } else {
                // Under what it is for, the command itself on a line.
                if step.note != nil, step.kind == .run {
                    Text(step.text).font(.system(size: Look.size(11, look), design: .monospaced)).foregroundStyle(Look.faint).lineLimit(verbose ? 6 : 1).truncationMode(.tail)
                }
                // What it printed, at a glance: where nothing says what the step was for, or it failed.
                if let out = step.out, !out.isEmpty, step.note == nil || step.failed || verbose { output(out, lines: verbose ? 14 : 4) }
            }
        }
        .padding(.leading, 17)
        .task(id: shown && opens && isCommand ? key : "") {
            guard shown, opens, isCommand, let source else { return }
            detail = RecordStepStore.shared.held(key)
            if detail == nil { detail = await RecordStepStore.shared.detail(source, work: work, n: index, key: key) }
        }
    }

    private func head(open: Bool) -> some View {
        let file = RecordDisplay.namesFile(step)
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            // The classic look puts a small picture of the kind before the line; the pixel look's word is its mark.
            if look.isClassic {
                Image(systemName: RecordDisplay.symbol(step.kind)).font(.system(size: 11.5)).foregroundStyle(step.failed ? Color.failed : Look.ink2)
                    .frame(width: 16, alignment: .center)
            }
            Text(RecordDisplay.label(step)).mono(Look.size(11.5, look), weight: .medium).foregroundStyle(step.failed ? Color.failed : Look.ink.opacity(0.75)).lineLimit(1)
                .layoutPriority(1)
            if let note = step.note {
                Text(note).font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.ink.opacity(0.85)).lineLimit(2)
            } else if opens, isCommand {
                Text(step.text).font(.system(size: Look.size(11.5, look), design: .monospaced)).foregroundStyle(Look.ink2).lineLimit(verbose ? 6 : 2).truncationMode(.tail)
            } else {
                // A file by the end of its path (its name); a command or a query from its start.
                Text(step.text).font(.system(size: Look.size(11.5, look), design: .monospaced)).foregroundStyle(Look.ink2)
                    .lineLimit(verbose ? 6 : file ? 1 : 2).truncationMode(file ? .head : .tail).textSelection(.enabled)
            }
            if opens { RecordFold(open: open) }
            Spacer(minLength: 0)
            if step.added != nil || step.removed != nil { RecordDiffStat(added: step.added ?? 0, removed: step.removed ?? 0, plain: true) }
        }
    }

    private func output(_ out: String, lines: Int?) -> some View {
        Text(out).font(.system(size: Look.size(11, look), design: .monospaced)).foregroundStyle(step.failed ? Color.failed : Look.ink2)
            .lineSpacing(2).lineLimit(lines).textSelection(.enabled)
            .padding(.horizontal, 9).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Look.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
    }
}

/// A command as it was written: its lines kept and wrapped where the block ends, the word each command begins with,
/// what is quoted and comments in colour, `Copy` beside it.
struct RecordCommandBlock: View {
    let command: String
    @State private var copied = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text("$").font(.system(size: Look.size(11.5, look), design: .monospaced)).foregroundStyle(Look.faint)
            Text(Self.coloured(command)).font(.system(size: Look.size(11.5, look), design: .monospaced)).lineSpacing(3).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: copy) { Text(copied ? "Copied" : "Copy") }
                .buttonStyle(QuietButtonStyle(active: copied))
                .mono(Look.size(10.5, look))
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(Look.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
        .framed(Look.line, radius: look.isClassic ? 6 : 0)
    }

    /// The command's parts, each in its colour: the signal for the word a command begins with, green for what is
    /// quoted (a here-document's body with it), faint for a comment.
    static func coloured(_ command: String) -> AttributedString {
        var text = AttributedString()
        for run in ShellHighlight.runs(command) {
            var part = AttributedString(run.text)
            switch run.kind {
            case .command: part.foregroundColor = Color.signal
            case .string: part.foregroundColor = Color.ok
            case .comment: part.foregroundColor = Look.faint
            case .plain: part.foregroundColor = Look.ink
            }
            text += part
        }
        return text
    }

    private func copy() {
        Clipboard.copy(command)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            copied = false
        }
    }
}
