import AgentSwitchMacCore
import AppKit
import SwiftUI

/// A pane's simple view (docs/simple-view-v0.md §1, §5.2): the record of the terminal's session — the latest page, the
/// earlier ones asked for, the agent's task list, how full its context is — what the agent is doing now, and the reply
/// being written. While a pane shows it, the pane's screen has no stream of its own and holds no size: the terminal's
/// events (its status, the requests it waits on) come with this one's, which also says when the record changed.
@MainActor
@Observable
final class PaneRecord {
    private(set) var items: [RecordItem] = []
    private(set) var plan: [PlanEntry] = []
    private(set) var usage: RecordUsage?
    private(set) var mode: String?
    /// There is more before what is shown.
    private(set) var more = false
    /// Read at least once (an empty record is then really empty).
    private(set) var loaded = false
    private(set) var loadingEarlier = false
    private(set) var activity: TerminalActivity?
    private(set) var subagents: [TerminalSubagent] = []
    /// When what it is doing now began.
    private(set) var activitySince: Date?
    /// The model the agent says it is on now (Claude Code), once it has said.
    private(set) var modelNow: String?
    private(set) var error: String?

    // The reply being written.
    var draft = ""
    var draftHeight = ComposeField.minHeight
    private(set) var sending = false
    /// Each change puts the keyboard in the reply box.
    private(set) var focusRequests = 0
    /// The transcript in full: every run of work open, thinking shown.
    var verbose = false

    @ObservationIgnored private var terminal: String?
    @ObservationIgnored private var harness = ""
    @ObservationIgnored private var session: String?
    @ObservationIgnored private var cursor: Int64 = 0
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var following: Task<Void, Never>?
    @ObservationIgnored private var client: () -> DaemonClient = { DaemonClient(port: 1) }
    /// The design preview put a record here: nothing is asked of a service.
    @ObservationIgnored private var staged = false

    var hasSession: Bool { session != nil }
    var sessionId: String? { session }
    var agent: String { harness }

    /// Follows `terminal` (already following it: only what the list now knows of it is taken). `frame`: each of the
    /// stream's frames, for the terminal's own model (status, requests, exit).
    func follow(_ info: TerminalInfo, client: @escaping () -> DaemonClient, frame: @escaping (_ event: String, _ data: String) -> Void) {
        if staged { return }
        self.client = client
        if terminal != info.id {
            stop()
            terminal = info.id
            harness = info.harness
            let id = info.id
            following = Task { [weak self] in
                for await message in client().recordEvents(id: id) {
                    guard let self, !Task.isCancelled else { return }
                    frame(message.event, message.data)
                    self.took(message.event, message.data)
                }
            }
        }
        if info.status != "working" { stillNow() }
        // The agent says which session it writes a moment after it starts; a `/clear` or a fork changes it.
        guard info.agentSessionId != session || info.harness != harness else { return }
        harness = info.harness
        session = info.agentSessionId
        items = []; plan = []; usage = nil; mode = nil; more = false; cursor = 0; error = nil
        loaded = session == nil
        refresh()
    }

    func stop() {
        following?.cancel()
        following = nil
        terminal = nil
        session = nil
        items = []; plan = []; usage = nil; mode = nil; more = false; cursor = 0; loaded = false; error = nil
        activity = nil; subagents = []; activitySince = nil; modelNow = nil
        draft = ""
    }

    private func took(_ event: String, _ data: String) {
        switch TerminalRecordEvent.decode(event: event, data: data) {
        case .activity(let now, let agents):
            if now != activity { activity = now; activitySince = Date() }
            if subagents != agents { subagents = agents }
        case .record:
            refresh()
        case .model(let model):
            modelNow = model
        case nil:
            // A turn began or ended: its clock starts over, and what the record holds may have moved on.
            if event == "status" { activitySince = Date(); refresh() }
        }
    }

    private func stillNow() {
        if activity != nil { activity = nil }
        if !subagents.isEmpty { subagents = [] }
    }

    /// The latest page. Asked for again while one is on its way, it is read once more after that one.
    func refresh() {
        guard let id = session else { return }
        if reading { again = true; return }
        reading = true
        let harness = harness, client = client
        Task { [weak self] in
            defer { self?.reading = false }
            repeat {
                self?.again = false
                do {
                    let page = try await client().sessionRecord(harness: harness, id: id)
                    guard let self, id == self.session else { return }
                    self.take(page)
                } catch {
                    guard let self, id == self.session else { return }
                    // Not listed yet (a session seconds old) reads as an empty record, not as an error.
                    if !self.loaded { self.loaded = true }
                }
            } while self?.again == true
        }
    }

    private func take(_ page: SessionRecord) {
        if plan != page.plan { plan = page.plan }
        if usage != page.usage { usage = page.usage }
        if mode != page.mode { mode = page.mode }
        let (next, replaced) = SessionRecord.merged(held: items, page: page.items)
        if items != next { items = next }
        if replaced { cursor = page.cursor; more = page.more }
        loaded = true
        error = nil
    }

    /// The page before the earliest shown.
    func earlier() {
        guard let id = session, more, !loadingEarlier else { return }
        loadingEarlier = true
        let harness = harness, client = client, before = cursor
        Task { [weak self] in
            defer { self?.loadingEarlier = false }
            guard let page = try? await client().sessionRecord(harness: harness, id: id, limit: 80, before: before), let self, id == self.session else { return }
            let known = Set(self.items.map(\.id))
            self.items = page.items.filter { !known.contains($0.id) } + self.items
            self.cursor = page.cursor
            self.more = page.more
        }
    }

    // MARK: replying

    func focusReply() { focusRequests += 1 }

    var canSend: Bool { !sending && terminal != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The reply typed into the terminal as it is and entered, as the keyboard would.
    func send() {
        guard canSend, let terminal else { return }
        let text = draft
        sending = true
        let client = client
        Task { [weak self] in
            defer { self?.sending = false }
            do {
                try await client().typeIntoTerminal(id: terminal, text: text)
                guard let self else { return }
                if self.draft == text { self.draft = "" }
                self.error = nil
            } catch {
                self?.error = (error as? DaemonError)?.reason ?? error.localizedDescription
            }
        }
    }

    /// While it works: stop it (esc, as in the terminal).
    func interrupt() {
        guard let terminal else { return }
        let client = client
        Task { try? await client().terminalKeys(id: terminal, ["esc"]) }
    }

    #if DEBUG
    /// The design preview's: a record from made-up work, without a service.
    func stage(terminal: TerminalInfo, items: [RecordItem], plan: [PlanEntry], usage: RecordUsage?, mode: String?, activity: TerminalActivity?, since: Date?) {
        following?.cancel()
        following = nil
        staged = true
        self.terminal = terminal.id
        harness = terminal.harness
        session = terminal.agentSessionId ?? "preview"
        self.items = items
        self.plan = plan
        self.usage = usage
        self.mode = mode
        self.activity = activity
        activitySince = since
        more = true
        loaded = true
    }
    #endif
}
