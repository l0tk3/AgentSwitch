import AgentSwitchMacCore
import AppKit
import SwiftUI

// A pane's simple view (docs/simple-view-v0.md §5.2; demo `concepts/simple-view.html`, Mac): the record of the
// terminal's session in a reading column — what you said on the right, the agent's answers as Markdown, each run of
// work on one line that opens into its steps —, then what it is doing now and what waits for you; under it the reply
// box. It draws no terminal: the pane's screen is put away and holds no size, so the terminal can be in use on the
// phone meanwhile. It takes the system's light or dark (the terminal view is always dark).

struct TerminalRecordPane: View {
    let state: TerminalPaneState
    let model: TerminalsModel
    let focused: Bool
    @Environment(\.interfaceLook) private var look
    @State private var changes: ChangesRequest?
    @State private var atEnd = true
    @State private var dropping = false

    /// The reading column (the demo page's 700 pt).
    static let column: CGFloat = 700
    private static let end = "end"

    struct ChangesRequest: Identifiable {
        let id = UUID()
        let harness: String
        let session: String
        let work: String?
    }

    var body: some View {
        let record = state.record
        let info = state.session?.info
        let working = info?.status == "working"
        let requests = state.session?.requests ?? []
        let pictures = record.sessionId.map { RecordPictureSource(harness: record.agent, session: $0, client: model.client) }
        VStack(spacing: 0) {
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if let info { header(info, record) }
                        if record.more {
                            Button { record.earlier() } label: {
                                HStack(spacing: 6) {
                                    if record.loadingEarlier { BrailleSpinner() }
                                    Text("Earlier").mono(12, weight: .medium)
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.plain).foregroundStyle(Color.signal)
                        }
                        if !record.loaded {
                            BrailleSpinner().foregroundStyle(Look.ink2).frame(maxWidth: .infinity).padding(.top, 24)
                        } else if record.items.isEmpty, !working, requests.isEmpty {
                            Text(record.hasSession ? "还没有记录。" : "还没有开始对话。在下面回复，或切到终端视图。")
                                .font(.system(size: 12.5)).foregroundStyle(Look.faint)
                        }
                        ForEach(record.items) { item in
                            RecordRow(item: item, verbose: record.verbose, running: working && item.id == record.items.last?.id && item.kind == .work, pictures: pictures) {
                                if let session = record.sessionId { changes = ChangesRequest(harness: record.agent, session: session, work: item.id) }
                            }
                        }
                        if working, requests.isEmpty {
                            RecordNowLine(activity: record.activity, subagents: record.subagents, since: record.activitySince)
                        }
                        if let session = state.session {
                            ForEach(requests) { request in
                                Group {
                                    if request.isQuestion {
                                        TerminalQuestionCard(request: request, model: session, keys: focused && request.id == session.first?.id)
                                    } else {
                                        TerminalApprovalCard(request: request, model: session, keys: focused && request.id == session.first?.id)
                                    }
                                }
                                .frame(maxWidth: 480, alignment: .leading)
                            }
                        }
                        if info?.status == "waiting", requests.isEmpty { RecordPromptNote(openTerminal: { model.setSimple(false, pane: state.id) }) }
                        if info?.status == "exited" {
                            Text("Exited").mono(11).foregroundStyle(Look.faint).frame(maxWidth: .infinity)
                        }
                        Color.clear.frame(height: 1).id(Self.end)
                            .onAppear { atEnd = true }
                            .onDisappear { atEnd = false }
                    }
                    .frame(maxWidth: Self.column, alignment: .leading)
                    .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 14)
                    .frame(maxWidth: .infinity)
                }
                // The end is what matters: there when it opens, and following it while the reader is there.
                .onChange(of: record.loaded) { scroller.scrollTo(Self.end, anchor: .bottom) }
                .onChange(of: record.items.last) { if atEnd { scroller.scrollTo(Self.end, anchor: .bottom) } }
                .onChange(of: requests.count) { scroller.scrollTo(Self.end, anchor: .bottom) }
                .overlay(alignment: .bottom) {
                    if !atEnd {
                        Button { withAnimation(.snappy(duration: 0.2)) { scroller.scrollTo(Self.end, anchor: .bottom) } } label: {
                            Text("↓ Latest").mono(11.5, weight: .medium).foregroundStyle(Look.ink)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .grounded(Look.panel, radius: look.isClassic ? 13 : 0)
                                .framed(Look.line, radius: look.isClassic ? 13 : 0)
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 8)
                    }
                }
            }
            // The sealed reply (⌘⇧V, the status bar's lock) and the page's word about it, as over a terminal's screen.
            if focused, let session = state.session, session.composing || session.notice != nil {
                VStack(spacing: 8) {
                    if let notice = session.notice { NoticeLine(text: notice) }
                    if session.composing { SealBox(model: session) }
                }
                .frame(maxWidth: Self.column)
                .padding(.horizontal, 24).padding(.bottom, 8)
            }
            RecordDock(state: state, model: model, focused: focused, working: working, waiting: !requests.isEmpty || info?.status == "waiting") {
                if let session = record.sessionId { changes = ChangesRequest(harness: record.agent, session: session, work: nil) }
            }
        }
        .background(Look.ground)
        // Files dropped anywhere on the record are the reply's (on a terminal's screen they are typed at once).
        .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
            guard info != nil, info?.status != "exited" else { return false }
            RecordPage.load(providers) { urls in
                model.focus(pane: state.id)
                record.attach(urls: urls)
            }
            return true
        }
        .overlay { if dropping { Rectangle().strokeBorder(Color.signal, lineWidth: 1).allowsHitTesting(false) } }
        .sheet(item: $changes) { request in
            RecordChangesSheet(request: request, client: model.client)
        }
    }

    private func header(_ info: TerminalInfo, _ record: PaneRecord) -> some View {
        let modelName = RecordDisplay.model(now: record.modelNow, record: record.usage?.model, started: info.model).map(ModelName.display)
        return VStack(alignment: .leading, spacing: 5) {
            Text(info.name).font(.system(size: 17, weight: .semibold)).foregroundStyle(Look.ink).textSelection(.enabled).lineLimit(2)
            Text([TerminalListText.agentName(info.harness), modelName, state.session?.gitWords].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .mono(11.5).foregroundStyle(Look.ink2).lineLimit(1)
            Text(DisplayPath.short(info.workdir, home: NSHomeDirectory())).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.ink2)
                .lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 2)
    }
}

/// One item of the record.
private struct RecordRow: View {
    let item: RecordItem
    let verbose: Bool
    let running: Bool
    /// Where the pictures sent with a message are asked for (absent before the session is known).
    let pictures: RecordPictureSource?
    let showChanges: () -> Void
    @State private var open = false
    @State private var whole = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch item.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 3) {
                // Typed while it worked: it has not read it yet.
                Text(item.queued ? "Queued" : TerminalListText.age(since: item.at, classic: look.isClassic)).mono(10.5).foregroundStyle(Look.faint)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                if !item.text.isEmpty { UserBox(text: item.text, faded: item.queued) }
                if item.images > 0 {
                    if let pictures { RecordPictures(source: pictures, item: item.id, count: item.images) }
                    else { Text(item.images == 1 ? "1 image" : "\(item.images) images").mono(10.5).foregroundStyle(Look.ink2) }
                }
            }
            .padding(.top, 4)
        case .answer:
            let head = whole ? nil : RecordDisplay.preview(item.text)
            VStack(alignment: .leading, spacing: 6) {
                MarkdownBlocks(text: head ?? item.text, size: 13.5)
                if head != nil {
                    Button { whole = true } label: { Text("Show More").mono(12, weight: .medium) }.buttonStyle(.plain).foregroundStyle(Color.signal)
                } else if item.clipped {
                    Text("这条回答很长，只读入了开头。").font(.system(size: 11.5)).foregroundStyle(Look.faint)
                }
            }
        case .work:
            work
        case .note:
            Text(item.text).mono(10.5).foregroundStyle(Look.faint).frame(maxWidth: .infinity)
        }
    }

    /// A run of work: one line (`Worked 1m 12s · Read 1 · Ran 2 · Edited 1`) with the lines it added and took away
    /// beside it; opened, each step on a line.
    private var work: some View {
        let steps = RecordDisplay.shown(item.steps, verbose: verbose)
        let shown = open || verbose
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button { open.toggle() } label: {
                    HStack(spacing: 6) {
                        RecordFold(open: shown)
                        Text(RecordDisplay.summary(item, running: running)).mono(11.5).foregroundStyle(Look.ink2).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(verbose || steps.isEmpty)
                if let stat = RecordDisplay.stat(item.steps) {
                    Button(action: showChanges) { RecordDiffStat(added: stat.added, removed: stat.removed) }
                        .buttonStyle(.plain)
                        .help("Changes")
                }
            }
            if shown {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in RecordStepLine(step: step, verbose: verbose) }
            }
        }
    }
}

/// A part that folds: `▸ ▾`, the system's chevrons in the classic look.
private struct RecordFold: View {
    let open: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group {
            if look.isClassic { Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)) }
            else { Text(open ? "▾" : "▸").font(.system(size: 11, design: .monospaced)) }
        }
        .foregroundStyle(Look.faint)
        .frame(width: 11)
    }
}

private struct RecordStepLine: View {
    let step: RecordStep
    let verbose: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let file = RecordDisplay.namesFile(step)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(RecordDisplay.label(step)).mono(11.5, weight: .medium).foregroundStyle(step.failed ? Color.failed : Look.ink.opacity(0.75)).lineLimit(1)
                    .layoutPriority(1)
                // A file by the end of its path (its name); a command or a query from its start.
                Text(step.text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.ink2)
                    .lineLimit(verbose ? 6 : file ? 1 : 2).truncationMode(file ? .head : .tail).textSelection(.enabled)
                Spacer(minLength: 0)
                if step.added != nil || step.removed != nil { RecordDiffStat(added: step.added ?? 0, removed: step.removed ?? 0, plain: true) }
            }
            if let out = step.out, !out.isEmpty {
                Text(out).font(.system(size: 11, design: .monospaced)).foregroundStyle(step.failed ? Color.failed : Look.ink2)
                    .lineLimit(verbose ? 14 : 4).textSelection(.enabled)
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Look.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
            }
        }
        .padding(.leading, 17)
    }
}

/// Lines in and out: `+14 −2`.
private struct RecordDiffStat: View {
    let added: Int
    let removed: Int
    /// Without its ground (inside a row that has one).
    var plain = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 5) {
            Text("+\(added)").foregroundStyle(Color.ok)
            Text("−\(removed)").foregroundStyle(Color.failed)
        }
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .padding(.horizontal, plain ? 0 : 6).padding(.vertical, plain ? 0 : 2)
        .background(plain ? Color.clear : Look.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 5 : 0, style: .continuous))
    }
}

/// What it is doing now: the tool, what on, and for how long; each sub-agent on a line of its own under it.
private struct RecordNowLine: View {
    let activity: TerminalActivity?
    let subagents: [TerminalSubagent]
    let since: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                BrailleSpinner().foregroundStyle(Color.busy)
                if let activity {
                    Text(RecordDisplay.toolWord(activity.tool)).mono(11.5, weight: .semibold).foregroundStyle(Look.ink)
                    Text(activity.target).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.middle)
                } else {
                    Text("Working").mono(11.5, weight: .semibold).foregroundStyle(Color.busy)
                }
                Spacer(minLength: 4)
                if let since {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(RecordDisplay.clock(Int(context.date.timeIntervalSince(since)))).mono(10.5).foregroundStyle(Look.faint).monospacedDigit()
                    }
                }
            }
            ForEach(subagents) { agent in
                HStack(spacing: 7) {
                    BrailleSpinner().foregroundStyle(Look.ink2)
                    Text(agent.name).mono(11.5, weight: .medium).foregroundStyle(Look.ink.opacity(0.8)).lineLimit(1)
                    Text(agent.doing).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.ink2).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.leading, 17)
            }
        }
    }
}

/// The program drew something of its own and waits (a menu, a login): the record does not show it.
private struct RecordPromptNote: View {
    let openTerminal: () -> Void
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Waiting").mono(12, weight: .semibold).foregroundStyle(Color.waiting)
            Text("程序在等你操作。这是它自己画的界面，记录里没有：切到终端视图回答。").font(.system(size: 12.5)).foregroundStyle(Look.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: openTerminal) { BracketLabel(word: "Open Terminal", key: "⌘⇧E") }.buttonStyle(.plain)
        }
        .padding(12)
        .frame(maxWidth: 480, alignment: .leading)
        .grounded(Look.panel, radius: Look.cardRadius)
        .framed(look.isClassic ? Look.line : Look.ink2, radius: Look.cardRadius)
    }
}

/// Under the record: the agent's task list on a line, the reply box, and a line saying how it asks, its model and how
/// full its context is. ↩ sends, ⇧↩ starts a new line; while it works and nothing is typed, the button stops it.
private struct RecordDock: View {
    let state: TerminalPaneState
    let model: TerminalsModel
    /// The pane has the focus: its reply box takes the keyboard as it shows.
    let focused: Bool
    let working: Bool
    let waiting: Bool
    let lastTurnChanges: () -> Void
    @State private var planOpen = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        @Bindable var record = state.record
        let info = state.session?.info
        let stops = working && !waiting && record.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !record.sending
        VStack(spacing: 0) {
            HairRule(color: Look.line)
            VStack(alignment: .leading, spacing: 7) {
                if let line = RecordDisplay.plan(record.plan) {
                    VStack(alignment: .leading, spacing: 4) {
                        Button { planOpen.toggle() } label: {
                            HStack(spacing: 6) {
                                RecordFold(open: planOpen)
                                Text("Tasks \(line.done)/\(line.total)").mono(11.5, weight: .semibold).foregroundStyle(Look.ink)
                                Text(line.now).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if planOpen {
                            ForEach(Array(record.plan.enumerated()), id: \.offset) { _, entry in
                                HStack(alignment: .firstTextBaseline, spacing: 7) {
                                    Text(entry.state == .done ? "[x]" : entry.state == .doing ? "[>]" : "[ ]").mono(11)
                                        .foregroundStyle(entry.state == .doing ? Color.busy : entry.state == .done ? Color.ok : Look.faint)
                                    Text(entry.text).font(.system(size: 12)).foregroundStyle(entry.state == .done ? Look.ink2 : Look.ink)
                                        .strikethrough(entry.state == .done, color: Look.ink2)
                                }
                                .padding(.leading, 17)
                            }
                        }
                    }
                }
                if let error = record.error {
                    Text(error).font(.system(size: 12)).foregroundStyle(Color.failed).lineLimit(2).textSelection(.enabled)
                }
                if !record.draftFiles.isEmpty { RecordDraftStrip(record: record) }
                HStack(alignment: .bottom, spacing: 8) {
                    MenuButton(entries: {
                        [MenuEntry(title: "Files…", symbol: "folder", action: { record.chooseFiles() }),
                         MenuEntry(title: "Paste Image", symbol: "doc.on.clipboard", key: "v", action: { record.pasteFromClipboard() })]
                    }, above: true, help: "Attach") {
                        PlusSquare(side: look.isClassic ? 28 : ComposeField.minHeight + 16)
                    }
                    .buttonStyle(.plain)
                    .disabled(info?.status == "exited")
                    ComposeField(text: $record.draft, height: $record.draftHeight, focusRequests: record.focusRequests, insert: record.insert, active: info?.status != "exited",
                                 takesFocusAtFirst: focused, label: "Reply", onSubmit: { record.send() }, onFiles: { record.attach(urls: $0) },
                                 onPasteAttachments: { record.pasteFromClipboard() }, onFocus: { on in if on { model.focus(pane: state.id) } })
                        .frame(height: min(max(record.draftHeight, ComposeField.minHeight), ComposeField.maxHeight))
                        .padding(.horizontal, look.isClassic ? 11 : 10).padding(.vertical, 8)
                        .grounded(look.isClassic ? Look.raised : Color.clear, radius: look.isClassic ? 12 : 0)
                        .framed(look.isClassic ? Color.clear : Look.line, radius: look.isClassic ? 12 : 0)
                        .overlay(alignment: .leading) {
                            if record.draft.isEmpty { Text("Reply").font(.system(size: 14)).foregroundStyle(Look.faint).padding(.leading, look.isClassic ? 16 : 15).allowsHitTesting(false) }
                        }
                    Button { if stops { record.interrupt() } else { record.send() } } label: {
                        Group {
                            if record.sending { BrailleSpinner() }
                            else if look.isClassic { Image(systemName: stops ? "stop.fill" : "arrow.up").font(.system(size: stops ? 10 : 13, weight: .bold)) }
                            else { Text(stops ? "■" : "↑").font(.system(size: stops ? 13 : 17, weight: .bold, design: .monospaced)) }
                        }
                        .foregroundStyle(record.canSend || stops ? (look.isClassic ? Color.white : Look.ground) : Look.faint)
                        .frame(width: look.isClassic ? 28 : 34, height: look.isClassic ? 28 : ComposeField.minHeight + 16)
                        .background(sendGround(active: record.canSend || stops))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!record.canSend && !stops)
                    .help(stops ? "Stop esc" : "Send ↩")
                }
                HStack(spacing: 6) {
                    Text(sessionWords(info, record)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(working ? "↩ Send · esc Stop" : "↩ Send · ⇧↩ New Line").lineLimit(1)
                    if let context = RecordDisplay.context(record.usage) { Text("· Context \(context)").lineLimit(1) }
                }
                .mono(10.5).foregroundStyle(Look.faint)
            }
            .frame(maxWidth: TerminalRecordPane.column, alignment: .leading)
            .padding(.horizontal, 24).padding(.top, 9).padding(.bottom, 9)
            .frame(maxWidth: .infinity)
        }
        .background(Look.ground)
        .onChange(of: record.draft) { record.keepDraftFiles() }
        .contextMenu {
            Button(record.verbose ? "Transcript: Normal" : "Transcript: Verbose") { record.verbose.toggle() }
            if record.hasSession, record.agent == "claude-code" || record.agent == "codex" { Button("Changes of the Last Turn", action: lastTurnChanges) }
        }
    }

    @ViewBuilder private func sendGround(active: Bool) -> some View {
        if look.isClassic { Circle().fill(active ? Color.signal : Look.raised) }
        else { Rectangle().fill(active ? Look.ink : Color.clear).overlay(Rectangle().strokeBorder(active ? Color.clear : Look.line, lineWidth: 1)) }
    }

    /// `Edits · Opus 5.5 · Medium`: how it asks, its model, how hard it thinks.
    private func sessionWords(_ info: TerminalInfo?, _ record: PaneRecord) -> String {
        let mode = RecordDisplay.mode(record.mode) ?? RecordDisplay.mode(info?.mode) ?? info?.mode?.capitalized
        let modelName = RecordDisplay.model(now: record.modelNow, record: record.usage?.model, started: info?.model).map(ModelName.display)
        return [mode, modelName, record.usage?.effort.map(TerminalEffort.name)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// What a run of work, or the last turn, changed: each file with its lines in and out, then its hunks.
private struct RecordChangesSheet: View {
    let request: TerminalRecordPane.ChangesRequest
    let client: () -> DaemonClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.interfaceLook) private var look
    @State private var files: [FileDiff]?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("Changes").font(.system(size: 14, weight: .semibold)).foregroundStyle(Look.ink)
                if let files, !files.isEmpty { RecordDiffStat(added: files.reduce(0) { $0 + $1.added }, removed: files.reduce(0) { $0 + $1.removed }) }
                Spacer()
                Button { dismiss() } label: { BracketLabel(word: "Done", key: "esc") }.buttonStyle(.plain).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            HairRule(color: Look.line)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let files {
                        if files.isEmpty { Text("没有记录到改动。").font(.system(size: 12.5)).foregroundStyle(Look.faint) }
                        ForEach(files) { file in RecordFileDiff(file: file) }
                    } else {
                        BrailleSpinner().foregroundStyle(Look.ink2).frame(maxWidth: .infinity).padding(.top, 20)
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 720, height: 520)
        .background(Look.ground)
        .task { files = (try? await client().sessionChanges(harness: request.harness, id: request.session, work: request.work)) ?? [] }
    }
}

private struct RecordFileDiff: View {
    let file: FileDiff
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(file.path).font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                RecordDiffStat(added: file.added, removed: file.removed, plain: true)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            HairRule(color: Look.line)
            // Code keeps its lines: a long one scrolls sideways, with the whole file's hunks.
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                        if !hunk.header.isEmpty { line(hunk.header, color: Look.ink2, ground: Look.code) }
                        ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, text in
                            line(text, color: text.hasPrefix("+") ? Color.ok : text.hasPrefix("-") ? Color.failed : Look.ink.opacity(0.78),
                                 ground: text.hasPrefix("+") ? Color.ok.opacity(0.1) : text.hasPrefix("-") ? Color.failed.opacity(0.1) : .clear)
                        }
                    }
                }
            }
            if file.clipped {
                HairRule(color: Look.line)
                Text("改动很长，只显示开头。").font(.system(size: 11.5)).foregroundStyle(Look.faint).padding(.horizontal, 10).padding(.vertical, 5)
            }
        }
        .grounded(Look.panel, radius: Look.cardRadius)
        .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? Look.cardRadius : 0, style: .continuous))
        .framed(Look.line, radius: Look.cardRadius)
    }

    private func line(_ text: String, color: Color, ground: Color) -> some View {
        Text(text.isEmpty ? " " : text).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(color).lineLimit(1).fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ground)
    }
}
