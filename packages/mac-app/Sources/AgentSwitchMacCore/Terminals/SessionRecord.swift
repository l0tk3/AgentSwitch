import Foundation

// A session's record for the simple view (docs/simple-view-v0.md §2, §4): what the user said, what the agent answered,
// and each run of work between two answers as its steps. The service reads it from what the agent itself writes as it
// goes; the phone has the same types in its Kit (packages share nothing but the service's API).

/// One thing the agent did in a run of work.
public struct RecordStep: Decodable, Sendable, Hashable {
    public enum Kind: String, Sendable {
        case read, search, list, run, edit, write, web, agent, todo, think, tool
    }

    /// A kind this app does not know is shown as a tool by its name.
    public let kind: Kind
    /// One line: the file, the command, the query, what a sub-agent was sent to do.
    public let text: String
    /// The tool's own name, for a step that is none of the kinds.
    public let tool: String?
    /// What the agent said the step is for, in its own words (Claude Code's description of a command).
    public let note: String?
    /// The end of what a command printed.
    public let out: String?
    public let failed: Bool
    public let added: Int?
    public let removed: Int?
    /// Pictures the step brought back (a picture file read, a screenshot taken): how many.
    public let images: Int

    public init(kind: Kind, text: String, tool: String? = nil, note: String? = nil, out: String? = nil, failed: Bool = false, added: Int? = nil, removed: Int? = nil,
                images: Int = 0) {
        self.images = max(0, images)
        self.kind = kind
        self.text = text
        self.tool = tool
        self.note = note
        self.out = out
        self.failed = failed
        self.added = added
        self.removed = removed
    }

    private enum CodingKeys: String, CodingKey { case kind, text, tool, note, out, failed, added, removed, images }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        images = max(0, (try? c.decodeIfPresent(Int.self, forKey: .images)) ?? 0)
        let raw = (try? c.decode(String.self, forKey: .kind)) ?? ""
        kind = Kind(rawValue: raw) ?? .tool
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? (Kind(rawValue: raw) == nil && !raw.isEmpty ? raw : nil)
        note = (try? c.decodeIfPresent(String.self, forKey: .note)).flatMap { $0.isEmpty ? nil : $0 }
        out = try? c.decodeIfPresent(String.self, forKey: .out)
        failed = (try? c.decodeIfPresent(Bool.self, forKey: .failed)) ?? false
        added = try? c.decodeIfPresent(Int.self, forKey: .added)
        removed = try? c.decodeIfPresent(Int.self, forKey: .removed)
    }
}

/// One item of the record, oldest first on the screen.
public struct RecordItem: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable {
        case user, answer, work, note
    }

    /// Where its first line begins in the agent's file: the same item keeps its id as the record grows.
    public let id: String
    public let kind: Kind
    public let at: Int64
    /// What was said (user, answer, note); empty for a run of work.
    public let text: String
    /// Pictures that came with a message of the user's.
    public let images: Int
    /// Typed while the agent worked, and not read by it yet.
    public let queued: Bool
    /// The service cut a very long text.
    public let clipped: Bool
    /// An answer that is what the agent thought on the way (where it wrote that down), not what it has to say to you.
    public let thinking: Bool
    /// A run of work: how long it took, and what it did.
    public let seconds: Int
    public let steps: [RecordStep]
    /// What an answer asks at its end, each with the answers it offers (Codex): taking one sends it as your reply.
    public let questions: [RecordQuestion]

    public var date: Date { Date(timeIntervalSince1970: TimeInterval(at) / 1000) }

    public init(id: String, kind: Kind, at: Int64 = 0, text: String = "", images: Int = 0, queued: Bool = false, clipped: Bool = false,
                thinking: Bool = false, seconds: Int = 0, steps: [RecordStep] = [], questions: [RecordQuestion] = []) {
        self.questions = questions
        self.thinking = thinking
        self.id = id
        self.kind = kind
        self.at = at
        self.text = text
        self.images = images
        self.queued = queued
        self.clipped = clipped
        self.seconds = seconds
        self.steps = steps
    }

    private enum CodingKeys: String, CodingKey { case id, type, ts, text, images, queued, clipped, thinking, secs, steps, questions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard let kind = Kind(rawValue: try c.decode(String.self, forKey: .type)) else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "an item this app does not know")
        }
        self.kind = kind
        at = Int64((try? c.decode(Double.self, forKey: .ts)) ?? 0)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        images = (try? c.decodeIfPresent(Int.self, forKey: .images)) ?? 0
        queued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)) ?? false
        clipped = (try? c.decodeIfPresent(Bool.self, forKey: .clipped)) ?? false
        thinking = (try? c.decodeIfPresent(Bool.self, forKey: .thinking)) ?? false
        seconds = (try? c.decodeIfPresent(Int.self, forKey: .secs)) ?? 0
        steps = (try? c.decodeIfPresent([RecordStep].self, forKey: .steps)) ?? []
        questions = (try? c.decodeIfPresent([RecordQuestion].self, forKey: .questions)) ?? []
    }

    /// Where it begins in the agent's file, when its id says (a record read coarsely numbers its items instead).
    public var offset: Int64? { Int64(id.split(separator: ".").first.map(String.init) ?? "") }
}

/// One entry of the agent's own task list.
public struct PlanEntry: Decodable, Sendable, Hashable {
    public enum State: String, Sendable, Decodable {
        case todo, doing, done
    }

    public let text: String
    public let state: State

    public init(text: String, state: State) {
        self.text = text
        self.state = state
    }

    private enum CodingKeys: String, CodingKey { case text, state }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        state = (try? c.decode(State.self, forKey: .state)) ?? .todo
    }
}

/// How full the agent's context is, and how hard it thought at the last turn.
public struct RecordUsage: Decodable, Sendable, Hashable {
    public let model: String?
    public let used: Int?
    public let window: Int?
    public let effort: String?

    public init(model: String? = nil, used: Int? = nil, window: Int? = nil, effort: String? = nil) {
        self.model = model
        self.used = used
        self.window = window
        self.effort = effort
    }
}

/// `GET /sessions/:harness/:id/record`.
public struct SessionRecord: Decodable, Sendable, Hashable {
    public let session: SessionSummary
    public let items: [RecordItem]
    /// There is more before `cursor`.
    public let more: Bool
    public let cursor: Int64
    public let rev: String
    public let plan: [PlanEntry]
    public let usage: RecordUsage?
    /// The permission mode the record last named, as the agent writes it.
    public let mode: String?

    public init(session: SessionSummary, items: [RecordItem], more: Bool = false, cursor: Int64 = 0, rev: String = "", plan: [PlanEntry] = [],
                usage: RecordUsage? = nil, mode: String? = nil) {
        self.session = session
        self.items = items
        self.more = more
        self.cursor = cursor
        self.rev = rev
        self.plan = plan
        self.usage = usage
        self.mode = mode
    }

    private enum CodingKeys: String, CodingKey { case session, items, more, cursor, rev, plan, usage, mode }

    /// An item of a kind a newer service added is left out, not fatal.
    private struct Lossy<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(SessionSummary.self, forKey: .session)
        items = try c.decode([Lossy<RecordItem>].self, forKey: .items).compactMap(\.value)
        more = (try? c.decode(Bool.self, forKey: .more)) ?? false
        cursor = Int64((try? c.decode(Double.self, forKey: .cursor)) ?? 0)
        rev = (try? c.decode(String.self, forKey: .rev)) ?? ""
        plan = (try? c.decode([Lossy<PlanEntry>].self, forKey: .plan).compactMap(\.value)) ?? []
        usage = try? c.decodeIfPresent(RecordUsage.self, forKey: .usage)
        mode = try? c.decodeIfPresent(String.self, forKey: .mode)
    }

    /// The latest page laid over what a screen holds: earlier pages it asked for stay, the page's own stretch is
    /// replaced (its last run of work may have grown, a queued message may have been read). Nothing earlier held, a gap
    /// between the two, or a record without places in a file: the page is the record.
    /// The record with the replies sent and not yet in it at its end, each as a message of yours — said `Queued`
    /// while the agent works (it has not taken it yet). One the items already hold is left out: the record's page and
    /// the service's word that it is there do not arrive together. Held: a message of yours no older than the reply
    /// (a moment's slack) that begins with the same words; one that went with files reads otherwise in the record, so
    /// for it the time decides.
    /// The questions still open at the record's end: those of its last answer, while nothing of yours comes after it
    /// (in the record, or sent and not there yet).
    public static func openQuestions(items: [RecordItem], sent: [SentReply]) -> [RecordQuestion] {
        guard sent.isEmpty, let last = items.last(where: { $0.kind == .user || $0.kind == .answer }), last.kind == .answer else { return [] }
        return last.questions.filter { !$0.options.isEmpty }
    }

    public static func withSent(items: [RecordItem], sent: [SentReply], working: Bool) -> [RecordItem] {
        guard !sent.isEmpty else { return items }
        let recent = items.suffix(12).filter { $0.kind == .user }
        let words = { (text: String) -> String in String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(24)) }
        let waiting = sent.filter { reply in
            !recent.contains { $0.at >= reply.at - 3000 && (reply.files > 0 || words($0.text) == words(reply.text)) }
        }
        return items + waiting.map { RecordItem(id: "sent-\($0.id)", kind: .user, at: $0.at, text: $0.text, queued: working) }
    }

    public static func merged(held: [RecordItem], page: [RecordItem]) -> (items: [RecordItem], replaced: Bool) {
        guard let first = page.first?.offset, let earliest = held.first?.offset, earliest < first,
              let last = held.last(where: { $0.offset != nil })?.offset, last >= first else { return (page, true) }
        return (held.filter { ($0.offset ?? .max) < first } + page, false)
    }
}

/// What a run of work, or the last turn, changed in one file.
public struct FileDiff: Decodable, Sendable, Hashable, Identifiable {
    public struct Hunk: Decodable, Sendable, Hashable {
        public let header: String
        /// Each with its mark first: `+` added, `-` taken away, a space unchanged.
        public let lines: [String]

        public init(header: String, lines: [String]) {
            self.header = header
            self.lines = lines
        }
    }

    public let path: String
    public let added: Int
    public let removed: Int
    public let hunks: [Hunk]
    public let clipped: Bool
    public var id: String { path }

    public init(path: String, added: Int, removed: Int, hunks: [Hunk], clipped: Bool = false) {
        self.path = path
        self.added = added
        self.removed = removed
        self.hunks = hunks
        self.clipped = clipped
    }

    private enum CodingKeys: String, CodingKey { case path, added, removed, hunks, clipped }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        added = (try? c.decode(Int.self, forKey: .added)) ?? 0
        removed = (try? c.decode(Int.self, forKey: .removed)) ?? 0
        hunks = (try? c.decode([Hunk].self, forKey: .hunks)) ?? []
        clipped = (try? c.decodeIfPresent(Bool.self, forKey: .clipped)) ?? false
    }
}

/// What the agent in a terminal is doing now: the tool, and what on.
public struct TerminalActivity: Decodable, Sendable, Hashable {
    public let tool: String
    public let target: String
    /// What the agent says this is for, in its own words; said in place of the command, as its own app does.
    public let note: String?

    public init(tool: String, target: String, note: String? = nil) {
        self.tool = tool
        self.target = target
        self.note = note
    }

    /// What is said after the tool's word: the agent's own sentence where it gave one, else what it works on.
    public var words: String { note.flatMap { $0.isEmpty ? nil : $0 } ?? target }
}

/// One step of a run of work, whole (`GET /sessions/:harness/:id/steps/:item/:n`): a command as it was written, its
/// lines kept, and all it printed — the record itself carries one line and the end of the output.
public struct RecordStepDetail: Decodable, Sendable, Hashable {
    public let text: String
    public let note: String?
    public let out: String?
    public let failed: Bool?
    /// Longer than is sent: the command's start, the output's end.
    public let clipped: Bool?

    public init(text: String, note: String? = nil, out: String? = nil, failed: Bool? = nil, clipped: Bool? = nil) {
        self.text = text
        self.note = note
        self.out = out
        self.failed = failed
        self.clipped = clipped
    }
}

/// A question at the end of an answer and the answers it offers.
public struct RecordQuestion: Decodable, Sendable, Hashable {
    public let title: String
    public let options: [String]

    public init(title: String, options: [String]) {
        self.title = title
        self.options = options
    }
}

/// A list the agent draws on its own screen and waits on (Codex's `/model`, a question whether to trust a folder):
/// its rows, and where the selection stands. Taking a row moves the selection there and enters it, as in the terminal.
public struct ScreenChoices: Decodable, Equatable, Sendable {
    public struct Option: Decodable, Equatable, Sendable {
        public let label: String
        public let detail: String?

        public init(label: String, detail: String? = nil) {
            self.label = label
            self.detail = detail
        }
    }

    public let title: String
    public let options: [Option]
    public let selected: Int

    public init(title: String, options: [Option], selected: Int) {
        self.title = title
        self.options = options
        self.selected = selected
    }
}

/// How far a turn has come, as the agent's own screen counts it (the service reads Claude Code's working line): the
/// tokens come from the model (`down`) or gone to it (`up`). Beside "Working": a number that moves says it is not stuck.
public struct TurnProgress: Decodable, Equatable, Sendable {
    public let tokens: Int
    public let way: String

    public init(tokens: Int, way: String = "down") {
        self.tokens = tokens
        self.way = way
    }
}

/// A reply a screen sent that the agent's record does not hold yet: the service keeps it, and it is shown at the
/// record's end meanwhile (the agent writes a message down only as its turn begins, and one sent while it works not
/// until it is taken).
public struct SentReply: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let text: String
    public let at: Int64
    /// Files that went with it (their places in its text read otherwise in the record).
    public let files: Int

    public init(id: String, text: String, at: Int64, files: Int = 0) {
        self.id = id
        self.text = text
        self.at = at
        self.files = files
    }

    private enum CodingKeys: String, CodingKey { case id, text, at, files }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.decode(String.self, forKey: .text)
        at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
        files = try c.decodeIfPresent(Int.self, forKey: .files) ?? 0
    }
}

/// What a terminal's record stream says besides the terminal's own events (`GET /terminals/:id/stream?view=record`).
public enum TerminalRecordEvent: Equatable, Sendable {
    /// How far the turn has come changed (nil: its screen says nothing now).
    case progress(TurnProgress?)
    /// The replies sent and not yet in the record changed.
    case sent([SentReply])
    /// The list its own screen shows to choose from changed (nil: none now).
    case choices(ScreenChoices?)
    /// What it is doing now changed.
    case activity(TerminalActivity?, [TerminalSubagent])
    /// Its session's record changed.
    case record(rev: String)
    /// The agent is on another model now.
    case model(String)
    /// It asks in another way now (its permission mode, in its own word).
    case mode(String)
    /// What it offers as your next message changed (nil: it offers none now).
    case suggestion(String?)
    /// Codex's Daybreak switch stands otherwise now.
    case daybreak(Bool)

    public static func decode(event: String, data: String) -> TerminalRecordEvent? {
        let bytes = Data(data.utf8)
        switch event {
        case "activity":
            struct Body: Decodable { let activity: TerminalActivity?; let subagents: [TerminalSubagent]? }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .activity($0.activity, $0.subagents ?? []) }
        case "record":
            struct Body: Decodable { let rev: String }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .record(rev: $0.rev) }
        case "model":
            struct Body: Decodable { let model: String }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .model($0.model) }
        case "mode":
            struct Body: Decodable { let mode: String }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .mode($0.mode) }
        case "suggestion":
            struct Body: Decodable { let text: String? }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .suggestion($0.text.flatMap { $0.isEmpty ? nil : $0 }) }
        case "daybreak":
            struct Body: Decodable { let on: Bool }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .daybreak($0.on) }
        case "progress":
            struct Body: Decodable { let progress: TurnProgress? }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .progress($0.progress) }
        case "sent":
            struct Body: Decodable { let replies: [SentReply] }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .sent($0.replies) }
        case "choices":
            struct Body: Decodable { let choices: ScreenChoices? }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .choices($0.choices) }
        default:
            return nil
        }
    }
}

/// How the simple view words a session's record (docs/simple-view-v0.md §2, §5): a run of work as one line, each step's
/// label, how full the context is, the mode. Short English words in title case (ui-v0 §7.2.7).
/// How a pane's simple view is laid out by its width (docs/simple-view-v0.md §5.2): one reading column, and beside it —
/// where there is room for both — a side for the task list and the changed files.
public enum RecordLayout {
    /// The reading column at its widest.
    public static let column: Double = 780
    /// The narrowest pane that has a side: the column stays readable next to it.
    public static let sideFrom: Double = 980

    /// The side's width in a pane this wide; nil for a pane too narrow to have one.
    public static func side(pane: Double) -> Double? {
        pane >= sideFrom ? min(max((pane * 0.3).rounded(), 300), 440) : nil
    }
}

/// A file some runs of work changed.
public struct RecordChangedFile: Sendable, Hashable, Identifiable {
    public let path: String
    public let added: Int
    public let removed: Int
    /// How many runs of work touched it, in what is loaded.
    public let runs: Int
    /// The latest of them (its item's id): its diff is the one shown.
    public let work: String
    public var id: String { path }
    /// The file's own name, and the folder it is in (empty at the top).
    public var name: String { (path as NSString).lastPathComponent }
    public var folder: String { (path as NSString).deletingLastPathComponent }

    public init(path: String, added: Int, removed: Int, runs: Int, work: String) {
        self.path = path
        self.added = added
        self.removed = removed
        self.runs = runs
        self.work = work
    }
}

public enum RecordDisplay {
    /// A run of work on one line: `Worked 1m 12s · Read 1 · Searched 1 · Ran 2 · Edited 1`, the kinds in the order they
    /// first came. Thinking and updates of the task list are not counted. `running`: it is the one still going.
    public static func summary(_ item: RecordItem, running: Bool = false) -> String {
        var counts: [(String, Int)] = []
        for step in item.steps {
            guard let word = counted(step.kind) else { continue }
            if let i = counts.firstIndex(where: { $0.0 == word }) { counts[i].1 += 1 } else { counts.append((word, 1)) }
        }
        let lead = running ? "Working" : "Worked"
        let head = item.seconds > 0 ? "\(lead) \(duration(item.seconds))" : lead
        return ([head] + counts.map { word, n in "\(n > 1 && (word == "Agent" || word == "Tool") ? word + "s" : word) \(n)" }).joined(separator: " · ")
    }

    private static func counted(_ kind: RecordStep.Kind) -> String? {
        switch kind {
        case .read: "Read"
        case .search: "Searched"
        case .list: "Listed"
        case .run: "Ran"
        case .edit, .write: "Edited"
        case .web: "Web"
        case .agent: "Agent"
        case .tool: "Tool"
        case .todo, .think: nil
        }
    }

    /// `8s`, `1m 12s`, `1h 03m`.
    public static func duration(_ seconds: Int) -> String {
        let s = max(0, seconds)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(String(format: "%02d", s % 60))s" }
        return "\(s / 3600)h \(String(format: "%02d", s % 3600 / 60))m"
    }

    /// A clock for what is going on now: `0:41`, `12:05`, `1:02:25`.
    /// The turn's tokens as its line says them: `↓ 250 tokens`, `↓ 1.3k tokens`, `↑ 12k tokens`. Nil for none.
    public static func turnTokens(_ progress: TurnProgress?) -> String? {
        guard let progress, progress.tokens > 0 else { return nil }
        let n = progress.tokens
        let count: String
        if n < 1000 { count = "\(n)" }
        else if n < 100_000 {
            let k = (Double(n) / 100).rounded() / 10
            count = k == k.rounded() ? "\(Int(k))k" : String(format: "%.1fk", k)
        } else if n < 1_000_000 { count = "\(Int((Double(n) / 1000).rounded()))k" }
        else {
            let m = (Double(n) / 100_000).rounded() / 10
            count = m == m.rounded() ? "\(Int(m))M" : String(format: "%.1fM", m)
        }
        return "\(progress.way == "up" ? "↑" : "↓") \(count) \(n == 1 ? "token" : "tokens")"
    }

    public static func clock(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return s < 3600 ? "\(s / 60):\(String(format: "%02d", s % 60))" : "\(s / 3600):\(String(format: "%02d", s % 3600 / 60)):\(String(format: "%02d", s % 60))"
    }

    /// Lines in and out over a run's steps; nil when it changed no file.
    public static func stat(_ steps: [RecordStep]) -> (added: Int, removed: Int)? {
        let added = steps.reduce(0) { $0 + ($1.added ?? 0) }, removed = steps.reduce(0) { $0 + ($1.removed ?? 0) }
        return steps.contains { $0.added != nil || $0.removed != nil } ? (added, removed) : nil
    }

    /// What a step is, before what it worked on: `Read`, `Run`, or the tool's own name.
    public static func label(_ step: RecordStep) -> String {
        switch step.kind {
        case .read: "Read"
        case .search: "Search"
        case .list: "List"
        case .run: "Run"
        case .edit: "Edit"
        case .write: "Write"
        case .web: "Web"
        case .agent: "Agent"
        case .todo: "Tasks"
        case .think: "Thought"
        case .tool: step.tool.map { $0.isEmpty ? "Tool" : $0 } ?? "Tool"
        }
    }

    /// A kind of step as a small picture before its line, in the classic look (the pixel look says it in its word): one
    /// picture, one kind (2026-10-07, user, of Codex's own app: 这种小图标…能不能加上). The system's symbol names.
    public static func symbol(_ kind: RecordStep.Kind) -> String {
        switch kind {
        case .read: "doc.text"
        case .search: "magnifyingglass"
        case .list: "folder"
        case .run: "terminal"
        case .edit: "pencil"
        case .write: "doc.badge.plus"
        case .web: "globe"
        case .agent: "arrow.triangle.branch"
        case .todo: "checklist"
        case .think: "sparkle"   // not a brain: it stood out of the line (2026-10-07, user: 这个脑子太突兀了)
        case .tool: "wrench.and.screwdriver"
        }
    }

    /// The picture for what the agent is doing now, by the tool it uses: the one a step of that kind has. None while
    /// it uses no tool — at work, and no more to say: the star that stood there read as another product's mark
    /// (2026-10-07, user: Work提示的星星图标去掉吧，看上去像是gemini，work这个动作就别加图标了).
    public static func toolSymbol(_ tool: String?) -> String? {
        guard let tool else { return nil }
        switch toolWord(tool) {
        case "Run": return symbol(.run)
        case "Read": return symbol(.read)
        case "Edit": return symbol(.edit)
        case "Search": return symbol(.search)
        case "Web": return symbol(.web)
        case "Agent": return symbol(.agent)
        case "Tasks": return symbol(.todo)
        case "Compact": return compactSymbol
        default: return symbol(.tool)
        }
    }

    /// It compacts its context (docs/simple-view-v0.md §5.7): two arrows meeting, for that alone.
    public static let compactSymbol = "arrow.down.right.and.arrow.up.left"

    /// A step that names a file (shown by the end of its path) rather than a command or a query.
    public static func namesFile(_ step: RecordStep) -> Bool { [.read, .edit, .write, .list].contains(step.kind) }

    /// The steps a run shows when opened: its thinking only in the verbose transcript.
    public static func shown(_ steps: [RecordStep], verbose: Bool) -> [RecordStep] {
        verbose ? steps : steps.filter { $0.kind != .think }
    }

    /// How full the context is: `62%` when the record says how much it holds, else the tokens in it (`238k`).
    public static func context(_ usage: RecordUsage?) -> String? {
        guard let used = usage?.used, used > 0 else { return nil }
        if let window = usage?.window, window > 0 { return "\(min(100, Int((Double(used) / Double(window) * 100).rounded())))%" }
        return used >= 1_000_000 ? String(format: "%.1fM", Double(used) / 1_000_000) : "\(max(1, Int((Double(used) / 1000).rounded())))k"
    }

    /// How full its context is, as a part and in words (`124k / 200k`); nil when the agent does not say how large it is.
    public static func contextMeter(_ usage: RecordUsage?) -> (part: Double, words: String)? {
        guard let used = usage?.used, used > 0, let window = usage?.window, window > 0 else { return nil }
        return (min(1, Double(used) / Double(window)), "\(tokens(used)) / \(tokens(window))")
    }

    private static func tokens(_ n: Int) -> String {
        n >= 1_000_000 ? (n % 1_000_000 == 0 ? "\(n / 1_000_000)M" : String(format: "%.1fM", Double(n) / 1_000_000)) : "\(max(1, Int((Double(n) / 1000).rounded())))k"
    }

    /// The files the runs of work in `items` changed, the latest touched first: each with its lines in and out summed
    /// over those runs (the Mac's side pane, docs/simple-view-v0.md §5.2). Only what is loaded of the record: an earlier
    /// page adds what it holds. A step that failed changed nothing.
    public static func changedFiles(_ items: [RecordItem]) -> [RecordChangedFile] {
        var order: [String] = []
        var files: [String: RecordChangedFile] = [:]
        for item in items where item.kind == .work {
            var touched = Set<String>()
            for step in item.steps where (step.kind == .edit || step.kind == .write) && !step.failed && !step.text.isEmpty {
                let held = files[step.text]
                files[step.text] = RecordChangedFile(path: step.text, added: (held?.added ?? 0) + (step.added ?? 0), removed: (held?.removed ?? 0) + (step.removed ?? 0),
                                                     runs: (held?.runs ?? 0) + (touched.contains(step.text) ? 0 : 1), work: item.id)
                touched.insert(step.text)
            }
            // The latest touched last in `order`.
            for path in touched { order.removeAll { $0 == path } }
            order.append(contentsOf: item.steps.map(\.text).filter { touched.contains($0) }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } })
        }
        return order.reversed().compactMap { files[$0] }
    }

    /// The agent's own word for how it asks, as the screens say it; nil for one this app does not know.
    public static func mode(_ raw: String?) -> String? {
        switch raw {
        case "default", "manual", "untrusted": "Ask"
        case "acceptEdits": "Edits"
        case "plan": "Plan"
        case "auto": "Auto"
        case "bypassPermissions", "bypass": "Bypass"
        case "dontAsk": "Don't Ask"
        case "on-request": "On Request"
        case "on-failure": "On Failure"
        case "never": "Never Ask"
        default: nil
        }
    }

    /// The task list on one line: how many are done, and the one in progress (else the next).
    public static func plan(_ plan: [PlanEntry]) -> (done: Int, total: Int, now: String)? {
        guard !plan.isEmpty else { return nil }
        let now = plan.first { $0.state == .doing } ?? plan.first { $0.state == .todo }
        return (plan.filter { $0.state == .done }.count, plan.count, now?.text ?? "")
    }

    /// Characters of a long answer shown before `Show More`, and how long one is before it is folded at all.
    public static let previewChars = 2400
    public static let foldChars = 3600

    /// The start of a long text, cut where a paragraph ends when one does near the limit, with a code fence left open
    /// by the cut closed; nil when the text is short enough to show whole.
    public static func preview(_ text: String, fold: Int = foldChars, keep: Int = previewChars) -> String? {
        guard text.count > fold else { return nil }
        var head = String(text.prefix(keep))
        if let cut = head.range(of: "\n\n", options: .backwards), head.distance(from: head.startIndex, to: cut.lowerBound) > keep / 2 {
            head = String(head[..<cut.lowerBound])
        } else if let cut = head.lastIndex(of: "\n"), head.distance(from: head.startIndex, to: cut) > keep / 2 {
            head = String(head[..<cut])
        }
        let fences = head.components(separatedBy: "\n").filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
        return fences % 2 == 1 ? head + "\n```" : head
    }

    /// The model a terminal is on, as far as anything says: what the agent last reported, else the model of its last
    /// answer in the record, else the one it was started with.
    public static func model(now: String?, record: String?, started: String?) -> String? { now ?? record ?? started }

    /// Which of the listed models is the one in use: by its id, else by the name people read (`opus` is listed for
    /// `claude-opus-5-5`, both read "Opus 5.5").
    public static func isCurrent(_ option: TerminalModelOption, model: String?) -> Bool {
        guard let model else { return false }
        return option.id == model || option.name == ModelName.display(model)
    }

    /// The agents whose model and level a screen can set at once: their own prompt takes a command that does (Claude
    /// Code's `/model <id>` and `/effort <level>`, pi's `/model <provider/id>` and `/thinking <level>`), or their own
    /// server does, the one the terminal's TUI is attached to (OpenCode's `POST /api/session/:id/model`, Codex's
    /// `thread/settings/update`). All four now; a terminal says itself when it cannot (`TerminalInfo.sets`: a Codex or
    /// an OpenCode started without its server).
    public static func setsDirectly(_ harness: String) -> Bool { ["claude-code", "pi", "opencode", "codex"].contains(harness) }

    /// Why the service did not make a change, in the page's words where it is one of the reasons it gives.
    public static func refusal(_ reason: String) -> String? {
        if reason.hasPrefix("no session yet") { return "它还没有会话：发出第一句话之后才能切换。" }
        if reason.hasPrefix("not a model of its") { return "它那边没有这个模型。" }
        if reason.hasPrefix("not a level of that model") || reason.hasPrefix("that model takes no level") { return "这个模型没有这一档。" }
        if reason.hasPrefix("its server is not running") || reason.hasPrefix("this agent chooses") { return "这个终端现在不能从这里切换：切到终端视图操作。" }
        return nil
    }

    /// Why the model, the level or the way of asking cannot be changed from here now; nil when it can. A control that
    /// cannot change anything is not one to press (2026-10-07, user: 不能切换的话就让他点不动): it is said as plain words,
    /// with this for whoever rests the pointer on it.
    public static func locked(harness: String, status: String?, waiting: Bool, whileWorking: Bool = false, sets: Bool? = nil) -> String? {
        if status == "exited" { return "终端已结束。" }
        // What the terminal says of itself first (it knows whether its agent's server is there); else by its kind.
        if !(sets ?? setsDirectly(harness)) { return harness == "codex" ? "在回复框里用 /model 切换（Codex 在它自己的列表里选模型和思考强度）。" : "\(agentName(harness)) 的这个终端只能在它自己的界面里选：切到终端视图操作。" }
        if waiting || status == "waiting" { return "它正在等待回答，回答后再调整。" }
        if status != "idle", !whileWorking { return "它正在工作，结束后再调整。" }
        return nil
    }

    private static func agentName(_ harness: String) -> String {
        switch harness {
        case "claude-code": "Claude Code"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "pi": "pi"
        default: harness
        }
    }

    /// The command that opens an agent's own model picker, typed for the user who then chooses on its screen; and its
    /// own picker for the thinking level, where it has one apart from that.
    public static func modelPicker(_ harness: String) -> String { harness == "opencode" ? "/models" : "/model" }

    /// Claude Code's ways of asking, in its own words, as the menu lists them: asking each time first, skipping every
    /// permission last.
    public static let claudeModes = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]

    /// The way of asking that lets everything through: said in the colour of a warning wherever it is said.
    public static func skipsPermissions(_ raw: String?) -> Bool { raw == "bypassPermissions" || raw == "bypass" }

    /// How a terminal asks, as far as anything says: what the agent last reported or its screen showed, the mode its
    /// record last named, the one it was started with.
    public static func modeNow(now: String?, record: String?, started: String?) -> String? { now ?? record ?? started }
    public static func effortPicker(_ harness: String) -> String? { harness == "opencode" ? "/variants" : nil }

    /// The tool it is using, in one short word (the phone's island says the same).
    public static func toolWord(_ tool: String) -> String {
        switch tool.lowercased() {
        case "bash", "shell", "commandexecution", "exec_command", "local_shell": "Run"
        case "read", "view", "notebookread": "Read"
        case "write", "edit", "multiedit", "filechange", "apply_patch", "patch", "notebookedit": "Edit"
        case "grep", "glob", "search", "ls", "list": "Search"
        case "webfetch", "websearch", "web_search": "Web"
        case "agent", "task": "Agent"
        case "todowrite": "Tasks"
        case "compact": "Compact"   // not a tool: the agent compacts its context
        default: tool.hasPrefix("mcp__") ? (tool.split(separator: "_").filter { !$0.isEmpty }.dropFirst().first.map { String($0).capitalized } ?? "Tool") : tool
        }
    }
}

extension DaemonClient {
    /// A session's record: the last `limit` items, or the ones before a page's `cursor` (`GET /sessions/:h/:id/record`).
    public func sessionRecord(harness: String, id: String, limit: Int = 60, before: Int64? = nil) async throws -> SessionRecord {
        let query = "?limit=\(limit)" + (before.map { "&before=\($0)" } ?? "")
        let data = try await call("GET", "/sessions/\(Self.segment(harness))/\(Self.segment(id))/record\(query)")
        do { return try JSONDecoder().decode(SessionRecord.self, from: data) } catch { throw DaemonError.unreachable("会话记录的格式不符：\(error)") }
    }

    /// What a session changed, file by file: in one run of work (`work`, the item's id), else in its last turn. None
    /// when the service has no changes for it (an agent read coarsely).
    public func sessionChanges(harness: String, id: String, work: String? = nil) async throws -> [FileDiff] {
        struct Reply: Decodable { let files: [FileDiff] }
        let query = work.map { "?work=\(Self.segment($0))" } ?? ""
        guard let data = try? await call("GET", "/sessions/\(Self.segment(harness))/\(Self.segment(id))/changes\(query)") else { return [] }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.files ?? []
    }

    /// A reply typed as it is and entered, as the keyboard would (`POST /terminals/:id/input`, not sealed): the simple
    /// view's reply box. The sealed reply (`replyToTerminal`) is the lock's.
    /// `files`: each where its placeholder stands in `text` (docs/terminal-v0.md §4).
    public func typeIntoTerminal(id: String, text: String, files: [TerminalReplyFile] = []) async throws {
        struct Body: Encodable { let text: String; let seal = false; let attachments: [TerminalReplyFile] }
        _ = try await call("POST", "/terminals/\(Self.segment(id))/input", body: try JSONEncoder().encode(Body(text: text, attachments: files)))
    }

    /// The `n`-th step of the run of work `work`, whole. Nil when the service has none (an agent read coarsely, an older
    /// service): the record's own line stays.
    public func sessionStep(harness: String, id: String, work: String, n: Int) async -> RecordStepDetail? {
        guard let data = try? await call("GET", "/sessions/\(Self.segment(harness))/\(Self.segment(id))/steps/\(Self.segment(work))/\(n)") else { return nil }
        return try? JSONDecoder().decode(RecordStepDetail.self, from: data)
    }

    /// A picture the user sent with a message: the `n`-th of the record's item `item`, as the agent kept it.
    public func sessionImage(harness: String, id: String, item: String, n: Int) async throws -> Data {
        try await call("GET", "/sessions/\(Self.segment(harness))/\(Self.segment(id))/images/\(Self.segment(item))/\(n)")
    }

    /// A picture a step brought back: the `k`-th of the `n`-th step of the run of work `work`.
    public func sessionStepImage(harness: String, id: String, work: String, n: Int, k: Int) async throws -> Data {
        try await call("GET", "/sessions/\(Self.segment(harness))/\(Self.segment(id))/steps/\(Self.segment(work))/\(n)/images/\(k)")
    }

    /// Another model, or another thinking level, for the Claude Code in a terminal (docs/simple-view-v0.md §5.4).
    public func setTerminalModel(id: String, model: String) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/model", body: try JSONEncoder().encode(["model": model]))
    }

    /// Another way of asking for the Claude Code in a terminal: the service presses its ⇧Tab until its screen names
    /// the mode (docs/simple-view-v0.md §5.4). The mode it is in afterwards.
    @discardableResult
    public func setTerminalMode(id: String, mode: String) async throws -> String {
        struct Reply: Decodable { let mode: String }
        let data = try await call("POST", "/terminals/\(Self.segment(id))/mode", body: try JSONEncoder().encode(["mode": mode]))
        return (try? JSONDecoder().decode(Reply.self, from: data))?.mode ?? mode
    }

    /// Codex's Daybreak switch turned for the session a terminal is on: the service types Codex's own command when
    /// the switch stands otherwise, and waits until Codex says so (docs/simple-view-v0.md §5.8). How it stands after.
    @discardableResult
    /// Takes row `pick` of the list the agent's own screen shows (it must still read `label` there).
    public func chooseOnTerminal(id: String, pick: Int, label: String) async throws {
        struct Body: Encodable { let pick: Int; let label: String }
        _ = try await call("POST", "/terminals/\(Self.segment(id))/choices", body: try JSONEncoder().encode(Body(pick: pick, label: label)))
    }

    public func setTerminalDaybreak(id: String, on: Bool) async throws -> Bool {
        struct Reply: Decodable { let on: Bool }
        let data = try await call("POST", "/terminals/\(Self.segment(id))/daybreak", body: try JSONEncoder().encode(["on": on]))
        return (try? JSONDecoder().decode(Reply.self, from: data))?.on ?? on
    }

    public func setTerminalEffort(id: String, effort: String) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/effort", body: try JSONEncoder().encode(["effort": effort]))
    }

    /// A terminal's stream for a screen that shows its record, not the terminal: no screen content, and what the agent
    /// is doing and when its record changed besides the terminal's own events (status, requests, exit). Each frame as
    /// its event's name and its data; it reconnects by itself and ends when the terminal is gone.
    public func recordEvents(id: String, policy: DispatchReconnectPolicy = .standard) -> AsyncStream<(event: String, data: String)> {
        let streamer = (transport as? DispatchStreamingTransport) ?? URLSessionStreamTransport.shared
        let client = self
        let (stream, sink) = AsyncStream<(event: String, data: String)>.makeStream()
        let worker = Task {
            var failures = 0
            while !Task.isCancelled {
                var delivered = false
                do {
                    let route = "/terminals/\(Self.segment(id))/stream?view=record"
                    let request = try client.dispatchRequest("GET", route, accept: "text/event-stream", timeout: policy.idleTimeout)
                    let (response, body) = try await streamer.stream(request)
                    if response.statusCode == 404 { sink.yield(("removed", "{}")); break }
                    guard (200..<300).contains(response.statusCode) else { throw DaemonError.unreachable("HTTP \(response.statusCode)") }
                    var parser = SSEParser()
                    for try await chunk in Self.idleGuarded(body, limit: .milliseconds(Int64(policy.idleTimeout * 1000))) {
                        for message in parser.feed(chunk) {
                            delivered = true
                            sink.yield(message)
                            if message.event == "removed" { sink.finish(); return }
                        }
                    }
                } catch is CancellationError {
                    break
                } catch {
                    // The service is away (restarting): the stream comes back by itself.
                }
                failures = delivered ? 0 : failures + 1
                try? await Task.sleep(for: policy.delay(afterFailures: max(failures, 1)))
            }
            sink.finish()
        }
        sink.onTermination = { _ in worker.cancel() }
        return stream
    }
}
