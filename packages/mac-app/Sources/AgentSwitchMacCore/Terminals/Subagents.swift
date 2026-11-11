import Foundation

// A session's sub-agents and what each did (docs/simple-view-v0.md §5.22, 2026-11-10; user: 当产生子代理的时候点击相关的条目，
// 我看不到子代理的对话内容，我希望也能查看，不过它可以用小视图而不是完整视图). Claude Code keeps a file of its own for each
// sub-agent a session sends off; the service lists them and reads one as a record — what it was sent to do, its work
// step by step, what it handed back. The Terminals page shows that record in a small card over the terminal's pane
// (`SubagentCard`); what the card says and when is decided here, without AppKit.

/// One sub-agent of a session, as the service lists it (`GET /sessions/:harness/:id/subagents`).
public struct SubagentSummary: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    /// Its kind (`Explore`, `general-purpose` …); "" where the agent did not say.
    public let type: String
    /// What it was sent to do; "" where the agent did not say.
    public let name: String
    /// When it began, and when it last wrote, in milliseconds (0: the service does not say).
    public let startedAt: Int64
    public let updatedAt: Int64
    /// It has ended, as the agent itself marks it.
    public let done: Bool

    public init(id: String, type: String = "", name: String = "", startedAt: Int64 = 0, updatedAt: Int64 = 0, done: Bool = false) {
        self.id = id
        self.type = type
        self.name = name
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.done = done
    }

    private enum CodingKeys: String, CodingKey { case id, type, name, startedAt, updatedAt, done }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        // A file's time in milliseconds may carry a fraction.
        startedAt = Int64(((try? c.decodeIfPresent(Double.self, forKey: .startedAt)) ?? 0).rounded())
        updatedAt = Int64(((try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0).rounded())
        done = (try? c.decodeIfPresent(Bool.self, forKey: .done)) ?? false
    }
}

/// One sub-agent's record (`GET /sessions/:harness/:id/subagents/:agent/record`): a session's record — the same
/// items, pages and usage — and what the list says of the sub-agent.
public struct SubagentRecord: Decodable, Sendable, Hashable {
    public let agent: SubagentSummary
    public let items: [RecordItem]
    /// There is more before `cursor`.
    public let more: Bool
    public let cursor: Int64
    public let rev: String
    public let usage: RecordUsage?

    public init(agent: SubagentSummary, items: [RecordItem], more: Bool = false, cursor: Int64 = 0, rev: String = "", usage: RecordUsage? = nil) {
        self.agent = agent
        self.items = items
        self.more = more
        self.cursor = cursor
        self.rev = rev
        self.usage = usage
    }

    private enum CodingKeys: String, CodingKey { case agent }

    public init(from decoder: Decoder) throws {
        // The record's own fields are a session record's, read the same way (an item of a kind a newer service added is
        // left out, not fatal).
        let record = try SessionRecord(from: decoder)
        agent = try decoder.container(keyedBy: CodingKeys.self).decode(SubagentSummary.self, forKey: .agent)
        items = record.items
        more = record.more
        cursor = record.cursor
        rev = record.rev
        usage = record.usage
    }
}

/// The sub-agent a card shows, and where its record is: the session it is of, on which agent.
public struct SubagentTarget: Sendable, Hashable {
    public let harness: String
    public let session: String
    public let agent: String

    public init(harness: String, session: String, agent: String) {
        self.harness = harness
        self.session = session
        self.agent = agent
    }
}

/// What the sub-agent card says (docs/simple-view-v0.md §5.22). Short English words in title case, sentences in
/// written Chinese (ui-v0 §7.2.7).
public enum SubagentDisplay {
    /// The agents whose sub-agents have a record of their own to open: Claude Code keeps a file for each. The others'
    /// (OpenCode's sub-sessions) are listed under their terminal and no more: a click on one shows its terminal.
    public static func hasRecords(_ harness: String) -> Bool { harness == "claude-code" }

    /// How a sub-agent stands, as far as anything says.
    public enum State: Equatable, Sendable {
        /// At work: its terminal lists it now, or it wrote a moment ago.
        case working
        /// Ended, as the agent marks it: what it handed back is its last answer.
        case done
        /// Neither: stopped short of its end (its turn interrupted, its terminal closed), or busy at one long step
        /// with nothing to say so. The card says when it last wrote, not what it does not know.
        case quiet
    }

    /// One not ended and not listed still counts as at work this long after it last wrote: its terminal forgets its
    /// sub-agents when the turn that sent them ends, and takes each in again with its next step.
    public static let fresh: TimeInterval = 30

    /// `live`: its terminal lists it among the sub-agents at work now. `terminalRuns`: its terminal's program runs.
    /// `updatedAt`: when it last wrote (nil before its record is read).
    public static func state(done: Bool, live: Bool, terminalRuns: Bool, updatedAt: Int64?, now: Date = Date()) -> State {
        if done { return .done }
        guard terminalRuns else { return .quiet }
        if live { return .working }
        guard let updatedAt, updatedAt > 0 else { return .working }
        return now.timeIntervalSince1970 * 1000 - Double(updatedAt) < fresh * 1000 ? .working : .quiet
    }

    /// The card's title: what it was sent to do, else its kind, else `Sub-Agent`.
    public static func title(name: String, type: String) -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines), type = type.trimmingCharacters(in: .whitespacesAndNewlines)
        // One the terminal took in by its kind is named by it: that is its kind, not what it was sent to do.
        if !name.isEmpty, name != type { return name }
        return type.isEmpty ? "Sub-Agent" : type
    }

    /// Its kind, where that says more than the title does (`Explore` beside `找登录入口`; not a second time).
    public static func kind(name: String, type: String) -> String? {
        let type = type.trimmingCharacters(in: .whitespacesAndNewlines)
        return type.isEmpty || title(name: name, type: type) == type ? nil : type
    }

    /// How long it worked, in seconds: from when it began to when it last wrote. Nil where the service gives no times.
    public static func seconds(startedAt: Int64, updatedAt: Int64) -> Int? {
        guard startedAt > 0, updatedAt >= startedAt else { return nil }
        return Int(((Double(updatedAt) - Double(startedAt)) / 1000).rounded())
    }

    /// What the head says of an ended one: `Done · 2m 05s`, or `Done` alone where there are no times.
    public static func doneWords(_ agent: SubagentSummary?) -> String {
        guard let agent, let took = seconds(startedAt: agent.startedAt, updatedAt: agent.updatedAt) else { return "Done" }
        return "Done · \(RecordDisplay.duration(took))"
    }

    /// One row of the card's menu: another of the session's sub-agents to look at.
    public struct Choice: Equatable, Sendable, Identifiable {
        public let id: String
        /// What it was sent to do and its kind, as the service or its terminal says them ("" where neither does).
        public let name: String
        public let type: String
        public let working: Bool
        public let done: Bool

        public init(id: String, name: String = "", type: String = "", working: Bool = false, done: Bool = false) {
            self.id = id
            self.name = name
            self.type = type
            self.working = working
            self.done = done
        }

        public var title: String { SubagentDisplay.title(name: name, type: type) }
        /// The row as the menu writes it: `找登录入口 · Explore`, with `Working` for one at work now.
        public var words: String { ([title] + (SubagentDisplay.kind(name: name, type: type).map { [$0] } ?? []) + (working ? ["Working"] : [])).joined(separator: " · ") }
    }

    /// The menu lists this many: the latest (a long session sends hundreds).
    public static let choicesShown = 24

    /// The session's sub-agents to choose between, in the order they began: the ones the service lists (`kept`), and
    /// any the terminal lists at work that the service has no file of yet (`live`; one just sent off). One at work is
    /// named as its terminal names it where the service gives it no name.
    public static func choices(kept: [SubagentSummary], live: [TerminalSubagent], shown: Int = choicesShown) -> [Choice] {
        let liveByID = Dictionary(live.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var out: [Choice] = kept.map { agent in
            let at = liveByID[agent.id]
            return Choice(id: agent.id, name: agent.name.isEmpty ? (at?.name ?? "") : agent.name, type: agent.type.isEmpty ? (at?.type ?? "") : agent.type,
                          working: at != nil && !agent.done, done: agent.done)
        }
        let known = Set(kept.map(\.id))
        out += live.filter { !known.contains($0.id) }.map { Choice(id: $0.id, name: $0.name, type: $0.type, working: true) }
        return Array(out.suffix(max(1, shown)))
    }

    /// How a run of work shows in the card: on its one line, with its latest steps under it, or with all of them.
    public enum Fold: Equatable, Sendable { case closed, tail, open }

    /// The run still going shows its latest steps without being asked — what the sub-agent is doing is what the card
    /// is opened for — and the others their one line; what the reader opened or closed themselves (`chosen`) stands.
    public static func fold(chosen: Bool?, running: Bool) -> Fold {
        if let chosen { return chosen ? .open : .closed }
        return running ? .tail : .closed
    }

    /// The latest steps a run still going shows.
    public static let tailSteps = 4

    /// The steps a run shows as it is folded, each with its place among all the run's steps (a step is asked for
    /// whole by that place), and how many earlier ones are not shown. What the agent thought on the way is not a step
    /// the card lists.
    public static func steps(_ steps: [RecordStep], fold: Fold, tail: Int = tailSteps) -> (hidden: Int, shown: [(index: Int, step: RecordStep)]) {
        let all = steps.enumerated().filter { $0.element.kind != .think }.map { (index: $0.offset, step: $0.element) }
        switch fold {
        case .closed: return (all.count, [])
        case .open: return (0, all)
        case .tail: return (max(0, all.count - tail), Array(all.suffix(max(1, tail))))
        }
    }

    /// A run's one line (`RecordDisplay.summary`) for a view narrow enough that it may take two: it breaks between
    /// its parts (` · `), never between a part's word and its number (`Agent` at a line's end, `1` on the next).
    public static func summaryLine(_ summary: String) -> String {
        summary.components(separatedBy: " · ").map { $0.replacingOccurrences(of: " ", with: "\u{a0}") }.joined(separator: " · ")
    }

    /// A long text's start, as the card shows it before `Show More`: what it was sent to do in a few lines, an answer
    /// in a screenful of the small view. Nil for one short enough to show whole.
    public static func taskPreview(_ text: String) -> String? { RecordDisplay.preview(text, fold: 420, keep: 300) }
    public static func answerPreview(_ text: String) -> String? { RecordDisplay.preview(text, fold: 1800, keep: 1200) }

    /// The card's size in a pane this large (docs/simple-view-v0.md §5.22): a small view by the pane's edge — at most
    /// `width` wide and, until it is asked to be tall, `height` high — and never larger than the pane less its margins.
    /// 400 wide: beside a record's reading column (`RecordLayout.column`) in a pane from about 1600 points, not over it.
    public static let width: Double = 400
    public static let height: Double = 320
    public static let margin: Double = 12

    public static func size(pane: (width: Double, height: Double), tall: Bool) -> (width: Double, height: Double) {
        let most = (width: max(0, pane.width - 2 * margin), height: max(0, pane.height - 2 * margin))
        return (min(width, most.width), tall ? most.height : min(height, most.height))
    }

    /// What the card says in place of a record it could not read, by why.
    public static let unsupported = "正在运行的服务版本较旧，无法读取子代理的记录。请更新 AgentSwitch。"
    public static let missing = "未找到这个子代理的记录。"
    public static let empty = "子代理尚未写下任何内容。"
    /// What the page says when a session's sub-agents are asked for and it sent none.
    public static let noneSent = "这段会话尚未派出子代理。"
}

extension DaemonClient {
    /// A session's sub-agents, in the order they began (`GET /sessions/:harness/:id/subagents`): none for an agent
    /// that keeps none. Throws as any call does — `notSupported` from a service that predates the route.
    public func sessionSubagents(harness: String, id: String) async throws -> [SubagentSummary] {
        struct Reply: Decodable { let subagents: [Lossy] }
        struct Lossy: Decodable {
            let value: SubagentSummary?
            init(from decoder: Decoder) throws { value = try? SubagentSummary(from: decoder) }
        }
        let data = try await call("GET", Self.subagentsPath(harness, id))
        // An entry that is not a sub-agent is left out, not fatal.
        return (try? JSONDecoder().decode(Reply.self, from: data))?.subagents.compactMap(\.value) ?? []
    }

    /// One sub-agent's record: its last `limit` items, or the ones before a page's `cursor`. Asked with the version of
    /// the record already held (`unless`), nil while the service still has that one — it reads nothing then, so a
    /// screen may ask every second while the sub-agent works.
    public func subagentRecord(_ target: SubagentTarget, limit: Int = 60, before: Int64? = nil, unless version: String? = nil) async throws -> Versioned<SubagentRecord>? {
        let path = "\(Self.subagentsPath(target.harness, target.session))/\(Self.segment(target.agent))/record?limit=\(limit)" + (before.map { "&before=\($0)" } ?? "")
        guard let answer = try await callUnlessUnchanged(path, version: before == nil ? version : nil) else { return nil }
        do { return Versioned(value: try JSONDecoder().decode(SubagentRecord.self, from: answer.value), version: answer.version) }
        catch { throw DaemonError.unreachable("子代理记录的格式不符：\(error)") }
    }

    /// The `n`-th step of a run of work of a sub-agent's, whole. Nil when the service has none.
    public func subagentStep(_ target: SubagentTarget, work: String, n: Int) async -> RecordStepDetail? {
        guard let data = try? await call("GET", "\(Self.subagentsPath(target.harness, target.session))/\(Self.segment(target.agent))/steps/\(Self.segment(work))/\(n)") else { return nil }
        return try? JSONDecoder().decode(RecordStepDetail.self, from: data)
    }

    /// A picture a step of a sub-agent's brought back: the `k`-th of the `n`-th step of the run of work `work`.
    public func subagentStepImage(_ target: SubagentTarget, work: String, n: Int, k: Int) async throws -> Data {
        try await call("GET", "\(Self.subagentsPath(target.harness, target.session))/\(Self.segment(target.agent))/steps/\(Self.segment(work))/\(n)/images/\(k)")
    }

    static func subagentsPath(_ harness: String, _ session: String) -> String {
        "/sessions/\(segment(harness))/\(segment(session))/subagents"
    }
}
