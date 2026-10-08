import AgentSwitchKit
import SwiftUI

/// How a terminal's page shows it (docs/simple-view-v0.md §1): the session's record with a reply box, or the program's
/// own screen. Each terminal remembers the one last used on this phone; the phone opens one it has not seen in the
/// simple view (the Mac opens it as a terminal).
enum TerminalViewMode: String {
    case simple, terminal

    private static func key(_ id: String) -> String { "terminalView.\(id)" }

    static func saved(for id: String) -> TerminalViewMode {
        #if DEBUG
        if let demo = UserDefaults.standard.string(forKey: "uiDemoScreen") { return demo.hasPrefix("simple") ? .simple : .terminal }
        #endif
        return UserDefaults.standard.string(forKey: key(id)).flatMap(TerminalViewMode.init) ?? .simple
    }

    func save(for id: String) { UserDefaults.standard.set(rawValue, forKey: Self.key(id)) }

    /// A terminal that is gone leaves nothing behind.
    static func forget(_ id: String) { UserDefaults.standard.removeObject(forKey: key(id)) }
}

/// A terminal's simple view (docs/simple-view-v0.md §5.1; docs/design/concepts/simple-view.html): the session's record —
/// its title, what was said, each run of work on a line — then what it is doing now and what waits for you, last. It
/// draws no terminal, so it takes no size: the terminal can be in use on the Mac meanwhile.
struct TerminalRecordView: View {
    let page: TerminalPageModel
    let record: SessionRecordModel
    /// The terminal as the list has it now (its folder, model, session).
    let terminal: TerminalInfo
    let git: String?
    let verbose: Bool
    /// To the program's own screen (a prompt it drew itself).
    let openTerminal: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var changes: ChangesRequest?
    @State private var atEnd = true
    @State private var unseen = false

    struct ChangesRequest: Identifiable {
        let id = UUID()
        let work: String?
    }

    private static let end = "end"

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Space.l) {
                    header
                    if let error = record.error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                    if record.more {
                        Button { Task { await record.earlier(model.api) } } label: {
                            HStack(spacing: 6) {
                                if record.loadingEarlier { BrailleSpinner(color: .secondary) }
                                Text("Earlier").mono(13, weight: .medium)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.plain).foregroundStyle(Theme.signal)
                        .disabled(record.loadingEarlier)
                    }
                    if !record.loaded {
                        BrailleSpinner(color: .secondary).frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                    } else if record.items.isEmpty && page.sent.isEmpty && page.status != .working && page.permissions.isEmpty {
                        Text(record.hasSession ? "还没有记录。" : "还没有开始对话。在下面回复，或切到终端。").font(.footnote).foregroundStyle(.tertiary)
                    }
                    // What was sent and is not in the record yet stands at its end (2026-10-08).
                    ForEach(SentReply.appended(to: record.items, sent: page.sent, working: working)) { item in
                        RecordItemRow(item: item, verbose: verbose, running: working && item.id == record.items.last?.id && item.kind == .work,
                                      changes: canShowChanges ? { changes = ChangesRequest(work: item.id) } : nil,
                                      pictures: terminal.agentSessionId.map { RecordPictureSource(harness: terminal.harness, session: $0) })
                    }
                    if working && page.permissions.isEmpty {
                        NowLine(activity: page.activity ?? terminal.activity, subagents: page.activityKnown ? page.subagents : terminal.subagents, since: page.activitySince, progress: page.progress)
                    }
                    ForEach(page.permissions) { p in
                        if p.isQuestion { TerminalQuestionCard(page: page, permission: p) } else { TerminalPermissionCard(page: page, permission: p) }
                    }
                    // A list of its own on its screen (Codex's `/model`, a question of its own): the same rows here.
                    if let choices = page.choices, page.permissions.isEmpty {
                        choiceCard(title: choices.title, rows: choices.options.map { ($0.label, $0.detail) }, selected: choices.selected,
                                   foot: "这是它自己屏幕上的列表：点一行，等于在终端里选中并回车。") { pick in Task { await page.choose(pick) } }
                    } else if prompting { promptCard }
                    else if !working && page.permissions.isEmpty {
                        // What its last message asks, with the answers it offers (Codex): one of them as your reply.
                        ForEach(Array(RecordQuestion.open(items: record.items, sent: page.sent).enumerated()), id: \.offset) { _, question in
                            choiceCard(title: question.title, rows: question.options.map { ($0, nil) }, selected: nil,
                                       foot: "点一个作为回复发出；也可以在下面自己写。") { pick in Task { _ = await page.send(question.options[pick], sealed: false) } }
                        }
                    }
                    if page.status == .exited {
                        LookWord("Exited").mono(11).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .center)
                    }
                    Color.clear.frame(height: 1).id(Self.end)
                        .onAppear { atEnd = true; unseen = false }
                        .onDisappear { atEnd = false }
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            .scrollDismissesKeyboard(.interactively)
            // A tap anywhere in the record puts the keyboard away, as on the Dispatch page: a short record cannot be
            // dragged, and a tap beside the box is how one leaves it (2026-10-07, user: 键盘弹出之后我点击空白处应该可以让
            // 键盘缩回去才对).
            .simultaneousGesture(TapGesture().onEnded { Keyboard.dismiss() })
            // The end is what matters: there when it opens, and following it while the user is there. Scrolled back to
            // read, the page stays put and says there is more below.
            .onChange(of: record.loaded) { scroller.scrollTo(Self.end, anchor: .bottom) }
            .onChange(of: record.items.last) { follow(scroller) }
            .onChange(of: page.permissions.count) { follow(scroller, always: true) }
            .onChange(of: page.status) { follow(scroller) }
            .overlay(alignment: .bottom) {
                if !atEnd {
                    Button { withAnimation(.snappy(duration: 0.2)) { scroller.scrollTo(Self.end, anchor: .bottom) } } label: {
                        HStack(spacing: 5) {
                            LookGlyph(glyph: "↓", symbol: "arrow.down", size: 13)
                            Text(unseen ? "New" : "Latest").mono(12, weight: .medium)
                        }
                        .foregroundStyle(unseen ? Theme.signal : Theme.ink)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .grounded(Theme.panel, radius: 16)
                        .framed(Theme.line, radius: 16)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 8)
                    .transition(.opacity)
                }
            }
        }
        .background(Theme.base)
        .sheet(item: $changes) { request in
            if let session = terminal.agentSessionId {
                ChangesSheet(harness: terminal.harness, session: session, work: request.work)
            }
        }
    }

    private var working: Bool { page.status == .working }
    /// The program waits on something it drew itself (a menu, a login): no card of ours says what.
    private var prompting: Bool { page.status == .waiting && page.permissions.isEmpty }
    private var canShowChanges: Bool { terminal.agentSessionId != nil && (terminal.harness == "claude-code" || terminal.harness == "codex") }

    private func follow(_ scroller: ScrollViewProxy, always: Bool = false) {
        if atEnd || always { withAnimation(.snappy(duration: 0.2)) { scroller.scrollTo(Self.end, anchor: .bottom) } } else { unseen = true }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(MessageDisplay.readable(page.name)).font(.title3.weight(.semibold)).textSelection(.enabled)
            Text([ModelName.harness(terminal.harness),
                  RecordDisplay.model(now: page.modelNow ?? terminal.modelNow, record: record.usage?.model, started: terminal.model).map(ModelName.display),
                  git].compactMap { $0 }.joined(separator: " · "))
                .mono(12).foregroundStyle(.secondary).lineLimit(1)
            Text(PathDisplay.short(terminal.workdir)).mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Rows to take one of: a list the agent's own screen shows, or the answers its last message offers.
    private func choiceCard(title: String, rows: [(label: String, detail: String?)], selected: Int?, foot: String, take: @escaping (Int) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !title.isEmpty { Text(title).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true) }
            VStack(spacing: 6) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    Button { take(index) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(index + 1)").mono(12, weight: .medium).foregroundStyle(index == selected ? Theme.signal : Color.secondary).frame(width: 20, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.label).font(.subheadline).foregroundStyle(.primary).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                if let detail = row.detail, !detail.isEmpty {
                                    Text(detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 9)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .background(Color.primary.opacity(index == selected ? 0.10 : 0.05), in: RoundedRectangle(cornerRadius: look.isClassic ? 10 : 0, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(foot).font(.caption).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .grounded(Theme.panel, radius: Theme.Radius.card)
        .framed(look.isClassic ? Theme.line : Theme.ink, radius: Theme.Radius.card)
    }

    /// The program drew something of its own and waits: the keys are under the record now; its screen is one tap away.
    private var promptCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                TerminalStatusMark(status: .waiting)
                LookWord("Waiting").mono(13, weight: .semibold).foregroundStyle(Theme.waiting)
                Spacer(minLength: 0)
            }
            Text("程序在等你操作。这是它自己画的界面，记录里没有：用下面的按键回答，或打开终端查看。").font(.footnote).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: openTerminal) { ButtonWord("Open Terminal") }.buttonStyle(SquareButtonStyle(prominent: true))
        }
        .padding(14)
        .grounded(Theme.panel, radius: Theme.Radius.card)
        .framed(look.isClassic ? Theme.line : Theme.ink, radius: Theme.Radius.card)
    }
}
