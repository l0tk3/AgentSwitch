import AgentSwitchKit
import SwiftUI

// The rows of a session's record (docs/simple-view-v0.md §2, §5; docs/design/concepts/simple-view.html): what you said on
// the right, the agent's answers as Markdown, a run of work as one line that opens into its steps, with what it changed
// beside it. The read-only page of an earlier session and a running terminal's simple view draw the same rows.

/// One item of the record.
struct RecordItemRow: View {
    let item: RecordItem
    /// The verbose transcript: every run open, thinking shown.
    var verbose = false
    /// This run of work is the one still going.
    var running = false
    /// Opens what this run changed (absent where there is nothing to open it with).
    var changes: (() -> Void)?
    /// Which session the pictures sent with a message are asked of (absent before it is known).
    var pictures: RecordPictureSource?

    var body: some View {
        switch item.kind {
        case .user: UserRow(item: item, pictures: pictures)
        case .answer: AnswerRow(item: item)
        case .work: WorkRow(item: item, verbose: verbose, running: running, changes: changes, source: pictures)
        case .note:
            LookWord(item.text).mono(11).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

private struct UserRow: View {
    let item: RecordItem
    let pictures: RecordPictureSource?

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Group {
                // Typed while it worked: it has not read it yet.
                if item.queued { LookWord("Queued") } else { Text(item.date.relative) }
            }
            .mono(11).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .trailing)
            if !item.text.isEmpty { UserBubble(text: item.text, faded: item.queued) }
            if item.images > 0 {
                if let pictures {
                    RecordPictures(source: pictures, item: item.id, count: item.images)
                } else {
                    Text(item.images == 1 ? "1 image" : "\(item.images) images").mono(11).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, Theme.Space.s)
    }
}

private struct AnswerRow: View {
    let item: RecordItem
    @State private var whole = false

    var body: some View {
        let head = whole ? nil : RecordDisplay.preview(item.text)
        VStack(alignment: .leading, spacing: 8) {
            // What it thought on the way reads quieter than what it has to say to you.
            MarkdownView(text: head ?? item.text).textSelection(.enabled).linkMenu(for: item.text).opacity(item.thinking ? 0.62 : 1)
            if head != nil {
                Button { whole = true } label: { Text("Show More").mono(13, weight: .medium) }
                    .buttonStyle(.plain).foregroundStyle(Theme.signal)
            } else if item.clipped {
                Text("这条回答很长，Mac 只发来了开头。").font(.footnote).foregroundStyle(.tertiary)
            }
        }
    }
}

/// A run of work: one line (`Worked 1m 12s · Read 1 · Ran 2 · Edited 1`) with the lines it added and took away beside
/// it; opened, each step on a line.
private struct WorkRow: View {
    let item: RecordItem
    let verbose: Bool
    let running: Bool
    let changes: (() -> Void)?
    /// Where a step is read whole (absent before the session is known).
    let source: RecordPictureSource?
    @State private var open = false

    var body: some View {
        // Each with its place among the run's steps: that is how one is asked for whole.
        let steps = Array(item.steps.enumerated()).filter { verbose || $0.element.kind != .think }
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 6) {
                        LookGlyph.fold(open: open || verbose).foregroundStyle(.tertiary)
                        Text(RecordDisplay.summary(item, running: running)).mono(12).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(verbose || steps.isEmpty)
                if let stat = RecordDisplay.stat(item.steps) {
                    Button { changes?() } label: { DiffStat(added: stat.added, removed: stat.removed) }
                        .buttonStyle(.plain)
                        .disabled(changes == nil)
                        .accessibilityLabel("changes")
                }
            }
            if open || verbose {
                ForEach(steps, id: \.offset) { index, step in StepRow(step: step, verbose: verbose, source: source, work: item.id, index: index) }
            }
        }
        #if DEBUG
        .onAppear { if UserDefaults.standard.bool(forKey: "uiDemoOpenTools") { open = true } }
        #endif
    }
}

/// One step: on its line what the agent said it is for, where it said; a command opens into itself — as it was
/// written, whole, in colour — and all it printed.
private struct StepRow: View {
    let step: RecordStep
    let verbose: Bool
    let source: RecordPictureSource?
    let work: String
    let index: Int
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var whole = false
    @State private var detail: RecordStepDetail?

    private var isFile: Bool { [.read, .edit, .write, .list].contains(step.kind) }
    private var opens: Bool { step.kind == .run && source != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if opens {
                Button { withAnimation(.snappy(duration: 0.18)) { whole.toggle() } } label: { head.contentShape(Rectangle()) }.buttonStyle(.plain)
            } else {
                head
            }
            if whole, opens {
                CommandBlock(command: detail?.text ?? step.text)
                if let out = detail?.out ?? step.out, !out.isEmpty { output(out, lines: nil) }
                if detail?.clipped == true { Text("很长：只有命令的开头和输出的末尾。").font(.caption2).foregroundStyle(.tertiary) }
            } else {
                // Under what it is for, the command itself on a line.
                if step.note != nil, step.kind == .run {
                    Text(MessageDisplay.readable(step.text)).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(verbose ? 6 : 1)
                }
                // What it printed, at a glance: where nothing says what the step was for, or it failed.
                if let out = step.out, !out.isEmpty, step.note == nil || step.failed || verbose { output(out, lines: verbose ? 14 : 4) }
            }
        }
        .padding(.leading, 18)
        // Asked again once it has printed (a command still running has not).
        .task(id: whole && opens ? "\(work)/\(index)/\(step.out?.count ?? -1)" : "") {
            guard whole, opens, let source else { return }
            guard let api = model.api else {
                #if DEBUG
                detail = DemoData.stepDetail
                #endif
                return
            }
            if let read = try? await api.sessionStep(harness: source.harness, id: source.session, work: work, n: index) { detail = read }
        }
        #if DEBUG
        .onAppear { if opens, step.note != nil, UserDefaults.standard.bool(forKey: "uiDemoOpenTools") { whole = true } }
        #endif
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(RecordDisplay.label(step)).mono(12, weight: .medium).foregroundStyle(step.failed ? Theme.failed : Theme.ink.opacity(0.72)).lineLimit(1)
                .layoutPriority(1)
            if let note = step.note {
                Text(note).font(.footnote).foregroundStyle(Theme.ink.opacity(0.85)).lineLimit(2)
            } else if opens {
                Text(MessageDisplay.readable(step.text)).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(verbose ? 6 : 2)
            } else {
                // A file by the end of its path (its name); a command or a query from its start.
                Text(MessageDisplay.readable(step.text)).font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(verbose ? 6 : isFile ? 1 : 2).truncationMode(isFile ? .head : .tail).textSelection(.enabled)
            }
            if opens { LookGlyph.fold(open: whole).foregroundStyle(.tertiary) }
            Spacer(minLength: 0)
            if step.added != nil || step.removed != nil {
                DiffStat(added: step.added ?? 0, removed: step.removed ?? 0, plain: true)
            }
        }
    }

    private func output(_ out: String, lines: Int?) -> some View {
        Text(out).font(.caption2.monospaced()).foregroundStyle(step.failed ? Theme.failed : .secondary)
            .lineLimit(lines).textSelection(.enabled)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
    }
}

/// A command as it was written: its lines kept and wrapped where the block ends, the word each command begins with,
/// what is quoted and comments in colour, `Copy` under it.
private struct CommandBlock: View {
    let command: String
    @State private var copied = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("$").font(.caption.monospaced()).foregroundStyle(.tertiary)
                Text(Self.coloured(command)).font(.caption.monospaced()).lineSpacing(2).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                UIPasteboard.general.string = command
                copied = true
                Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
            } label: { LookWord(copied ? "Copied" : "Copy").mono(11, weight: .medium) }
                .buttonStyle(.plain).foregroundStyle(copied ? Theme.done : Theme.signal)
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(Theme.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }

    static func coloured(_ command: String) -> AttributedString {
        var text = AttributedString()
        for run in ShellHighlight.runs(command) {
            var part = AttributedString(run.text)
            switch run.kind {
            case .command: part.foregroundColor = Theme.signal
            case .string: part.foregroundColor = Theme.done
            case .comment: part.foregroundColor = Theme.ink.opacity(0.4)
            case .plain: part.foregroundColor = Theme.ink
            }
            text += part
        }
        return text
    }
}

/// Lines in and out: `+14 −2`.
struct DiffStat: View {
    let added: Int
    let removed: Int
    /// Without its ground (inside a row that has one).
    var plain = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 5) {
            Text("+\(added)").foregroundStyle(Theme.done)
            Text("−\(removed)").foregroundStyle(Theme.failed)
        }
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .padding(.horizontal, plain ? 0 : 7).padding(.vertical, plain ? 0 : 3)
        .background(plain ? Color.clear : Theme.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
    }
}

/// What it is doing now: the tool, what on, and for how long; each sub-agent on a line of its own under it.
struct NowLine: View {
    let activity: TerminalActivity?
    let subagents: [TerminalSubagent]
    /// When this began (the activity, else the turn).
    let since: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                BrailleSpinner()
                if let activity {
                    Text(ToolDisplay.word(activity.tool)).mono(12, weight: .semibold).foregroundStyle(Theme.ink)
                    if let note = activity.note, !note.isEmpty {
                        Text(note).font(.footnote).foregroundStyle(Theme.ink.opacity(0.85)).lineLimit(1)
                    } else {
                        Text(MessageDisplay.readable(activity.target)).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                } else {
                    LookWord("Busy").mono(12, weight: .semibold).foregroundStyle(Theme.busy)
                }
                Spacer(minLength: 4)
                if let since {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(RecordDisplay.clock(Int(context.date.timeIntervalSince(since)))).mono(11).foregroundStyle(.tertiary).monospacedDigit()
                    }
                }
            }
            ForEach(subagents) { agent in
                HStack(spacing: 7) {
                    BrailleSpinner(color: .secondary)
                    Text(agent.name).mono(12, weight: .medium).foregroundStyle(Theme.ink.opacity(0.8)).lineLimit(1)
                    Text(agent.doing).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.leading, 18)
            }
        }
    }
}

/// What a run of work, or the last turn, changed: each file with its lines in and out, then its hunks.
struct ChangesSheet: View {
    let harness: String
    let session: String
    /// The run of work, or nil for the last turn.
    let work: String?
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.interfaceLook) private var look
    @State private var files: [FileDiff]?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Space.l) {
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                    if let files {
                        if files.isEmpty { Text("没有记录到改动。").font(.footnote).foregroundStyle(.tertiary) }
                        ForEach(files) { file in FileDiffView(file: file) }
                    } else if error == nil {
                        BrailleSpinner(color: .secondary).frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                    }
                }
                .padding(.horizontal, Theme.Space.l).padding(.vertical, Theme.Space.m)
            }
            .background(Theme.base)
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 8) {
                        Text("Changes").font(.headline)
                        if let files, !files.isEmpty {
                            DiffStat(added: files.reduce(0) { $0 + $1.added }, removed: files.reduce(0) { $0 + $1.removed })
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .followsLook()
        .task {
            guard let api = model.api else {
                #if DEBUG
                files = DemoData.changes
                #endif
                return
            }
            do { files = try await api.sessionChanges(harness: harness, id: session, work: work) } catch { self.error = error.localizedDescription }
        }
    }
}

private struct FileDiffView: View {
    let file: FileDiff
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(file.path).font(.caption.monospaced().weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                DiffStat(added: file.added, removed: file.removed, plain: true)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            HairRule()
            // Code keeps its lines: a long one scrolls sideways, with the whole file's hunks.
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                        if !hunk.header.isEmpty { line(hunk.header, color: .secondary, ground: Theme.code) }
                        ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, text in
                            line(text, color: text.hasPrefix("+") ? Theme.done : text.hasPrefix("-") ? Theme.failed : Theme.ink.opacity(0.75),
                                 ground: text.hasPrefix("+") ? Theme.done.opacity(0.1) : text.hasPrefix("-") ? Theme.failed.opacity(0.1) : .clear)
                        }
                    }
                }
                .frame(minWidth: 0, alignment: .leading)
            }
            if file.clipped {
                HairRule()
                Text("改动很长，只显示开头。").font(.caption).foregroundStyle(.tertiary).padding(.horizontal, 10).padding(.vertical, 6)
            }
        }
        .grounded(Theme.panel, radius: Theme.Radius.card)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .framed(Theme.line, radius: Theme.Radius.card)
    }

    private func line(_ text: String, color: Color, ground: Color) -> some View {
        Text(text.isEmpty ? " " : text).font(.caption.monospaced()).foregroundStyle(color).lineLimit(1).fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ground)
    }
}

/// The agent's own task list, on one line above the reply box (`Tasks 2/4` and the one in progress); opened, the list.
struct TasksRow: View {
    let plan: [PlanEntry]
    @State private var open = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if let line = RecordDisplay.plan(plan) {
            VStack(alignment: .leading, spacing: 6) {
                Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 6) {
                        LookGlyph.fold(open: open).foregroundStyle(.tertiary)
                        Text("Tasks \(line.done)/\(line.total)").mono(12, weight: .semibold).foregroundStyle(Theme.ink)
                        Text(line.now).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array(plan.enumerated()), id: \.offset) { _, entry in
                                HStack(alignment: .firstTextBaseline, spacing: 7) {
                                    mark(entry.state)
                                    Text(entry.text).font(.footnote)
                                        .foregroundStyle(entry.state == .done ? .secondary : .primary)
                                        .strikethrough(entry.state == .done, color: .secondary)
                                    Spacer(minLength: 0)
                                }
                            }
                        }
                        .padding(.leading, 18)
                    }
                    .frame(maxHeight: 180)
                    .fixedSize(horizontal: false, vertical: plan.count <= 7)
                }
            }
            .padding(.horizontal, Theme.Space.l).padding(.vertical, 8)
        }
    }

    @ViewBuilder private func mark(_ state: PlanEntry.State) -> some View {
        if look.isClassic {
            switch state {
            case .done: Image(systemName: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(Theme.done)
            case .doing: Image(systemName: "circle.dotted.circle").font(.system(size: 13)).foregroundStyle(Theme.signal)
            case .todo: Image(systemName: "circle").font(.system(size: 13)).foregroundStyle(.tertiary)
            }
        } else {
            Text(state == .done ? "[x]" : state == .doing ? "[>]" : "[ ]").mono(12)
                .foregroundStyle(state == .doing ? Theme.busy : state == .done ? Theme.done : Color.secondary)
        }
    }
}
