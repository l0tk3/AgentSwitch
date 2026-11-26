import Foundation

// A session's record for the simple view (docs/simple-view-v0.md §2): what the user said, what the agent answered, and
// each run of work between two answers as its steps. The Mac reads it from what the agent itself writes as it goes.

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

/// What the agent's own screen said to a command sent from a screen (`/daybreak` → `Daybreak off. Applies to new
/// turns.`): it is in no record, so the service reads it off the screen.
public struct ScreenNotice: Decodable, Hashable, Sendable {
    public let id: String
    public let text: String
    public let at: Int64

    public init(id: String, text: String, at: Int64) {
        self.id = id
        self.text = text
        self.at = at
    }

    /// The record with these, each a note where its time puts it.
    public static func placed(in items: [RecordItem], notices: [ScreenNotice]) -> [RecordItem] {
        guard !notices.isEmpty else { return items }
        var out = items
        for notice in notices {
            let note = RecordItem(id: "notice-\(notice.id)", kind: .note, at: notice.at, text: notice.text)
            // Older than all of it (a record begun after it, as by `/clear`): first, not last (2026-10-14).
            let index = out.lastIndex { $0.at <= notice.at }.map { $0 + 1 } ?? 0
            out.insert(note, at: index)
        }
        return out
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

    /// The questions still open at the record's end: those of its last answer, while nothing of yours comes after it
    /// (in the record, or sent and not there yet).
    public static func open(items: [RecordItem], sent: [SentReply]) -> [RecordQuestion] {
        guard sent.isEmpty, let last = items.last(where: { $0.kind == .user || $0.kind == .answer }), last.kind == .answer else { return [] }
        return last.questions.filter { !$0.options.isEmpty }
    }
}

/// A file an answer points at (docs/simple-view-v0.md §5.16): its whole path on the node, and what kind of thing it is
/// in the agent's word (`workbook`, `document`…) when it says.
public struct RecordFile: Decodable, Sendable, Hashable, Identifiable {
    public let path: String
    public let kind: String?

    public init(path: String, kind: String? = nil) {
        self.path = path
        self.kind = kind
    }

    public var id: String { path }
    public var name: String { (path as NSString).lastPathComponent }
    /// Its folder, for a Files browser to open at.
    public var folder: String { (path as NSString).deletingLastPathComponent }

    /// The kind as a word on the screen (`Workbook`), from the agent's (`workbook`, `source_code`); none, nothing.
    public var kindWord: String? {
        guard let kind, !kind.isEmpty else { return nil }
        return kind.split(whereSeparator: { $0 == "_" || $0 == "-" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}

/// A list the agent draws on its own screen and waits on (Codex's `/model`, a question whether to trust a folder):
/// its rows, and where the selection stands. Taking a row moves the selection there and enters it, as in the terminal.
public struct ScreenChoices: Decodable, Hashable, Sendable {
    public struct Option: Decodable, Hashable, Sendable {
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
    /// All its screen says above the rows, a paragraph a line (a folder's question is several); nil when the title is
    /// all of it, and from a Mac that does not say.
    public let text: String?

    public init(title: String, options: [Option], selected: Int, text: String? = nil) {
        self.title = title
        self.options = options
        self.selected = selected
        self.text = text
    }

    /// One line of what the list's card says over its rows; `asks`: the one that is the question.
    public struct Line: Hashable, Sendable, Identifiable {
        public let id: Int
        public let text: String
        public let asks: Bool

        public init(id: Int, text: String, asks: Bool) {
            self.id = id
            self.text = text
            self.asks = asks
        }
    }

    /// What the card says over the rows: the screen's own lines with the question marked among them, or the title
    /// alone. Lines that say nothing are left out; when none of them is the title, the first stands for it.
    public var said: [Line] { Self.said(title: title, text: text) }

    public static func said(title: String, text: String?) -> [Line] {
        let lines = (text ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !lines.isEmpty else { return title.isEmpty ? [] : [Line(id: 0, text: title, asks: true)] }
        let asks = lines.firstIndex(of: title) ?? 0
        return lines.enumerated().map { Line(id: $0.offset, text: $0.element, asks: $0.offset == asks) }
    }
}

/// How far a turn has come, as the agent's own screen counts it (the service reads Claude Code's working line): the
/// tokens come from the model (`down`) or gone to it (`up`). Beside "Working": a number that moves says it is not stuck.
public struct TurnProgress: Decodable, Hashable, Sendable {
    public let tokens: Int
    public let way: String

    public init(tokens: Int, way: String = "down") {
        self.tokens = tokens
        self.way = way
    }

    private enum CodingKeys: String, CodingKey { case tokens, way }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokens = try c.decode(Int.self, forKey: .tokens)
        way = try c.decodeIfPresent(String.self, forKey: .way) ?? "down"
    }
}

/// A reply a screen sent that the agent's record does not hold yet: the service keeps it, and it is shown at the
/// record's end meanwhile (the agent writes a message down only as its turn begins, and one sent while it works not
/// until it is taken).
public struct SentReply: Decodable, Hashable, Sendable, Identifiable {
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

    /// The record with the replies sent and not yet in it at its end, each as a message of yours — said `Queued`
    /// while the agent works (it has not taken it yet). One the items already hold is left out: the record's page and
    /// the service's word that it is there do not arrive together. Held: a message of yours no older than the reply
    /// (a moment's slack) that begins with the same words; one that went with files reads otherwise in the record, so
    /// for it the time decides.
    public static func appended(to items: [RecordItem], sent: [SentReply], working: Bool) -> [RecordItem] {
        guard !sent.isEmpty else { return items }
        // Another session's message is not one of yours, whenever it came.
        let recent = items.suffix(12).filter { $0.kind == .user && $0.from == nil }
        let words = { (text: String) -> String in String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(24)) }
        let waiting = sent.filter { reply in
            !recent.contains { $0.at >= reply.at - 3000 && (reply.files > 0 || words($0.text) == words(reply.text)) }
        }
        return items + waiting.map { RecordItem(id: "sent-\($0.id)", kind: .user, at: $0.at, text: $0.text, queued: working) }
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
    /// Sent by another session, not typed by you: the name it gave ("" when it gave none); nil for yours.
    public let from: String?
    /// The Mac cut a very long text.
    public let clipped: Bool
    /// An answer that is what the agent thought on the way (where it wrote that down), not what it has to say to you.
    public let thinking: Bool
    /// A run of work: how long it took, and what it did.
    public let seconds: Int
    public let steps: [RecordStep]
    /// What an answer asks at its end, each with the answers it offers (Codex): taking one sends it as your reply.
    public let questions: [RecordQuestion]
    /// The files an answer points at (Codex's file citations, taken out of its text): each shown as a file to open.
    public let files: [RecordFile]

    public var date: Date { Date(timeIntervalSince1970: TimeInterval(at) / 1000) }

    public init(id: String, kind: Kind, at: Int64 = 0, text: String = "", images: Int = 0, queued: Bool = false, clipped: Bool = false,
                thinking: Bool = false, seconds: Int = 0, steps: [RecordStep] = [], questions: [RecordQuestion] = [], files: [RecordFile] = [], from: String? = nil) {
        self.files = files
        self.from = from
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

    private enum CodingKeys: String, CodingKey { case id, type, ts, text, images, queued, clipped, thinking, secs, steps, questions, files, from }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard let kind = Kind(rawValue: try c.decode(String.self, forKey: .type)) else {
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "an item this app does not know")
        }
        self.kind = kind
        // A file's time may carry a fraction of a millisecond.
        at = Int64((try? c.decode(Double.self, forKey: .ts)) ?? 0)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        images = (try? c.decodeIfPresent(Int.self, forKey: .images)) ?? 0
        queued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)) ?? false
        from = try? c.decodeIfPresent(String.self, forKey: .from)
        clipped = (try? c.decodeIfPresent(Bool.self, forKey: .clipped)) ?? false
        thinking = (try? c.decodeIfPresent(Bool.self, forKey: .thinking)) ?? false
        seconds = (try? c.decodeIfPresent(Int.self, forKey: .secs)) ?? 0
        steps = (try? c.decodeIfPresent([RecordStep].self, forKey: .steps)) ?? []
        questions = (try? c.decodeIfPresent([RecordQuestion].self, forKey: .questions)) ?? []
        files = (try? c.decodeIfPresent([RecordFile].self, forKey: .files)) ?? []
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

/// How full the agent's context is: tokens in it at the last turn, and how many it holds when the record says.
public struct RecordUsage: Decodable, Sendable, Hashable {
    public let model: String?
    public let used: Int?
    public let window: Int?
    /// How hard it thought at the last turn, in the agent's word (Claude Code, Codex).
    public let effort: String?
    /// The account's allowances as the record said last (Codex's rate limits), the shorter window first.
    public let limits: [UsageLimit]?

    public init(model: String? = nil, used: Int? = nil, window: Int? = nil, effort: String? = nil, limits: [UsageLimit]? = nil) {
        self.model = model
        self.used = used
        self.window = window
        self.effort = effort
        self.limits = limits
    }
}

/// One of the account's allowances (docs/simple-view-v0.md §5.25): its window's name (`5h`, `7d`), how much of it is
/// used, and when it starts afresh (ms since 1970; nil: not said).
public struct UsageLimit: Decodable, Sendable, Hashable {
    public let label: String
    public let percent: Double
    public let resetsAt: Int64?

    public init(label: String, percent: Double, resetsAt: Int64? = nil) {
        self.label = label
        self.percent = percent
        self.resetsAt = resetsAt
    }
}

/// How full a terminal's context and the account's allowances are, as the agent's status line said last (Claude Code,
/// Antigravity; `TerminalInfo.meter`, the record stream's `meter`).
public struct TerminalMeter: Decodable, Sendable, Hashable {
    public struct Context: Decodable, Sendable, Hashable {
        public let percent: Double
        public let used: Int?
        public let window: Int?
        public init(percent: Double, used: Int? = nil, window: Int? = nil) { self.percent = percent; self.used = used; self.window = window }
    }
    public let context: Context?
    public let limits: [UsageLimit]

    public init(context: Context?, limits: [UsageLimit] = []) { self.context = context; self.limits = limits }

    private enum CodingKeys: String, CodingKey { case context, limits }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        context = (try? c.decodeIfPresent(Context.self, forKey: .context)) ?? nil
        limits = (try? c.decodeIfPresent([UsageLimit].self, forKey: .limits)) ?? []
    }
}

/// The line under the reply box (docs/simple-view-v0.md §5.25): how full the context is and the allowances.
public struct UsageLine: Equatable, Sendable {
    public struct Limit: Equatable, Sendable {
        public let text: String
        /// Near its end (80% and over): drawn in the colour of what needs you.
        public let near: Bool
        /// When it starts afresh, in words (`Resets in 2h 1m`); nil: not said.
        public let help: String?
        public init(text: String, near: Bool, help: String?) { self.text = text; self.near = near; self.help = help }
    }
    /// How full the context is (`28%`, or the tokens in it where its size is not known); nil: not said.
    public let context: String?
    /// How full in tokens (`280k / 1M`); nil where not known.
    public let contextHelp: String?
    public let limits: [Limit]
    public var isEmpty: Bool { context == nil && limits.isEmpty }
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

    /// An item of a kind a newer Mac added is left out, not fatal.
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

    /// A Mac from before the record route still gives the session's messages: the same record, one line per tool.
    public init(coarse detail: SessionDetail) {
        var items: [RecordItem] = []
        var steps: [RecordStep] = []
        var began: Int64 = 0
        var n = 0
        func close() {
            guard !steps.isEmpty else { return }
            items.append(RecordItem(id: "m\(n)", kind: .work, at: began, steps: steps))
            n += 1
            steps = []
        }
        for m in detail.messages {
            switch m.role {
            case .user, .assistant:
                close()
                items.append(RecordItem(id: "m\(n)", kind: m.role == .user ? .user : .answer, at: m.ts, text: m.text))
                n += 1
            case .tool, .other:
                if steps.isEmpty { began = m.ts }
                steps.append(RecordStep(kind: RecordDisplay.coarseKind(m.tool ?? ""), text: MessageDisplay.readable(m.text).split(separator: "\n").first.map(String.init) ?? "", tool: m.tool))
            }
        }
        close()
        self.init(session: detail.session, items: items, rev: "u\(detail.session.updatedAt)")
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
    /// The Mac cut a very long change.
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

struct FileDiffList: Decodable {
    let files: [FileDiff]
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
