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
    /// The side beside the record (its task list, the files it changed), where the pane is wide enough for one: out
    /// when the user asks for it (the reply box's menu, `Show Side Pane`).
    @AppStorage("terminals.recordSide") private var sideShown = false

    /// The reading column at its widest (a pane with room to spare puts a side beside it, `RecordLayout`).
    static let column = CGFloat(RecordLayout.column)
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
        let source = record.sessionId.map { RecordSource(harness: record.agent, session: $0, client: model.client) }
        let files = RecordDisplay.changedFiles(record.items)
        GeometryReader { geo in
            // With room for both, the task list and the changed files stand beside the record (nothing to put there:
            // no side, the column alone).
            let side = sideShown && (!record.plan.isEmpty || !files.isEmpty) ? RecordLayout.side(pane: geo.size.width) : nil
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    ScrollViewReader { scroller in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 14) {
                                if let info { header(info, record) }
                                if record.more {
                                    Button { record.earlier() } label: {
                                        HStack(spacing: 6) {
                                            if record.loadingEarlier { BrailleSpinner() }
                                            Text("Earlier").mono(Look.size(12, look), weight: .medium)
                                        }
                                        .frame(maxWidth: .infinity)
                                    }
                                    .buttonStyle(.plain).foregroundStyle(Color.signal)
                                }
                                if !record.loaded {
                                    BrailleSpinner().foregroundStyle(Look.ink2).frame(maxWidth: .infinity).padding(.top, 24)
                                } else if record.items.isEmpty, !working, requests.isEmpty {
                                    Text(record.hasSession ? "还没有记录。" : "还没有开始对话。在下面回复，或切到终端视图。")
                                        .font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.faint)
                                }
                                ForEach(record.items) { item in
                                    RecordRow(item: item, verbose: record.verbose, running: working && item.id == record.items.last?.id && item.kind == .work, source: source) {
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
                                    Text("Exited").mono(Look.size(11, look)).foregroundStyle(Look.faint).frame(maxWidth: .infinity)
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
                        // What floats over the record's end; the record scrolls under it, and ends above it.
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            VStack(spacing: 0) {
                                if !atEnd {
                                    Button { withAnimation(.snappy(duration: 0.2)) { scroller.scrollTo(Self.end, anchor: .bottom) } } label: {
                                        Text("↓ Latest").mono(Look.size(11.5, look), weight: .medium).foregroundStyle(Look.ink)
                                            .padding(.horizontal, 10).padding(.vertical, 5)
                                            .grounded(Look.panel, radius: look.isClassic ? 13 : 0)
                                            .framed(Look.line, radius: look.isClassic ? 13 : 0)
                                    }
                                    .buttonStyle(.plain)
                                }
                                // The sealed reply (⌘⇧V, the status bar's lock) and the page's word about it, as over a terminal's screen.
                                if focused, let session = state.session, session.composing || session.notice != nil {
                                    VStack(spacing: 8) {
                                        if let notice = session.notice { NoticeLine(text: notice) }
                                        if session.composing { SealBox(model: session) }
                                    }
                                    .frame(maxWidth: Self.column)
                                    .padding(.horizontal, 24).padding(.top, 8)
                                }
                                RecordDock(state: state, model: model, focused: focused, working: working, waiting: !requests.isEmpty || info?.status == "waiting",
                                           beside: side != nil, sideShown: $sideShown) {
                                    if let session = record.sessionId { changes = ChangesRequest(harness: record.agent, session: session, work: nil) }
                                }
                            }
                        }
                    }
                }
                if let side {
                    HairRule(color: Look.line, vertical: true)
                    RecordSidePane(record: record, files: files)
                        .frame(width: side)
                        .contextMenu { Button("Hide Side Pane") { sideShown = false } }
                }
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
                .mono(Look.size(11.5, look)).foregroundStyle(Look.ink2).lineLimit(1)
            Text(DisplayPath.short(info.workdir, home: NSHomeDirectory())).font(.system(size: Look.size(11.5, look), design: .monospaced)).foregroundStyle(Look.ink2)
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
    /// Where a message's pictures and a step whole are asked for (absent before the session is known).
    let source: RecordSource?
    let showChanges: () -> Void
    @State private var open = false
    @State private var whole = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch item.kind {
        case .user:
            VStack(alignment: .trailing, spacing: 3) {
                // Typed while it worked: it has not read it yet.
                Text(item.queued ? "Queued" : TerminalListText.age(since: item.at, classic: look.isClassic)).mono(Look.size(10.5, look)).foregroundStyle(Look.faint)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                if !item.text.isEmpty { UserBox(text: item.text, faded: item.queued) }
                if item.images > 0 {
                    if let source { RecordPictures(source: source, item: item.id, count: item.images) }
                    else { Text(item.images == 1 ? "1 image" : "\(item.images) images").mono(Look.size(10.5, look)).foregroundStyle(Look.ink2) }
                }
            }
            .padding(.top, 4)
        case .answer:
            let head = whole ? nil : RecordDisplay.preview(item.text)
            VStack(alignment: .leading, spacing: 6) {
                // What it thought on the way reads quieter than what it has to say to you.
                MarkdownBlocks(text: head ?? item.text, size: Look.size(13.5, look), color: item.thinking ? Look.ink2 : Look.ink)
                if head != nil {
                    Button { whole = true } label: { Text("Show More").mono(Look.size(12, look), weight: .medium) }.buttonStyle(.plain).foregroundStyle(Color.signal)
                } else if item.clipped {
                    Text("这条回答很长，只读入了开头。").font(.system(size: Look.size(11.5, look))).foregroundStyle(Look.faint)
                }
            }
        case .work:
            work
        case .note:
            Text(item.text).mono(Look.size(10.5, look)).foregroundStyle(Look.faint).frame(maxWidth: .infinity)
        }
    }

    /// A run of work: one line (`Worked 1m 12s · Read 1 · Ran 2 · Edited 1`) with the lines it added and took away
    /// beside it; opened, each step on a line.
    private var work: some View {
        // Each with its place among the run's steps: that is how one is asked for whole.
        let steps = Array(item.steps.enumerated()).filter { verbose || $0.element.kind != .think }
        let shown = open || verbose || PaneRecord.previewOpenStep?.hasPrefix("\(item.id)/") == true
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button { open.toggle() } label: {
                    HStack(spacing: 6) {
                        RecordFold(open: shown)
                        Text(RecordDisplay.summary(item, running: running)).mono(Look.size(11.5, look)).foregroundStyle(Look.ink2).lineLimit(1)
                            .shimmer(running)
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
                ForEach(steps, id: \.offset) { index, step in
                    RecordStepLine(step: step, verbose: verbose, source: source, work: item.id, index: index, opened: PaneRecord.previewOpenStep == "\(item.id)/\(index)")
                }
            }
        }
    }
}

/// A part that folds: `▸ ▾`, the system's chevrons in the classic look.
struct RecordFold: View {
    let open: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group {
            if look.isClassic { Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)) }
            else { Text(open ? "▾" : "▸").font(.system(size: Look.size(11, look), design: .monospaced)) }
        }
        .foregroundStyle(Look.faint)
        .frame(width: 11)
    }
}

/// Lines in and out: `+14 −2`.
struct RecordDiffStat: View {
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
        .font(.system(size: Look.size(11, look), weight: .medium, design: .monospaced))
        .padding(.horizontal, plain ? 0 : 6).padding(.vertical, plain ? 0 : 2)
        .background(plain ? Color.clear : Look.code, in: RoundedRectangle(cornerRadius: look.isClassic ? 5 : 0, style: .continuous))
    }
}

/// What it is doing now: the tool, what on, and for how long; each sub-agent on a line of its own under it.
private struct RecordNowLine: View {
    @Environment(\.interfaceLook) private var look
    let activity: TerminalActivity?
    let subagents: [TerminalSubagent]
    let since: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                // Still going: its words are quiet, a band of light running across them — and that says it, so no
                // spinner turns beside them (2026-10-07, user: 加载图标实际上转圈圈可以去掉了，有流光特效的话). The classic
                // look has the small picture a step of that kind has; the pixel look, its words alone.
                if look.isClassic {
                    Image(systemName: RecordDisplay.toolSymbol(activity?.tool)).font(.system(size: 11.5)).foregroundStyle(Look.ink2).frame(width: 16, alignment: .center)
                }
                HStack(spacing: 7) {
                    if let activity {
                        Text(RecordDisplay.toolWord(activity.tool)).mono(Look.size(11.5, look), weight: .semibold).lineLimit(1)
                        if let note = activity.note, !note.isEmpty {
                            Text(note).font(.system(size: Look.size(12.5, look))).lineLimit(1)
                        } else {
                            Text(activity.target).font(.system(size: Look.size(11.5, look), design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        }
                    } else {
                        Text("Working").mono(Look.size(11.5, look), weight: .semibold)
                    }
                }
                .foregroundStyle(Look.ink2)
                .shimmer()
                Spacer(minLength: 4)
                if let since {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(RecordDisplay.clock(Int(context.date.timeIntervalSince(since)))).mono(Look.size(10.5, look)).foregroundStyle(Look.faint).monospacedDigit()
                    }
                }
            }
            ForEach(subagents) { agent in
                HStack(spacing: 7) {
                    if look.isClassic {
                        Image(systemName: RecordDisplay.symbol(.agent)).font(.system(size: 11.5)).foregroundStyle(Look.ink2).frame(width: 16, alignment: .center)
                    }
                    HStack(spacing: 7) {
                        Text(agent.name).mono(Look.size(11.5, look), weight: .medium).lineLimit(1)
                        Text(agent.doing).font(.system(size: Look.size(11.5, look), design: .monospaced)).lineLimit(1)
                    }
                    .foregroundStyle(Look.ink2)
                    .shimmer()
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
            Text("Waiting").mono(Look.size(12, look), weight: .semibold).foregroundStyle(Color.waiting)
            Text("程序在等你操作。这是它自己画的界面，记录里没有：切到终端视图回答。").font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: openTerminal) { BracketLabel(word: "Open Terminal", key: "⌘⇧E") }.buttonStyle(.plain)
        }
        .padding(12)
        .frame(maxWidth: 480, alignment: .leading)
        .grounded(Look.panel, radius: Look.cardRadius)
        .framed(look.isClassic ? Look.line : Look.ink2, radius: Look.cardRadius)
    }
}

/// Over the record's end: the reply in a box of its own, floating — the record runs out under it, no bar across the
/// pane (2026-10-07, user: 下面这个对话框横跨了一整条太突兀了，官方app都是悬浮的). In the box: the agent's task list
/// on a line (while the pane has no side for it), the reply's files, the reply, and a foot with `+`, how it asks, its
/// model, how full its context is and the send key. ↩ sends, ⇧↩ starts a new line; while it works and nothing is
/// typed, the key stops it.
private struct RecordDock: View {
    let state: TerminalPaneState
    let model: TerminalsModel
    /// The pane has the focus: its reply box takes the keyboard as it shows.
    let focused: Bool
    let working: Bool
    let waiting: Bool
    /// The pane has its side out: the task list and the context's fill are there, not here.
    let beside: Bool
    @Binding var sideShown: Bool
    let lastTurnChanges: () -> Void
    @State private var planOpen = false
    @State private var choosingEffort = false
    @Environment(\.interfaceLook) private var look

    /// The ground fades in over this much above the box.
    static let fade: CGFloat = 22

    var body: some View {
        @Bindable var record = state.record
        let info = state.session?.info
        let stops = working && !waiting && record.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !record.sending
        let radius: CGFloat = look.isClassic ? 14 : 0
        VStack(alignment: .leading, spacing: 6) {
            if let error = record.error {
                Text(error).font(.system(size: Look.size(12, look))).foregroundStyle(Color.failed).lineLimit(2).textSelection(.enabled).padding(.horizontal, 4)
            }
            VStack(alignment: .leading, spacing: 0) {
                if !beside, let line = RecordDisplay.plan(record.plan) {
                    VStack(alignment: .leading, spacing: 5) {
                        Button { planOpen.toggle() } label: {
                            HStack(spacing: 6) {
                                RecordFold(open: planOpen)
                                Text("Tasks \(line.done)/\(line.total)").mono(Look.size(11.5, look), weight: .semibold).foregroundStyle(Look.ink)
                                Text(line.now).font(.system(size: Look.size(12, look))).foregroundStyle(Look.ink2).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if planOpen { RecordPlanRows(plan: record.plan).padding(.leading, 17) }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    HairRule(color: Look.line)
                }
                if !record.draftFiles.isEmpty { RecordDraftStrip(record: record).padding(.horizontal, 10).padding(.top, 9) }
                ComposeField(text: $record.draft, height: $record.draftHeight, focusRequests: record.focusRequests, insert: record.insert, active: info?.status != "exited",
                             takesFocusAtFirst: focused, label: "Reply", onSubmit: { record.send() }, onFiles: { record.attach(urls: $0) },
                             onPasteAttachments: { record.pasteFromClipboard() }, onFocus: { on in if on { model.focus(pane: state.id) } })
                    .frame(height: min(max(record.draftHeight, ComposeField.minHeight), ComposeField.maxHeight))
                    .overlay(alignment: .topLeading) {
                        if record.draft.isEmpty {
                            Text(stops ? "Reply · esc to Stop" : "Reply").font(.system(size: 14)).foregroundStyle(Look.faint).padding(.leading, 5).allowsHitTesting(false)
                        }
                    }
                    .padding(.horizontal, 12).padding(.top, 11).padding(.bottom, 7)
                HStack(spacing: 8) {
                    MenuButton(entries: {
                        [MenuEntry(title: "Files…", symbol: "folder", action: { record.chooseFiles() }),
                         MenuEntry(title: "Paste Image", symbol: "doc.on.clipboard", key: "v", action: { record.pasteFromClipboard() })]
                    }, above: true, help: "Attach") {
                        LookGlyph(glyph: "+", symbol: "plus", size: 16).foregroundStyle(Look.ink2).frame(width: 26, height: 26).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(info?.status == "exited")
                    session(info, record)
                    Spacer(minLength: 8)
                    if !beside || RecordDisplay.contextMeter(record.usage) == nil, let context = RecordDisplay.context(record.usage) {
                        Text("Context \(context)").mono(Look.size(10.5, look)).foregroundStyle(Look.faint).lineLimit(1)
                    }
                    Button { if stops { record.interrupt() } else { record.send() } } label: {
                        Group {
                            if record.sending { BrailleSpinner() }
                            else if look.isClassic { Image(systemName: stops ? "stop.fill" : "arrow.up").font(.system(size: stops ? 9 : 12, weight: .bold)) }
                            else { Text(stops ? "■" : "↑").font(.system(size: stops ? 12 : 15, weight: .bold, design: .monospaced)) }
                        }
                        .foregroundStyle(record.canSend || stops ? (look.isClassic ? Color.white : Look.ground) : Look.faint)
                        .frame(width: look.isClassic ? 26 : 30, height: 26)
                        .background(sendGround(active: record.canSend || stops))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!record.canSend && !stops)
                    .help(stops ? "Stop esc" : "Send ↩ · New Line ⇧↩")
                }
                .padding(.leading, 7).padding(.trailing, 8).padding(.bottom, 8)
            }
            .grounded(Look.panel, radius: radius)
            .framed(Look.line, radius: radius)
            .shadow(color: .black.opacity(look.isClassic ? 0.12 : 0), radius: 12, y: 4)
        }
        .frame(maxWidth: TerminalRecordPane.column, alignment: .leading)
        .padding(.horizontal, 24).padding(.top, Self.fade - 8).padding(.bottom, 14)
        .frame(maxWidth: .infinity)
        // No bar: the record fades out under the box's top, and below that the pane's own ground.
        .background {
            VStack(spacing: 0) {
                LinearGradient(colors: [Look.ground.opacity(0), Look.ground], startPoint: .top, endPoint: .bottom).frame(height: Self.fade)
                Look.ground
            }
        }
        .onChange(of: record.draft) { record.keepDraftFiles() }
        .contextMenu {
            Button(record.verbose ? "Transcript: Normal" : "Transcript: Verbose") { record.verbose.toggle() }
            if record.hasSession, record.agent == "claude-code" || record.agent == "codex" { Button("Changes of the Last Turn", action: lastTurnChanges) }
            Button(sideShown ? "Hide Side Pane" : "Show Side Pane") { sideShown.toggle() }
        }
    }

    @ViewBuilder private func sendGround(active: Bool) -> some View {
        if look.isClassic { Circle().fill(active ? Color.signal : Look.raised) }
        else { Rectangle().fill(active ? Look.ink : Color.clear).overlay(Rectangle().strokeBorder(active ? Color.clear : Look.line, lineWidth: 1)) }
    }

    /// `Edits · Opus 5.5 ▾ · Medium ▾`: how it asks, then its model and how hard it thinks — each chosen there (2026-10-07,
    /// user: 简略模式的模型和思考强度怎么都动不了). Claude Code takes both from here: the model while it rests (a menu), the
    /// level on a slider. Another agent chooses on its own screen: the menu types its picker's command there.
    @ViewBuilder private func session(_ info: TerminalInfo?, _ record: PaneRecord) -> some View {
        let harness = info?.harness ?? record.agent
        let mode = RecordDisplay.mode(record.mode) ?? RecordDisplay.mode(info?.mode) ?? info?.mode?.capitalized
        let current = RecordDisplay.model(now: record.modelNow, record: record.usage?.model, started: info?.model)
        let levels = TerminalEffort.levels(models: model.models, any: model.efforts, harness: harness, current: current)
        let effort = TerminalEffort.level(asked: record.effortAsked, record: record.usage?.effort, started: info?.effort)
        let ended = info?.status == "exited"
        let resting = info?.status == "idle" && !waiting
        HStack(spacing: 5) {
            if let mode, !mode.isEmpty {
                Text(mode).foregroundStyle(Look.faint).lineLimit(1)
                Text("·").foregroundStyle(Look.faint)
            }
            MenuButton(entries: { modelEntries(harness: harness, current: current, resting: resting, ended: ended) }, above: true, help: "Model") {
                HStack(spacing: 3) {
                    if record.changing { BrailleSpinner() }
                    Text(current.map(ModelName.display) ?? "Model").lineLimit(1)
                    LookGlyph(glyph: "▾", symbol: "chevron.down", size: 9)
                }
                .foregroundStyle(Look.ink2)
                .padding(.vertical, 5).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // The level's slider is Claude Code's here; the others name theirs in the menu beside it.
            if harness == "claude-code", !levels.isEmpty {
                Text("·").foregroundStyle(Look.faint)
                Button { choosingEffort = true } label: {
                    HStack(spacing: 3) {
                        Text(effort.map(TerminalEffort.name) ?? TerminalEffort.word(harness)).lineLimit(1)
                        LookGlyph(glyph: "▾", symbol: "chevron.down", size: 9)
                    }
                    .foregroundStyle(Look.ink2)
                    .padding(.vertical, 5).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(ended)
                .help(TerminalEffort.word(harness))
                .popover(isPresented: $choosingEffort, arrowEdge: .top) {
                    EffortPicker(word: TerminalEffort.word(harness), levels: levels, level: effort,
                                 enabled: !waiting && !ended && !record.changing,
                                 note: waiting ? "它正在等待回答，回答后再调整。" : "会记成这个模型的默认；Max 只用于这一次。",
                                 choose: { record.setEffort($0) })
                        .frame(width: 300)
                        .padding(14)
                        .background(Look.panel)
                        // A popover is a window of its own: the look goes with it.
                        .environment(\.interfaceLook, look)
                }
            } else if let effort {
                Text("·").foregroundStyle(Look.faint)
                Text(TerminalEffort.name(effort)).foregroundStyle(Look.faint).lineLimit(1)
            }
        }
        .mono(Look.size(10.5, look))
    }

    private func modelEntries(harness: String, current: String?, resting: Bool, ended: Bool) -> [MenuEntry] {
        let record = state.record
        if ended { return [MenuEntry(title: "终端已结束", enabled: false)] }
        let options = model.models[harness] ?? []
        guard harness == "claude-code", !options.isEmpty else {
            // Its own picker, on its own screen (Codex chooses the reasoning with the model there).
            let open = { (command: String) in
                model.setSimple(false, pane: state.id)
                record.type(command: command)
            }
            var entries = [MenuEntry(title: harness == "codex" ? "Model and Reasoning in Terminal…" : "Choose in Terminal…", symbol: "terminal", enabled: resting,
                                     action: { open(RecordDisplay.modelPicker(harness)) })]
            if let picker = RecordDisplay.effortPicker(harness) {
                entries.append(MenuEntry(title: "\(TerminalEffort.word(harness)) in Terminal…", symbol: "terminal", enabled: resting, action: { open(picker) }))
            }
            return entries
        }
        guard resting else { return [MenuEntry(title: "它正在工作或等待回答，结束后再切换", enabled: false)] }
        let entry = { (option: TerminalModelOption) in
            MenuEntry(title: option.name, checked: RecordDisplay.isCurrent(option, model: current), action: { record.setModel(option.id) })
        }
        let older = options.filter(\.older)
        return options.filter { !$0.older }.map(entry) + (older.isEmpty ? [] : [.separator, MenuEntry(title: "Older", symbol: "clock", children: older.map(entry))])
            + [.separator, MenuEntry(title: "Claude Code 会把它记成新会话的默认模型", enabled: false)]
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
                        if files.isEmpty { Text("没有记录到改动。").font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.faint) }
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

struct RecordFileDiff: View {
    let file: FileDiff
    /// Its path and lines in and out above the hunks (not under a row that already says them).
    var header = true
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if header {
                HStack(spacing: 8) {
                    Text(file.path).font(.system(size: Look.size(12, look), weight: .medium, design: .monospaced)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.head)
                    Spacer(minLength: 4)
                    RecordDiffStat(added: file.added, removed: file.removed, plain: true)
                }
                .padding(.horizontal, 10).padding(.vertical, 7)
                HairRule(color: Look.line)
            }
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
                Text("改动很长，只显示开头。").font(.system(size: Look.size(11.5, look))).foregroundStyle(Look.faint).padding(.horizontal, 10).padding(.vertical, 5)
            }
        }
        .grounded(Look.panel, radius: Look.cardRadius)
        .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? Look.cardRadius : 0, style: .continuous))
        .framed(Look.line, radius: Look.cardRadius)
    }

    private func line(_ text: String, color: Color, ground: Color) -> some View {
        Text(text.isEmpty ? " " : text).font(.system(size: Look.size(11.5, look), design: .monospaced)).foregroundStyle(color).lineLimit(1).fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 1.5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ground)
    }
}
