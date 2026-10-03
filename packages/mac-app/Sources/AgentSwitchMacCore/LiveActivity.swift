import Foundation

/// The Mac's Live Activity (assistant-v0 §4, docs/design/implemented/mac-live.html): `GET /live` as the daemon sends it —
/// the tasks in progress and the terminals waiting for you, the waiting first, and the tasks that ended in the last
/// minute. The daemon builds the titles and steps by the phone's rules; the Mac only draws them.
public struct LiveSnapshot: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Sendable { case task, terminal }

    /// What a row waits for, in a form the card can answer.
    public enum Ask: Equatable, Sendable {
        /// Allow or deny: a terminal's permission request or a task's approval. `target`: the command, file or page;
        /// `place`: the folder it works in.
        case decide(id: String, tool: String, target: String, place: String)
        /// A task's question: one of `options` answers it on the card when `answerable` (one question, one choice,
        /// nothing secret); else it is answered on the task's page.
        case question(id: String, questionId: String, text: String, options: [String], answerable: Bool)

        public var id: String {
            switch self {
            case .decide(let id, _, _, _), .question(let id, _, _, _, _): return id
            }
        }
    }

    public struct Row: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let kind: Kind
        public let title: String
        public let step: String
        /// The model at work (as people say it); a terminal's agent.
        public let model: String?
        /// A terminal's agent id (its pixel mark).
        public let agent: String?
        /// For the clock: when the task started, when the terminal asked.
        public let startedAt: Date
        public let needsYou: Bool
        public let ask: Ask?

        public init(id: String, kind: Kind, title: String, step: String, model: String? = nil, agent: String? = nil,
                    startedAt: Date, needsYou: Bool = false, ask: Ask? = nil) {
            self.id = id
            self.kind = kind
            self.title = title
            self.step = step
            self.model = model
            self.agent = agent
            self.startedAt = startedAt
            self.needsYou = needsYou
            self.ask = ask
        }

        private enum CodingKeys: String, CodingKey { case id, kind, title, step, model, agent, startedAt, needsYou, ask }
        private enum AskKeys: String, CodingKey { case kind, id, tool, target, `where`, questionId, text, options, answerable }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .task
            title = try c.decode(String.self, forKey: .title)
            step = try c.decodeIfPresent(String.self, forKey: .step) ?? ""
            model = try c.decodeIfPresent(String.self, forKey: .model)
            agent = try c.decodeIfPresent(String.self, forKey: .agent)
            startedAt = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .startedAt) / 1000)
            needsYou = try c.decodeIfPresent(Bool.self, forKey: .needsYou) ?? false
            if c.contains(.ask), try !c.decodeNil(forKey: .ask) {
                let a = try c.nestedContainer(keyedBy: AskKeys.self, forKey: .ask)
                let askID = try a.decode(String.self, forKey: .id)
                switch try a.decode(String.self, forKey: .kind) {
                case "question":
                    ask = .question(id: askID, questionId: try a.decodeIfPresent(String.self, forKey: .questionId) ?? "",
                                    text: try a.decodeIfPresent(String.self, forKey: .text) ?? "",
                                    options: try a.decodeIfPresent([String].self, forKey: .options) ?? [],
                                    answerable: try a.decodeIfPresent(Bool.self, forKey: .answerable) ?? false)
                default:
                    ask = .decide(id: askID, tool: try a.decodeIfPresent(String.self, forKey: .tool) ?? "",
                                  target: try a.decodeIfPresent(String.self, forKey: .target) ?? "",
                                  place: try a.decodeIfPresent(String.self, forKey: .where) ?? "")
                }
            } else {
                ask = nil
            }
        }
    }

    /// A result in the last minute: a task that ended, or a terminal's turn (assistant-v0 §4 "结果要提示"), and what it
    /// came to.
    public struct End: Decodable, Equatable, Sendable, Identifiable {
        public let kind: Kind
        /// The task's or the terminal's id.
        public let id: String
        public let title: String
        public let line: String
        public let ok: Bool
        public let at: Date
        /// One result: a terminal has one per turn.
        public var key: String { "\(kind.rawValue):\(id):\(Int(at.timeIntervalSince1970 * 1000))" }

        public init(kind: Kind = .task, id: String, title: String, line: String, ok: Bool, at: Date) {
            self.kind = kind
            self.id = id
            self.title = title
            self.line = line
            self.ok = ok
            self.at = at
        }

        public init(taskId: String, title: String, line: String, ok: Bool, at: Date) {
            self.init(kind: .task, id: taskId, title: title, line: line, ok: ok, at: at)
        }

        private enum CodingKeys: String, CodingKey { case kind, id, taskId, title, line, ok, at }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decodeIfPresent(Kind.self, forKey: .kind) ?? .task
            id = try c.decodeIfPresent(String.self, forKey: .id) ?? c.decode(String.self, forKey: .taskId)
            title = try c.decode(String.self, forKey: .title)
            line = try c.decodeIfPresent(String.self, forKey: .line) ?? ""
            ok = try c.decode(Bool.self, forKey: .ok)
            at = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .at) / 1000)
        }
    }

    /// Ordered: the waiting first, then the newest. The card shows the first `cardRows`.
    public let rows: [Row]
    public let running: Int
    public let waiting: Int
    /// The latest first.
    public let ended: [End]
    /// Terminals not exited, idle or not (the Mac stays awake while one is open); 0 from a service that does not say.
    public let open: Int
    /// The daemon's clock when it answered.
    public let now: Date

    public static let cardRows = 3

    public init(rows: [Row], ended: [End] = [], open: Int = 0, now: Date) {
        self.rows = rows
        waiting = rows.filter(\.needsYou).count
        running = rows.count - waiting
        self.ended = ended
        self.open = open
        self.now = now
    }

    private enum CodingKeys: String, CodingKey { case rows, running, waiting, ended, open, now }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rows = try c.decodeIfPresent([Row].self, forKey: .rows) ?? []
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? rows.filter { !$0.needsYou }.count
        waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? rows.filter(\.needsYou).count
        ended = try c.decodeIfPresent([End].self, forKey: .ended) ?? []
        open = try c.decodeIfPresent(Int.self, forKey: .open) ?? 0
        now = try c.decodeIfPresent(Double.self, forKey: .now).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date()
    }
}

/// When the capsule shows, what it says, and when the card under it opens and closes by itself: a new request drops it
/// (and sounds) and it stays until every request is answered; a result (a task that ended, a terminal's turn) drops it
/// for a few seconds unless a request waits (a request is never covered), with a tone; a failure stays — the capsule red —
/// until it has been looked at (assistant-v0 §4 "失败留到你看过"). A click on the capsule opens or closes it, a click
/// elsewhere closes it. What waits or has ended when the app starts is taken as known, as the phone does; the terminal
/// on screen in the main window's Terminals page says nothing of its own turns (you saw them), nor the task whose page is
/// open on its Dispatch page of its result (dispatch-v0 §1).
public struct LivePresenter: Equatable, Sendable {
    /// Who opened the card: a card the user opened stays open when its requests are answered.
    public enum Opener: Equatable, Sendable { case user, request, result }

    /// The tone for what just came: something needs you, a result, a failure.
    public enum Cue: Equatable, Sendable { case needsYou, done, failed }

    /// The app mark's look (busy, waiting, done, incomplete).
    public enum Look: Equatable, Sendable { case busy, waiting, done, incomplete }

    /// Right of the mark in the capsule: one row's clock (amber when it waits), how many wait and run, or the result.
    public enum Trail: Equatable, Sendable {
        case clock(since: Date, waiting: Bool)
        case tally(waiting: Int, running: Int)
        case result(ok: Bool)
    }

    /// How long a result stays on the card by itself.
    public static let resultShown: TimeInterval = 4
    /// An end first seen later than this after it happened (the app just started) does not drop the card.
    public static let freshEnd: TimeInterval = 10

    public private(set) var snapshot: LiveSnapshot?
    public private(set) var opener: Opener?
    /// The result on show by itself, until `flashUntil`.
    public private(set) var flash: LiveSnapshot.End?
    private var flashUntil: Date?
    /// Failures not looked at yet, the newest first: no minute's window takes them away.
    public private(set) var unseenFailures: [LiveSnapshot.End] = []
    private var seenAsks: Set<String> = []
    private var seenEnds: Set<String> = []
    private var started = false

    public init() {}

    public var isOpen: Bool { opener != nil }

    /// Something to show: work, a request, a result in the last minute, or a failure not looked at.
    public var visible: Bool {
        guard let s = snapshot else { return false }
        return !s.rows.isEmpty || !s.ended.isEmpty || !unseenFailures.isEmpty
    }

    /// The outcome the capsule and the card show: the result on show, else the latest failure not looked at (neither over
    /// a request), else the last end once nothing runs.
    public var shownEnd: LiveSnapshot.End? {
        guard let s = snapshot else { return nil }
        if let flash, s.waiting == 0 { return flash }
        if s.waiting == 0, let failure = unseenFailures.first { return failure }
        return s.rows.isEmpty ? s.ended.first : nil
    }

    /// The results on the card: the one on show, then the other failures not looked at; the first few, and how many more.
    public var cardEnds: [LiveSnapshot.End] { Array(allEnds.prefix(LiveSnapshot.cardRows)) }
    public var moreEnds: Int { max(0, allEnds.count - LiveSnapshot.cardRows) }
    private var allEnds: [LiveSnapshot.End] {
        guard let first = shownEnd else { return [] }
        return [first] + unseenFailures.filter { $0.key != first.key }
    }

    public var look: Look {
        if let end = shownEnd { return end.ok ? .done : .incomplete }
        return (snapshot?.waiting ?? 0) > 0 ? .waiting : .busy
    }

    public var trail: Trail? {
        if let end = shownEnd { return .result(ok: end.ok) }
        guard let s = snapshot, let first = s.rows.first else { return nil }
        return s.rows.count > 1 ? .tally(waiting: s.waiting, running: s.running) : .clock(since: first.startedAt, waiting: first.needsYou)
    }

    /// The card's rows (the first few) and how many more there are.
    public var cardRows: [LiveSnapshot.Row] { Array((snapshot?.rows ?? []).prefix(LiveSnapshot.cardRows)) }
    public var moreRows: Int { max(0, (snapshot?.rows.count ?? 0) - LiveSnapshot.cardRows) }

    /// A new answer from `GET /live` (nil: the service is not answering; everything goes). `watching`: the terminal on
    /// screen in the main window in use; `watchingTask`: the task whose page is open there. Returns the tone for what came
    /// (a request before a failure before a result).
    @discardableResult
    public mutating func receive(_ next: LiveSnapshot?, at now: Date, watching: String? = nil, watchingTask: String? = nil) -> Cue? {
        snapshot = next
        guard let next else {
            opener = nil
            flash = nil
            flashUntil = nil
            return nil
        }
        let asks = Set(next.rows.filter(\.needsYou).map(Self.askKey))
        let ends = next.ended.filter { !seenEnds.contains($0.key) }
        let fresh = asks.subtracting(seenAsks)
        seenAsks = asks
        seenEnds = Set(next.ended.map(\.key))
        let watched = { (end: LiveSnapshot.End) in
            (end.kind == .terminal && end.id == watching) || (end.kind == .task && end.id == watchingTask)
        }
        // Looking at the terminal (the task) is looking at its failures.
        unseenFailures.removeAll(where: watched)
        guard started else {
            started = true
            return nil
        }
        if !fresh.isEmpty, opener != .user { opener = .request }
        let news = ends.filter { next.now.timeIntervalSince($0.at) < Self.freshEnd && !watched($0) }
        for end in news.reversed() where !end.ok { unseenFailures.insert(end, at: 0) }
        if let end = news.first {
            flash = end
            flashUntil = now.addingTimeInterval(Self.resultShown)
            if opener == nil, next.waiting == 0 { opener = .result }
        }
        if next.waiting == 0, opener == .request { opener = nil }
        tick(now)
        if !fresh.isEmpty { return .needsYou }
        if news.contains(where: { !$0.ok }) { return .failed }
        return news.isEmpty ? nil : .done
    }

    /// Time passes: a result's few seconds end (and the card it opened closes).
    public mutating func tick(_ now: Date) {
        if let until = flashUntil, now >= until {
            flash = nil
            flashUntil = nil
            if opener == .result { opener = nil }
        }
        if !visible { opener = nil }
    }

    /// A click on the capsule: closing the card is having seen its failures.
    public mutating func toggle() {
        if opener != nil {
            unseenFailures = []
            opener = nil
        } else if visible {
            opener = .user
        }
    }

    /// A click elsewhere, or the thing it pointed at opened. A card the user opened was looked at; one that dropped by
    /// itself may not have been (a click in another app closes it too).
    public mutating func close() {
        if opener == .user { unseenFailures = [] }
        opener = nil
    }

    /// A result's task or terminal was opened: that failure has been seen.
    public mutating func opened(_ end: LiveSnapshot.End) {
        unseenFailures.removeAll { $0.kind == end.kind && $0.id == end.id }
    }

    /// One request per key: its id, or the waiting terminal (a form on its screen has no request id).
    static func askKey(_ row: LiveSnapshot.Row) -> String { row.ask?.id ?? "waiting:\(row.id)" }
}
