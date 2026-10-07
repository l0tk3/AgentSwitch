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
    /// The service cut a very long text.
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

    public init(tool: String, target: String) {
        self.tool = tool
        self.target = target
    }
}

/// What a terminal's record stream says besides the terminal's own events (`GET /terminals/:id/stream?view=record`).
public enum TerminalRecordEvent: Equatable, Sendable {
    /// What it is doing now changed.
    case activity(TerminalActivity?, [TerminalSubagent])
    /// Its session's record changed.
    case record(rev: String)
    /// The agent is on another model now.
    case model(String)

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
        default:
            return nil
        }
    }
}

/// How the simple view words a session's record (docs/simple-view-v0.md §2, §5): a run of work as one line, each step's
/// label, how full the context is, the mode. Short English words in title case (ui-v0 §7.2.7).
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

    /// A picture the user sent with a message: the `n`-th of the record's item `item`, as the agent kept it.
    public func sessionImage(harness: String, id: String, item: String, n: Int) async throws -> Data {
        try await call("GET", "/sessions/\(Self.segment(harness))/\(Self.segment(id))/images/\(Self.segment(item))/\(n)")
    }

    /// Another model, or another thinking level, for the Claude Code in a terminal (docs/simple-view-v0.md §5.4).
    public func setTerminalModel(id: String, model: String) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/model", body: try JSONEncoder().encode(["model": model]))
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
