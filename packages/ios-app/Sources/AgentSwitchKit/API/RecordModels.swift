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
    /// The end of what a command printed.
    public let out: String?
    public let failed: Bool
    public let added: Int?
    public let removed: Int?

    public init(kind: Kind, text: String, tool: String? = nil, out: String? = nil, failed: Bool = false, added: Int? = nil, removed: Int? = nil) {
        self.kind = kind
        self.text = text
        self.tool = tool
        self.out = out
        self.failed = failed
        self.added = added
        self.removed = removed
    }

    private enum CodingKeys: String, CodingKey { case kind, text, tool, out, failed, added, removed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode(String.self, forKey: .kind)) ?? ""
        kind = Kind(rawValue: raw) ?? .tool
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? (Kind(rawValue: raw) == nil && !raw.isEmpty ? raw : nil)
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
    /// The Mac cut a very long text.
    public let clipped: Bool
    /// A run of work: how long it took, and what it did.
    public let seconds: Int
    public let steps: [RecordStep]

    public var date: Date { Date(timeIntervalSince1970: TimeInterval(at) / 1000) }

    public init(id: String, kind: Kind, at: Int64 = 0, text: String = "", images: Int = 0, queued: Bool = false, clipped: Bool = false,
                seconds: Int = 0, steps: [RecordStep] = []) {
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

    private enum CodingKeys: String, CodingKey { case id, type, ts, text, images, queued, clipped, secs, steps }

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
        clipped = (try? c.decodeIfPresent(Bool.self, forKey: .clipped)) ?? false
        seconds = (try? c.decodeIfPresent(Int.self, forKey: .secs)) ?? 0
        steps = (try? c.decodeIfPresent([RecordStep].self, forKey: .steps)) ?? []
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
