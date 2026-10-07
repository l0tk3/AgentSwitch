import Foundation

// The terminal list as the service gives it (docs/terminal-v0.md §4), for the native Terminals page: earlier sessions,
// the agents and their models, and the requests that start or continue a terminal. The same shapes as the iPhone's
// (its TerminalModels.swift and SessionModels.swift), in this package: packages share nothing but the service.

/// A coding session on the Mac, outside AgentSwitch (control-v0 §3): Claude Code, Codex or OpenCode, read from their own
/// local records by the daemon. Every field but the harness and id is optional on the wire, so one odd record never
/// empties the list.
public struct SessionSummary: Decodable, Sendable, Hashable, Identifiable {
    public let harness: String
    public let sessionId: String
    public let cwd: String
    public let title: String
    public let lastText: String
    public let updatedAt: Int64
    /// When it began (its record was made; an older Mac does not say): the tree's fixed order.
    public let startedAt: Int64?
    /// Updated within the last 90 seconds (the daemon decides).
    public let active: Bool
    /// Codex's originator: desktop, command line, editor.
    public let origin: String?
    public let branch: String?
    public let model: String?
    /// How it last asked before acting (manual · auto · bypass), when the record says: resuming keeps it.
    public let mode: String?
    /// The session this one was forked from.
    public let forkedFrom: String?

    public init(harness: String, id: String, cwd: String, title: String, lastText: String = "", updatedAt: Int64, startedAt: Int64? = nil,
                active: Bool = false, origin: String? = nil, branch: String? = nil, model: String? = nil, mode: String? = nil, forkedFrom: String? = nil) {
        self.harness = harness
        self.sessionId = id
        self.cwd = cwd
        self.title = title
        self.lastText = lastText
        self.updatedAt = updatedAt
        self.startedAt = startedAt
        self.active = active
        self.origin = origin
        self.branch = branch
        self.model = model
        self.mode = mode
        self.forkedFrom = forkedFrom
    }

    /// Unique across harnesses (two tools could reuse an id).
    public var id: String { "\(harness)/\(sessionId)" }
    /// One record of the list: a Codex session's id can stand for several records, each with its own title and times
    /// (the service lists them all), so a row is told from its twins by when it began and was last written
    /// (2026-10-05, user, of rows drawn empty in the native list: 此乃何物).
    public var recordID: String { "\(id)@\(startedAt ?? 0)-\(updatedAt)" }
    /// The title, else the start of the last text, else a plain placeholder.
    public var displayTitle: String {
        let firstLine = { (s: String) in s.split(separator: "\n").first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? "" }
        let title = firstLine(self.title)
        if !title.isEmpty { return title }
        let last = firstLine(lastText)
        return last.isEmpty ? "未命名会话" : last
    }

    private enum CodingKeys: String, CodingKey { case harness, id, cwd, title, lastText, updatedAt, startedAt, active, origin, branch, model, mode, forkedFrom }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harness = try c.decode(String.self, forKey: .harness)
        sessionId = try c.decode(String.self, forKey: .id)
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        lastText = (try? c.decodeIfPresent(String.self, forKey: .lastText)) ?? ""
        // A file's mtime in milliseconds may carry a fraction (older Macs send it as is).
        updatedAt = (try? c.decodeIfPresent(Int64.self, forKey: .updatedAt)) ?? (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)).map { Int64($0.rounded()) } ?? 0
        startedAt = (try? c.decodeIfPresent(Int64.self, forKey: .startedAt)) ?? nil
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? false
        origin = try? c.decodeIfPresent(String.self, forKey: .origin)
        branch = try? c.decodeIfPresent(String.self, forKey: .branch)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        mode = try? c.decodeIfPresent(String.self, forKey: .mode)
        forkedFrom = try? c.decodeIfPresent(String.self, forKey: .forkedFrom)
    }
}

/// One message of a session's transcript.

/// A terminal's sub-agent at work (Claude Code's SubagentStart … SubagentStop): under its terminal in the tree.
public struct TerminalSubagent: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    /// Its kind (Explore, code-reviewer, general-purpose…).
    public let type: String
    /// What it was sent to do, else its kind.
    public let name: String
    /// What it is doing now, in words (`运行 git diff`); "" before its first tool call.
    public let doing: String

    public init(id: String, type: String, name: String, doing: String = "") {
        self.id = id
        self.type = type
        self.name = name
        self.doing = doing
    }

    private enum CodingKeys: String, CodingKey { case id, type, name, doing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? type
        doing = (try? c.decodeIfPresent(String.self, forKey: .doing)) ?? ""
    }
}

/// A model the new-terminal menu offers, as the agent itself lists it: the id `--model` takes (Claude's `opus` follows
/// the next Opus), the agent's name for it, and whether a newer model of its family superseded it (the menu folds those
/// under `older`, as the agent's own picker does).
public struct TerminalModelOption: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    public let older: Bool
    /// How hard it can be asked to think, lowest first, in the agent's own words (`low … max`; OpenCode: the model's
    /// variants). Empty: it takes no level. Nil: the service does not say.
    public let efforts: [String]?
    /// The level it uses unless told, when the agent says.
    public let defaultEffort: String?
    /// Codex: whether it runs with Daybreak on and off (`also`), on alone (`only`), off alone (`never`); nil when Codex
    /// does not say (docs/simple-view-v0.md §5.8).
    public let daybreak: String?

    public init(id: String, name: String, description: String? = nil, older: Bool = false, efforts: [String]? = nil, defaultEffort: String? = nil, daybreak: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.older = older
        self.efforts = efforts
        self.defaultEffort = defaultEffort
        self.daybreak = daybreak
    }

    private enum CodingKeys: String, CodingKey { case id, name, description, older, efforts, defaultEffort, daybreak }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        older = try c.decodeIfPresent(Bool.self, forKey: .older) ?? false
        efforts = try? c.decodeIfPresent([String].self, forKey: .efforts)
        defaultEffort = try? c.decodeIfPresent(String.self, forKey: .defaultEffort)
        daybreak = try? c.decodeIfPresent(String.self, forKey: .daybreak)
    }
}

/// Codex's Daybreak switch and its models (docs/simple-view-v0.md §5.8; the phone has the same rules in its Kit): with
/// the switch on a turn goes out under the model's Daybreak program, off under its standard one — a model without the
/// one in force cannot run, so it is not offered.
public enum TerminalDaybreak {
    /// The models to choose from as the switch stands (nil: no switch — all of them). One Codex says nothing of
    /// stays either way.
    public static func offered(_ options: [TerminalModelOption], on: Bool?) -> [TerminalModelOption] {
        guard let on else { return options }
        return options.filter { $0.daybreak != (on ? "never" : "only") }
    }

    /// Why the model it is on cannot run as the switch stands, as a line for the user; nil when it can (or nothing
    /// says otherwise). Codex refuses the next turn in its own screen, where a record's reader would not see it.
    /// `name`: the model as the control beside the line writes it (else Codex's own name for it).
    public static func clash(model: TerminalModelOption?, on: Bool?, name: String? = nil) -> String? {
        guard let on, let model else { return nil }
        let name = name ?? model.name
        if on, model.daybreak == "never" { return "Codex 的模型列表里 \(name) 不支持 Daybreak，开着时它的下一轮会被 Codex 拒绝。换一个模型，或关掉 Daybreak。" }
        if !on, model.daybreak == "only" { return "Codex 的模型列表里 \(name) 只在 Daybreak 开着时可用，下一轮会被 Codex 拒绝。换一个模型，或打开 Daybreak。" }
        return nil
    }

    /// The switch as its control's words.
    public static func word(_ on: Bool) -> String { on ? "Daybreak On" : "Daybreak Off" }
    /// What turning it does beyond this session, said in its menu.
    public static let note = "对之后的新一轮生效；Codex 会把它记成新会话的默认"
}

/// How hard an agent thinks, as the new-terminal panel offers it (docs/terminal-v0.md §1 思考强度, 2026-10-07; the phone has
/// the same rules in its Kit): each agent's own word for it, and the levels the service lists for the model chosen.
public enum TerminalEffort {
    /// The agent's own word, as the control's label: Claude Code's effort, Codex's reasoning, OpenCode's variant of a
    /// model, pi's thinking.
    public static func word(_ harness: String) -> String {
        switch harness {
        case "codex": "Reasoning"
        case "opencode": "Variant"
        case "pi": "Thinking"
        default: "Effort"
        }
    }

    /// A level as people read it: `xhigh` → `XHigh`, `low` → `Low`.
    public static func name(_ level: String) -> String {
        if level == "xhigh" { return "XHigh" }
        return level.split(whereSeparator: { $0 == "-" || $0 == "_" }).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// The levels a terminal of this agent may be started at with this model chosen (nil: none chosen, the agent's
    /// default model). Empty: nothing to choose — the model takes no level, none is listed, or (OpenCode) a variant
    /// needs its model chosen first.
    public static func levels(models: [String: [TerminalModelOption]], any: [String: [String]], harness: String, model: String?) -> [String] {
        guard let model, !model.isEmpty else { return any[harness] ?? [] }
        return models[harness]?.first { $0.id == model }?.efforts ?? []
    }

    /// What "default" is, when the agent says: the chosen model's own, else the agent's default model's.
    public static func defaultLevel(models: [String: [TerminalModelOption]], defaults: [String: String], harness: String, model: String?) -> String? {
        guard let model, !model.isEmpty else { return defaults[harness] }
        return models[harness]?.first { $0.id == model }?.defaultEffort
    }

    /// The level chosen, if the model takes it; nil otherwise (its default).
    public static func kept(_ level: String?, in levels: [String]) -> String? { level.flatMap { levels.contains($0) ? $0 : nil } }

    /// The levels of the model a running terminal is on: the listed model that is it (by id, or by the name people
    /// read), else the agent's default model's.
    public static func levels(models: [String: [TerminalModelOption]], any: [String: [String]], harness: String, current model: String?) -> [String] {
        if let own = models[harness]?.first(where: { RecordDisplay.isCurrent($0, model: model) })?.efforts { return own }
        return any[harness] ?? []
    }

    /// The level a terminal is at, as far as anything says: one just asked for, the last turn's in its record, the one
    /// it was started at.
    public static func level(asked: String?, record: String?, started: String?) -> String? { asked ?? record ?? started }
}

/// `GET /terminals`: the terminals, the agents this Mac can start, each one's models, and what "default" is today for
/// the agents that say (a Mac that predates it sends none).
public struct TerminalList: Decodable, Sendable, Equatable {
    public let terminals: [TerminalInfo]
    public let agents: [String]
    public let models: [String: [TerminalModelOption]]
    public let defaults: [String: String]
    /// Per agent, the thinking levels when no model is chosen (its default model's; pi's one list).
    public let efforts: [String: [String]]
    /// Per agent, the level its default model uses unless told, when the agent says.
    public let effortDefaults: [String: String]
    /// Per agent with a Daybreak switch (Codex), how its new sessions start; an agent without one is not named.
    public let daybreak: [String: Bool]

    public init(terminals: [TerminalInfo], agents: [String], models: [String: [TerminalModelOption]] = [:], defaults: [String: String] = [:],
                efforts: [String: [String]] = [:], effortDefaults: [String: String] = [:], daybreak: [String: Bool] = [:]) {
        self.daybreak = daybreak
        self.terminals = terminals
        self.agents = agents
        self.models = models
        self.defaults = defaults
        self.efforts = efforts
        self.effortDefaults = effortDefaults
    }

    private enum CodingKeys: String, CodingKey { case terminals, agents, models, defaults, efforts, effortDefaults, daybreak }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        terminals = (try? c.decodeIfPresent([TerminalInfo].self, forKey: .terminals)) ?? []
        agents = (try? c.decodeIfPresent([String].self, forKey: .agents)) ?? []
        models = (try? c.decodeIfPresent([String: [TerminalModelOption]].self, forKey: .models)) ?? [:]
        defaults = (try? c.decodeIfPresent([String: String].self, forKey: .defaults)) ?? [:]
        efforts = (try? c.decodeIfPresent([String: [String]].self, forKey: .efforts)) ?? [:]
        effortDefaults = (try? c.decodeIfPresent([String: String].self, forKey: .effortDefaults)) ?? [:]
        daybreak = (try? c.decodeIfPresent([String: Bool].self, forKey: .daybreak)) ?? [:]
    }
}

/// `POST /terminals`. Bypass is chosen on the Mac only (the daemon answers 403 to a phone).
public struct NewTerminalRequest: Encodable, Sendable, Equatable {
    public let harness: String
    public let cwd: String
    public let model: String?
    /// How hard it thinks, one of the levels the service lists for the model; nil: the agent's own default.
    public let effort: String?
    public let mode: String?
    public let cols: Int?
    public let rows: Int?

    public init(harness: String, cwd: String, model: String? = nil, effort: String? = nil, mode: String? = nil, cols: Int? = nil, rows: Int? = nil) {
        self.harness = harness
        self.cwd = cwd
        self.model = model
        self.effort = effort
        self.mode = mode
        self.cols = cols
        self.rows = rows
    }
}

/// `POST /terminals/resume`: go on with a session (the same record), or `fork` a new one with its history.
public struct ResumeTerminalRequest: Encodable, Sendable, Equatable {
    public let harness: String
    public let cwd: String
    public let agentSessionId: String
    public let title: String?
    public let mode: String?
    public let fork: Bool?
    public let cols: Int?
    public let rows: Int?

    public init(harness: String, cwd: String, agentSessionId: String, title: String? = nil, mode: String? = nil, fork: Bool? = nil,
                cols: Int? = nil, rows: Int? = nil) {
        self.harness = harness
        self.cwd = cwd
        self.agentSessionId = agentSessionId
        self.title = title
        self.mode = mode
        self.fork = fork
        self.cols = cols
        self.rows = rows
    }

    /// The same, going on in `folder` (the session's own folder is gone).
    public func continuing(in folder: String) -> ResumeTerminalRequest {
        ResumeTerminalRequest(harness: harness, cwd: folder, agentSessionId: agentSessionId, title: title, mode: mode, fork: fork, cols: cols, rows: rows)
    }
}

/// What resuming gave: a new terminal, the one already open here, the program that has the session open (only one
/// may write it; the caller may fork instead), or the session's folder gone — moved, renamed or deleted — with folders
/// of the same name the Mac knows and the nearest folder above it still there (the caller picks one and asks again,
/// docs/terminal-v0.md §5).
public enum ResumeOutcome: Sendable, Equatable {
    case started(TerminalInfo)
    case existing(TerminalInfo)
    case elsewhere(app: String?, pid: Int?)
    case folderGone(cwd: String, alike: [String], near: String?)
}

/// A session whose words matched a search is in TerminalSearch.swift (`SessionHit`).

extension DaemonClient {
    /// `GET /terminals`: the terminals, the agents this Mac can start, their models.
    public func terminals() async throws -> TerminalList {
        try decode(TerminalList.self, try await call("GET", "/terminals"))
    }

    /// `GET /sessions`: every session the Mac lists (the tree's earlier sessions), with the list's version. Asked with
    /// the version it already has, nil while the list is unchanged: the service sends nothing and nothing is decoded.
    public func sessions(unless version: String? = nil) async throws -> Versioned<[SessionSummary]>? {
        struct Body: Decodable { let sessions: [SessionSummary] }
        guard let answer = try await callUnlessUnchanged("/sessions", version: version) else { return nil }
        return Versioned(value: try decode(Body.self, answer.value).sessions, version: answer.version)
    }

    /// `GET /sessions/search?q=`: the sessions whose words matched, with the words around the match.
    public func searchSessions(_ query: String) async throws -> [SessionHit] {
        struct Body: Decodable { let hits: [SessionHit] }
        let q = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return try decode(Body.self, try await call("GET", "/sessions/search?q=\(q)")).hits
    }

    /// `DELETE /sessions/:harness/:id`: the agent's own record of a session, for good.
    public func deleteSession(harness: String, id: String) async throws {
        _ = try await call("DELETE", "/sessions/\(Self.segment(harness))/\(Self.segment(id))")
    }

    /// `POST /terminals`.
    public func createTerminal(_ body: NewTerminalRequest) async throws -> TerminalInfo {
        struct Reply: Decodable { let terminal: TerminalInfo }
        return try decode(Reply.self, try await call("POST", "/terminals", body: try JSONEncoder().encode(body))).terminal
    }

    /// `POST /terminals/resume`: a new terminal on the session, the one already open here, the program that has it
    /// open (409), or its folder gone (422) — each an outcome, not an error.
    public func resumeTerminal(_ body: ResumeTerminalRequest) async throws -> ResumeOutcome {
        struct Reply: Decodable { let terminal: TerminalInfo; let existing: Bool? }
        struct Elsewhere: Decodable { struct Place: Decodable { let app: String?; let pid: Int? }; let elsewhere: Place? }
        struct Gone: Decodable { let folderGone: String?; let alike: [String]?; let near: String? }
        var request = request("POST", "/terminals/resume")
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data: Data, response: HTTPURLResponse
        do { (data, response) = try await transport.send(request) } catch let error as DaemonError { throw error } catch {
            throw DaemonError.unreachable(error.localizedDescription)
        }
        switch response.statusCode {
        case 200..<300:
            let reply = try decode(Reply.self, data)
            return reply.existing == true ? .existing(reply.terminal) : .started(reply.terminal)
        case 409:
            if let place = (try? JSONDecoder().decode(Elsewhere.self, from: data))?.elsewhere { return .elsewhere(app: place.app, pid: place.pid) }
        case 422:
            if let gone = try? JSONDecoder().decode(Gone.self, from: data), let cwd = gone.folderGone { return .folderGone(cwd: cwd, alike: gone.alike ?? [], near: gone.near) }
        default:
            break
        }
        throw DaemonError.http(status: response.statusCode, message: Self.errorMessage(data))
    }

    /// `PATCH /terminals/:id`: the user's own name for it; nil goes back to the derived one.
    public func renameTerminal(id: String, name: String?) async throws {
        struct Body: Encodable { let name: String? }
        let encoder = JSONEncoder()
        _ = try await call("PATCH", "/terminals/\(Self.segment(id))", body: name == nil ? Data(#"{"name":null}"#.utf8) : try encoder.encode(Body(name: name)))
    }

    /// `DELETE /terminals/:id`: the program ended and the terminal off the list; `deleteRecord`: the agent's own record
    /// of its session too, for good.
    public func closeTerminal(id: String, deleteRecord: Bool = false) async throws {
        _ = try await call("DELETE", "/terminals/\(Self.segment(id))" + (deleteRecord ? "?transcript=1" : ""))
    }
}
