import AgentSwitchMacCore
import SwiftUI

/// A pane's sub-agent card (docs/simple-view-v0.md §5.22): one of the session's sub-agents — the one a row of the list,
/// a line of the record or a step was clicked for — and its record as the service reads it from the file Claude Code
/// keeps of it: what it was sent to do, its work step by step, what it handed back. While the card is on screen the
/// record is asked for again every second or so with the version held: the service reads nothing for the same one.
@MainActor
@Observable
final class SubagentCardModel: Identifiable {
    let id = UUID()
    private(set) var target: SubagentTarget
    /// What it is called until its record says: as the row or the step that opened the card names it.
    private(set) var name: String
    private(set) var type: String
    /// What the service says of it, once its record is read.
    private(set) var agent: SubagentSummary?
    private(set) var items: [RecordItem] = []
    private(set) var usage: RecordUsage?
    /// There is more before what is held.
    private(set) var more = false
    /// Read at least once (an empty record is then really empty).
    private(set) var loaded = false
    private(set) var loadingEarlier = false
    /// Why there is no record to show, in a sentence; nil while there is one, or none has been looked for long enough.
    private(set) var problem: String?
    /// The session's sub-agents, for the head's menu.
    private(set) var others: [SubagentSummary] = []
    /// Asked to be tall: as high as the pane, not a small view.
    var tall = false
    /// The runs of work the reader opened (true) or closed (false) themselves, by their item's id: kept while the
    /// record grows under them. One not in it is shown as its state says (`SubagentDisplay.fold`).
    var folds: [String: Bool] = [:]

    @ObservationIgnored private var cursor: Int64 = 0
    @ObservationIgnored private var version: String?
    /// Reads in a row that found no record.
    @ObservationIgnored private var misses = 0
    @ObservationIgnored private let client: () -> DaemonClient
    /// The design preview put a record here: nothing is asked of a service.
    @ObservationIgnored private var staged = false

    /// How often the record is asked for: while the sub-agent has not ended, and after (one that ended may be sent on
    /// with another message, and its record grows again).
    static let quick: Duration = .seconds(1)
    static let slow: Duration = .seconds(5)
    /// The session's other sub-agents are listed again every so many reads.
    static let listEvery = 5
    /// A sub-agent seconds old has no file yet: no record is said to be missing before this many reads found none.
    static let missesBeforeSaying = 3

    init(target: SubagentTarget, name: String, type: String, client: @escaping () -> DaemonClient) {
        self.target = target
        self.name = name
        self.type = type
        self.client = client
    }

    /// Another of the same session's sub-agents in the card: what was shown of the first is gone.
    func show(agent id: String, name: String, type: String) {
        guard id != target.agent else { return }
        target = SubagentTarget(harness: target.harness, session: target.session, agent: id)
        self.name = name
        self.type = type
        agent = nil
        items = []; usage = nil; more = false; loaded = false; problem = nil; folds = [:]
        cursor = 0; version = nil; misses = 0
    }

    /// The card's title and the kind beside it.
    var title: String { SubagentDisplay.title(name: name, type: type) }
    var kind: String? { SubagentDisplay.kind(name: name, type: type) }

    /// Reads the record, now and again, until cancelled: the card's view runs this while it is seen (`\.onScreen`; out
    /// of sight nothing is asked for), and again for each sub-agent it is asked to show.
    func follow() async {
        guard !staged else { return }
        var reads = 0
        while !Task.isCancelled {
            if reads % Self.listEvery == 0 { await list() }
            await read()
            reads += 1
            try? await Task.sleep(for: agent?.done == true || problem != nil ? Self.slow : Self.quick)
        }
    }

    private func list() async {
        let target = target
        // Not read just now (the service is away, or predates the list): what was listed stays.
        guard let all = try? await client().sessionSubagents(harness: target.harness, id: target.session) else { return }
        guard !Task.isCancelled, target.session == self.target.session else { return }
        if others != all { others = all }
    }

    private func read() async {
        let target = target
        do {
            guard let page = try await client().subagentRecord(target, unless: version) else { return }
            guard !Task.isCancelled, target == self.target else { return }
            version = page.version
            take(page.value)
        } catch DaemonError.notSupported {
            guard target == self.target else { return }
            problem = SubagentDisplay.unsupported
            loaded = true
        } catch DaemonError.http(status: 404, message: _) {
            guard target == self.target else { return }
            misses += 1
            // What was read before stays: the file is being written, or its session is being moved.
            if misses >= Self.missesBeforeSaying, items.isEmpty { problem = SubagentDisplay.missing; loaded = true }
        } catch {
            // The service is away (restarting): what is shown stays, and it is asked again.
        }
    }

    private func take(_ page: SubagentRecord) {
        if agent != page.agent { agent = page.agent }
        if !page.agent.name.isEmpty, name != page.agent.name { name = page.agent.name }
        if !page.agent.type.isEmpty, type != page.agent.type { type = page.agent.type }
        let (next, replaced) = SessionRecord.merged(held: items, page: page.items)
        if items != next { items = next }
        if replaced { cursor = page.cursor; more = page.more }
        if usage != page.usage { usage = page.usage }
        if !loaded { loaded = true }
        if problem != nil { problem = nil }
        misses = 0
    }

    /// The page before what is held.
    func earlier() {
        guard more, !loadingEarlier, !staged else { return }
        loadingEarlier = true
        let target = target, before = cursor, client = client
        Task { [weak self] in
            defer { self?.loadingEarlier = false }
            guard let page = try? await client().subagentRecord(target, limit: 80, before: before)?.value, let self, target == self.target else { return }
            let known = Set(self.items.map(\.id))
            self.items = page.items.filter { !known.contains($0.id) } + self.items
            self.cursor = page.cursor
            self.more = page.more
        }
    }

    /// Where a step of its record is read whole.
    var source: RecordSource { RecordSource(harness: target.harness, session: target.session, agent: target.agent, client: client) }

    #if DEBUG
    /// The design preview's: a record from made-up work, without a service.
    func stage(agent: SubagentSummary, items: [RecordItem], usage: RecordUsage? = nil, others: [SubagentSummary] = [], folds: [String: Bool] = [:], more: Bool = false) {
        staged = true
        self.agent = agent
        if !agent.name.isEmpty { name = agent.name }
        if !agent.type.isEmpty { type = agent.type }
        self.items = items
        self.usage = usage
        self.others = others
        self.folds = folds
        self.more = more
        loaded = true
    }

    /// The design preview's: a card with no record to show.
    func stage(problem: String) {
        staged = true
        self.problem = problem
        loaded = true
    }
    #endif
}
