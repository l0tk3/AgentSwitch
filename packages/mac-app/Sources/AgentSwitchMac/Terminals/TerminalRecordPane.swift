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
                                } else if record.items.isEmpty, record.sent.isEmpty, record.notices.isEmpty, !working, requests.isEmpty {
                                    if !record.hasSession, info?.status == "exited" {
                                        // It ended before it had a session: it did not start (a sign-in that timed out, a
                                        // missing program). What it said is on its own screen.
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text("没有启动起来就结束了。它最后说了什么在终端视图里。").font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.ink2)
                                            Button { model.setSimple(false, pane: state.id) } label: { BracketLabel(word: "Open Terminal", key: "⌘⇧E") }.buttonStyle(.plain)
                                        }
                                    } else {
                                        // A terminal seconds old with no session yet is still starting: said so, as a
                                        // record being read is (2026-10-08, user: cc进入的时候会有转圈加载的画面，codex没有).
                                        TimelineView(.periodic(from: .now, by: 1)) { context in
                                            let starting = !record.hasSession && (info.map { context.date.timeIntervalSince1970 * 1000 - Double($0.createdAt) < RecordDisplay.startingMs } ?? false)
                                            if starting {
                                                VStack(spacing: 8) {
                                                    BrailleSpinner().foregroundStyle(Look.ink2)
                                                    Text("Starting…").mono(Look.size(11, look)).foregroundStyle(Look.faint)
                                                }
                                                .frame(maxWidth: .infinity).padding(.top, 24)
                                            } else {
                                                Text(record.hasSession ? "还没有记录。" : "还没有开始对话。在下面回复，或切到终端视图。")
                                                    .font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.faint)
                                            }
                                        }
                                    }
                                }
                                ForEach(record.shown(working: working)) { item in
                                    RecordRow(item: item, verbose: record.verbose, running: working && item.id == record.items.last?.id && item.kind == .work, source: source) {
                                        if let session = record.sessionId { changes = ChangesRequest(harness: record.agent, session: session, work: item.id) }
                                    }
                                }
                                if working, requests.isEmpty {
                                    RecordNowLine(activity: record.activity, subagents: record.subagents, since: record.activitySince, progress: record.progress)
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
                                // A list of its own on its screen (Codex's `/model`, a question of its own): the same rows here.
                                if let choices = record.choices, requests.isEmpty {
                                    RecordChoiceCard(title: choices.title, rows: choices.options.map { ($0.label, $0.detail) }, selected: choices.selected,
                                                     foot: "这是它自己屏幕上的列表：点一行，等于在终端里选中并回车。", openTerminal: { model.setSimple(false, pane: state.id) }) { record.choose($0) }
                                } else if info?.status == "waiting", requests.isEmpty {
                                    RecordPromptNote(openTerminal: { model.setSimple(false, pane: state.id) })
                                } else if !working, requests.isEmpty {
                                    // What its last message asks, with the answers it offers (Codex): one of them as your reply.
                                    ForEach(Array(record.openQuestions.enumerated()), id: \.offset) { _, question in
                                        RecordChoiceCard(title: question.title, rows: question.options.map { ($0, nil) }, selected: nil,
                                                         foot: "点一个作为回复发出；也可以在下面自己写。", openTerminal: nil) { record.answer(question.options[$0]) }
                                    }
                                }
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
                        // A record already read when its view comes up (the window opened again, a pane switched back
                        // to it) has no change to hear of: it starts at its end, and is put there once laid out
                        // (2026-10-10, user: 打开窗口之后简略视图都会自动拉到最上面).
                        .defaultScrollAnchor(.bottom)
                        .onAppear {
                            guard record.loaded else { return }
                            DispatchQueue.main.async { scroller.scrollTo(Self.end, anchor: .bottom) }
                        }
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
                MarkdownBlocks(text: head ?? item.text, size: Look.prose(look).size, color: item.thinking ? Look.ink2 : Look.ink,
                               lineSpacing: Look.prose(look).lineSpacing, blockSpacing: Look.prose(look).blockSpacing)
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
    /// How far the turn has come, as the agent's own screen counts it: the number moves while it thinks, which a
    /// clock alone does not say (2026-10-08, user: working 建议加上token数量，不然都不知道是不是卡死了).
    var progress: TurnProgress? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                // Still going: its words are quiet, a band of light running across them — and that says it, so no
                // spinner turns beside them (2026-10-07, user: 加载图标实际上转圈圈可以去掉了，有流光特效的话). The classic
                // look has the small picture a step of that kind has; the pixel look, its words alone.
                if look.isClassic, let symbol = RecordDisplay.toolSymbol(activity?.tool) {
                    Image(systemName: symbol).font(.system(size: 11.5)).foregroundStyle(Look.ink2).frame(width: 16, alignment: .center)
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
                if let tokens = RecordDisplay.turnTokens(progress) {
                    Text(tokens).mono(Look.size(10.5, look)).foregroundStyle(Look.faint).monospacedDigit().lineLimit(1).fixedSize()
                        .contentTransition(.numericText())
                }
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

/// Rows to take one of: a list the agent's own screen shows, or the answers its last message offers. As the question
/// card of a Claude Code question reads: what is asked, the rows numbered, a line on what taking one does.
private struct RecordChoiceCard: View {
    let title: String
    let rows: [(label: String, detail: String?)]
    /// Where the selection stands on its screen (nil: nothing is selected, the rows are answers to send).
    let selected: Int?
    let foot: String
    let openTerminal: (() -> Void)?
    let take: (Int) -> Void
    @Environment(\.interfaceLook) private var look
    @State private var hovered: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !title.isEmpty {
                Text(title).font(.system(size: Look.size(12.5, look), weight: .semibold)).foregroundStyle(Look.ink).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    Button { take(index) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(index + 1)").mono(Look.size(11, look), weight: .medium).foregroundStyle(index == selected ? Color.signal : Look.faint).frame(width: 18, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(row.label).font(.system(size: Look.size(12.5, look))).foregroundStyle(Look.ink).fixedSize(horizontal: false, vertical: true)
                                if let detail = row.detail, !detail.isEmpty {
                                    Text(detail).font(.system(size: Look.size(11, look))).foregroundStyle(Look.ink2).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(hovered == index || index == selected ? Look.code : Color.clear, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { hovered = $0 ? index : (hovered == index ? nil : hovered) }
                }
            }
            HStack(spacing: 10) {
                Text(foot).font(.system(size: Look.size(11, look))).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let openTerminal { Button(action: openTerminal) { BracketLabel(word: "Open Terminal", key: "⌘⇧E") }.buttonStyle(.plain) }
            }
        }
        .padding(12)
        .frame(maxWidth: 520, alignment: .leading)
        .grounded(Look.panel, radius: Look.cardRadius)
        .framed(look.isClassic ? Look.line : Look.ink2, radius: Look.cardRadius)
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
        // A rounder box (2026-10-07, user: 回复的这个框体圆角可以更大): 20, as the agents' own apps round theirs.
        let radius: CGFloat = look.isClassic ? 20 : 0
        VStack(alignment: .leading, spacing: 6) {
            if let error = record.error {
                Text(error).font(.system(size: Look.size(12, look))).foregroundStyle(Color.failed).lineLimit(2).textSelection(.enabled).padding(.horizontal, 4)
            }
            // Codex's Daybreak switch and the model it is on do not go together: its next turn would not start, and
            // only its own screen would say so (docs/simple-view-v0.md §5.8).
            if let clash = daybreakClash(info, record) {
                Text(clash).font(.system(size: Look.size(12, look))).foregroundStyle(Color.attention).lineLimit(2).padding(.horizontal, 4)
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
                // What the box offers for what is being typed: commands after a `/`, files after an `@`.
                if record.hintsOpen {
                    ReplyHintList(record: record)
                    HairRule(color: Look.line)
                }
                if !record.draftFiles.isEmpty { RecordDraftStrip(record: record).padding(.horizontal, 10).padding(.top, 9) }
                ComposeField(text: $record.draft, height: $record.draftHeight, focusRequests: record.focusRequests, insert: record.insert, active: info?.status != "exited",
                             takesFocusAtFirst: focused, label: "Reply", placeholder: placeholder(stops: stops, offered: record.suggestion ?? info?.suggestion, resting: info?.status == "idle"),
                             replace: record.replace, onKey: { record.hintKey($0) }, onCaret: { record.typing($0, caret: $1) },
                             onSubmit: { record.send() }, onFiles: { record.attach(urls: $0) },
                             onPasteAttachments: { record.pasteFromClipboard() }, onFocus: { on in if on { model.focus(pane: state.id) } })
                    .frame(height: min(max(record.draftHeight, ComposeField.minHeight), ComposeField.maxHeight))
                    .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 7)
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
                .padding(.leading, 9).padding(.trailing, 9).padding(.bottom, 9)
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
        // How it asks: what its stream or screen said last, else its record's word, else what it was started with.
        let raw = RecordDisplay.modeNow(now: record.modeNow ?? info?.modeNow, record: record.mode, started: info?.mode)
        let mode = RecordDisplay.mode(raw) ?? raw?.capitalized
        let current = RecordDisplay.model(now: record.modelNow, record: record.usage?.model, started: info?.model)
        let levels = TerminalEffort.levels(models: model.models, any: model.efforts, harness: harness, current: current)
        let effort = TerminalEffort.level(asked: record.effortAsked, record: record.usage?.effort, started: info?.effort)
        // What cannot be changed from here now is said as plain words, not as something to press (2026-10-07, user:
        // 不能切换的话就让他点不动); resting the pointer on it says why.
        // Codex's Daybreak switch, where this terminal has one: its models are the ones that run as it stands.
        let daybreak = record.daybreakNow ?? info?.daybreak
        let options = TerminalDaybreak.offered(model.models[harness] ?? [], on: daybreak)
        let clashes = daybreakClash(info, record) != nil
        // Codex takes its command while it works too (it holds from the next turn); not while it waits for an answer.
        let daybreakLock = RecordDisplay.locked(harness: harness, status: info?.status, waiting: waiting, whileWorking: true, sets: true)
        let modeLock = harness == "claude-code" ? RecordDisplay.locked(harness: harness, status: info?.status, waiting: waiting) : "这个 agent 的权限方式在启动时选定。"
        let modelLock = RecordDisplay.locked(harness: harness, status: info?.status, waiting: waiting, sets: info?.sets) ?? (options.isEmpty ? "还没有读到它的模型列表。" : nil)
        // Claude Code takes a level while it works too (the next request of the turn runs at it); pi only at rest.
        let effortLock = RecordDisplay.locked(harness: harness, status: info?.status, waiting: waiting, whileWorking: harness == "claude-code", sets: info?.sets)
        HStack(spacing: 5) {
            if let mode, !mode.isEmpty {
                // Skipping every permission is said in the colour of a warning; Claude Code's mode is chosen here
                // (2026-10-07, user: Bypass权限那一块要可以调整，同时要标注出颜色).
                let tone = RecordDisplay.skipsPermissions(raw) ? Color.failed : Look.ink2
                if modeLock == nil {
                    MenuButton(entries: { modeEntries(current: raw) }, above: true, help: "Permissions") {
                        HStack(spacing: 3) {
                            Text(mode).lineLimit(1)
                            LookGlyph(glyph: "▾", symbol: "chevron.down", size: 9)
                        }
                        .foregroundStyle(tone)
                        .padding(.vertical, 5).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(mode).foregroundStyle(RecordDisplay.skipsPermissions(raw) ? Color.failed : Look.faint).lineLimit(1).help(modeLock ?? "")
                }
                Text("·").foregroundStyle(Look.faint)
            }
            if modelLock == nil, !record.changing {
                MenuButton(entries: { modelEntries(harness: harness, options: options, current: current) }, above: true, help: "Model") {
                    HStack(spacing: 3) {
                        Text(current.map(ModelName.display) ?? "Model").lineLimit(1)
                        LookGlyph(glyph: "▾", symbol: "chevron.down", size: 9)
                    }
                    .foregroundStyle(clashes ? Color.attention : Look.ink2)
                    .padding(.vertical, 5).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                HStack(spacing: 3) {
                    if record.changing { BrailleSpinner() }
                    Text(current.map(ModelName.display) ?? "Model").lineLimit(1)
                }
                .foregroundStyle(Look.faint)
                .help(modelLock ?? "")
            }
            if !levels.isEmpty, effortLock == nil {
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
                .help(TerminalEffort.word(harness))
                .popover(isPresented: $choosingEffort, arrowEdge: .top) {
                    EffortPicker(word: TerminalEffort.word(harness), levels: levels, level: effort,
                                 enabled: !record.changing,
                                 note: harness == "claude-code" ? "会记成这个模型的默认；Max 只用于这一次。" : nil,
                                 choose: { record.setEffort($0) })
                        .frame(width: 150)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(Look.panel)
                        // A popover is a window of its own: the look goes with it.
                        .environment(\.interfaceLook, look)
                }
            } else if let effort {
                Text("·").foregroundStyle(Look.faint)
                Text(TerminalEffort.name(effort)).foregroundStyle(Look.faint).lineLimit(1).help(effortLock ?? "")
            }
            if let daybreak {
                Text("·").foregroundStyle(Look.faint)
                if daybreakLock == nil, !record.changing {
                    MenuButton(entries: { daybreakEntries(on: daybreak) }, above: true, help: "Daybreak") {
                        HStack(spacing: 3) {
                            Text(TerminalDaybreak.word(daybreak)).lineLimit(1)
                            LookGlyph(glyph: "▾", symbol: "chevron.down", size: 9)
                        }
                        .foregroundStyle(Look.ink2)
                        .padding(.vertical, 5).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(TerminalDaybreak.word(daybreak)).foregroundStyle(Look.faint).lineLimit(1).help(daybreakLock ?? "")
                }
            }
        }
        .mono(Look.size(10.5, look))
    }

    /// Why the model it is on cannot run as Codex's Daybreak switch stands; nil when it can, or where there is no switch.
    private func daybreakClash(_ info: TerminalInfo?, _ record: PaneRecord) -> String? {
        guard let on = record.daybreakNow ?? info?.daybreak else { return nil }
        let current = RecordDisplay.model(now: record.modelNow, record: record.usage?.model, started: info?.model)
        let option = (model.models[info?.harness ?? record.agent] ?? []).first { RecordDisplay.isCurrent($0, model: current) }
        return TerminalDaybreak.clash(model: option, on: on, name: current.map(ModelName.display))
    }

    /// Codex's Daybreak switch: on, off — the one it stands at checked — and what turning it does beyond this session.
    private func daybreakEntries(on: Bool) -> [MenuEntry] {
        let record = state.record
        return [MenuEntry(title: "On", checked: on, action: { record.setDaybreak(true) }),
                MenuEntry(title: "Off", checked: !on, action: { record.setDaybreak(false) }),
                .separator, MenuEntry(title: TerminalDaybreak.note, enabled: false)]
    }

    /// Claude Code's ways of asking; the one it is in checked. It changes while it rests: the service presses its ⇧Tab
    /// until its screen names the mode chosen.
    /// What the empty box says: what Claude Code offers as your next message while it rests and offers one (tab writes
    /// it in), else the box's own word.
    private func placeholder(stops: Bool, offered: String?, resting: Bool) -> String {
        if resting, let offered, !offered.isEmpty { return "\(offered)  ·  tab" }
        return stops ? "Reply · esc to Stop" : "Reply"
    }

    private func modeEntries(current: String?) -> [MenuEntry] {
        let record = state.record
        let now = RecordDisplay.mode(current)
        return RecordDisplay.claudeModes.compactMap { raw in
            RecordDisplay.mode(raw).map { name in MenuEntry(title: name, checked: name == now, action: { record.setMode(raw, name: name) }) }
        }
    }

    /// The agent's models, the one it is on checked. Only for an agent that takes a model from here, while it rests
    /// (otherwise there is no menu: `RecordDisplay.locked`).
    private func modelEntries(harness: String, options: [TerminalModelOption], current: String?) -> [MenuEntry] {
        let record = state.record
        let entry = { (option: TerminalModelOption) in
            MenuEntry(title: option.name, checked: RecordDisplay.isCurrent(option, model: current), action: { record.setModel(option.id) })
        }
        let older = options.filter(\.older)
        return options.filter { !$0.older }.map(entry) + (older.isEmpty ? [] : [.separator, MenuEntry(title: "Older", symbol: "clock", children: older.map(entry))])
            + (harness == "claude-code" ? [.separator, MenuEntry(title: "Claude Code 会把它记成新会话的默认模型", enabled: false)] : [])
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
