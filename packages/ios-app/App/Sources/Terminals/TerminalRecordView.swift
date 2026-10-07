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
                    } else if record.items.isEmpty && page.status != .working && page.permissions.isEmpty {
                        Text(record.hasSession ? "还没有记录。" : "还没有开始对话。在下面回复，或切到终端。").font(.footnote).foregroundStyle(.tertiary)
                    }
                    ForEach(record.items) { item in
                        RecordItemRow(item: item, verbose: verbose, running: working && item.id == record.items.last?.id && item.kind == .work,
                                      changes: canShowChanges ? { changes = ChangesRequest(work: item.id) } : nil)
                    }
                    if working && page.permissions.isEmpty {
                        NowLine(activity: page.activity ?? terminal.activity, subagents: page.activityKnown ? page.subagents : terminal.subagents, since: page.activitySince)
                    }
                    ForEach(page.permissions) { p in
                        if p.isQuestion { TerminalQuestionCard(page: page, permission: p) } else { TerminalPermissionCard(page: page, permission: p) }
                    }
                    if prompting { promptCard }
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
            Text([ModelName.harness(terminal.harness), (record.usage?.model ?? terminal.model).map(ModelName.display), git].compactMap { $0 }.joined(separator: " · "))
                .mono(12).foregroundStyle(.secondary).lineLimit(1)
            Text(PathDisplay.short(terminal.workdir)).mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
