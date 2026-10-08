import Foundation

// AgentSwitch's own terminals, the manual entry (docs/terminal-v0.md §4): what `GET /terminals` lists, what the phone
// may send (a sealed reply, named keys, a resize, a permission decision) and what the stream brings. Unknown fields and
// values decode leniently, so a newer Mac never empties the list.

/// A terminal's state: an agent at work, waiting for the user, idle, or ended.
public enum TerminalStatus: Sendable, Hashable, Codable {
    case working, waiting, idle, exited
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "working": self = .working
        case "waiting": self = .waiting
        case "idle": self = .idle
        case "exited": self = .exited
        default: self = .other(rawValue)
        }
    }

    public init(from decoder: Decoder) throws { self.init(rawValue: try decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public var rawValue: String {
        switch self {
        case .working: return "working"
        case .waiting: return "waiting"
        case .idle: return "idle"
        case .exited: return "exited"
        case .other(let s): return s
        }
    }

    /// The word on screen (docs/ui-v0.md §7.2.7: Busy · Waiting · Idle · Exited).
    public var label: String {
        switch self {
        case .working: return "Busy"
        case .waiting: return "Waiting"
        case .idle: return "Idle"
        case .exited: return "Exited"
        case .other(let s): return s
        }
    }
}

/// One question the agent asks (Claude Code's AskUserQuestion, docs/terminal-v0.md §3 "选择题"): its chip, the question,
/// its options; one to pick or several. One without options takes words only.
public struct TerminalQuestion: Decodable, Sendable, Hashable {
    public struct Option: Decodable, Sendable, Hashable {
        public let label: String
        public let description: String

        public init(label: String, description: String = "") { self.label = label; self.description = description }

        private enum CodingKeys: String, CodingKey { case label, description }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(String.self, forKey: .label)
            description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
        }
    }

    public let question: String
    public let header: String
    public let multiSelect: Bool
    public let options: [Option]

    public init(question: String, header: String = "", multiSelect: Bool = false, options: [Option]) {
        self.question = question
        self.header = header
        self.multiSelect = multiSelect
        self.options = options
    }

    private enum CodingKeys: String, CodingKey { case question, header, multiSelect, options }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        question = try c.decode(String.self, forKey: .question)
        header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
        multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) ?? false
        options = (try? c.decodeIfPresent([Option].self, forKey: .options)) ?? []
    }
}

/// A permission request from the agent's hook, waiting for a screen's answer.
public struct TerminalPermission: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let tool: String
    /// "Bash: rm -rf build", as the Mac shows it; a question's own words for a question.
    public let summary: String
    public let at: Int64
    /// The agent asks these (AskUserQuestion): answered with picks, not allow / deny. Empty for any other request, and
    /// from a Mac that predates question cards (it shows as a permission then).
    public let questions: [TerminalQuestion]

    public init(id: String, tool: String, summary: String, at: Int64 = 0, questions: [TerminalQuestion] = []) {
        self.id = id
        self.tool = tool
        self.summary = summary
        self.at = at
        self.questions = questions
    }

    private enum CodingKeys: String, CodingKey { case id, tool, summary, at, questions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? ""
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        at = (try? c.decodeIfPresent(Int64.self, forKey: .at)) ?? 0
        questions = (try? c.decodeIfPresent([TerminalQuestion].self, forKey: .questions)) ?? []
    }

    /// The agent asks (a question card), rather than asks leave (allow / deny).
    public var isQuestion: Bool { !questions.isEmpty }

    /// What it asks, without the tool's name in front ("rm -rf build").
    public var detail: String {
        summary.hasPrefix("\(tool): ") ? String(summary.dropFirst(tool.count + 2)) : summary
    }
}

/// The tool a terminal's agent is using now and what on (a command, a file, a page), as it reported it before use.
public struct TerminalActivity: Decodable, Sendable, Hashable {
    public let tool: String
    public let target: String
    /// What the agent says this is for, in its own words; the record's line says that in place of the command.
    public let note: String?

    public init(tool: String, target: String, note: String? = nil) {
        self.tool = tool
        self.target = target
        self.note = note
    }

    /// As people say it: `运行 npm test`, `修改 /w/a.ts` (the Live Activity's step).
    public var phrase: String {
        let label = ToolDisplay.label(tool)
        let what = EventDescriber.unwrapShell(target).split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        return what.isEmpty ? label : "\(label) \(what)"
    }
}

public struct TerminalInfo: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let harness: String
    public let cwd: String
    /// Where the agent is now: the `cwd` its hook calls carry, which follows a `cd` (Claude Code, Codex); the starting
    /// folder for the others and from services before 2026-10-01.
    public let workdir: String
    public let model: String?
    /// The model the agent says it is on now (Claude Code, each time it changes); nil until it has said, and from a Mac
    /// that does not ask it. `model` is what the terminal was started with.
    public let modelNow: String?
    /// What Claude Code offers as your next message (its prompt suggestion), while it rests and shows one.
    public let suggestion: String?
    /// Codex's Daybreak switch for the session it is on (docs/simple-view-v0.md §5.8); nil: this terminal has none
    /// (and from a Mac that does not say).
    public let daybreak: Bool?
    /// The Mac can set its model and its level from a screen (`POST …/model`, `…/effort`): its agent takes a command
    /// for them, or the terminal's own server does. Nil from a Mac that does not say (then Claude Code alone).
    public let sets: Bool?
    /// The thinking level it was started at, in the agent's own word; nil: the agent's default.
    public let effort: String?
    /// manual · auto · bypass
    public let mode: String
    public let name: String
    public let customName: Bool
    public let status: TerminalStatus
    public let cols: Int
    public let rows: Int
    public let createdAt: Int64
    public let lastOutputAt: Int64
    public let exitCode: Int?
    public let agentSessionId: String?
    public let resumedFrom: String?
    public let forked: Bool
    public let permissions: [TerminalPermission]
    /// What it is using now, while it works (a service from before 2026-09-30 does not say).
    public let activity: TerminalActivity?
    /// When its status last changed, in milliseconds (older services: nil).
    public let statusSince: Int64?
    /// Its sub-agents at work, in the order they started (docs/terminal-v0.md §1; older services: none).
    public let subagents: [TerminalSubagent]
    /// How far its turn has come, as its own screen counts it (nil: it says nothing, or an older service).
    public let progress: TurnProgress?
    /// Replies sent to it that its record does not hold yet (older services: none).
    public let sent: [SentReply]

    public init(id: String, harness: String, cwd: String, workdir: String? = nil, model: String? = nil, mode: String = "manual", name: String,
                customName: Bool = false, status: TerminalStatus, cols: Int = 80, rows: Int = 24, createdAt: Int64,
                lastOutputAt: Int64, exitCode: Int? = nil, agentSessionId: String? = nil, resumedFrom: String? = nil,
                forked: Bool = false, permissions: [TerminalPermission] = [], activity: TerminalActivity? = nil, statusSince: Int64? = nil,
                subagents: [TerminalSubagent] = [], modelNow: String? = nil, effort: String? = nil, suggestion: String? = nil, daybreak: Bool? = nil, sets: Bool? = nil,
                progress: TurnProgress? = nil, sent: [SentReply] = []) {
        self.progress = progress
        self.sent = sent
        self.suggestion = suggestion
        self.daybreak = daybreak
        self.sets = sets
        self.modelNow = modelNow
        self.effort = effort
        self.id = id
        self.harness = harness
        self.cwd = cwd
        self.workdir = workdir ?? cwd
        self.model = model
        self.mode = mode
        self.name = name
        self.customName = customName
        self.status = status
        self.cols = cols
        self.rows = rows
        self.createdAt = createdAt
        self.lastOutputAt = lastOutputAt
        self.exitCode = exitCode
        self.agentSessionId = agentSessionId
        self.resumedFrom = resumedFrom
        self.forked = forked
        self.permissions = permissions
        self.activity = activity
        self.statusSince = statusSince
        self.subagents = subagents
    }

    private enum CodingKeys: String, CodingKey {
        case id, harness, cwd, workdir, model, modelNow, suggestion, daybreak, sets, effort, mode, name, customName, status, cols, rows, createdAt, lastOutputAt, exitCode,
             agentSessionId, resumedFrom, forked, permissions, activity, statusSince, subagents, progress, sent
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        harness = (try? c.decodeIfPresent(String.self, forKey: .harness)) ?? ""
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        workdir = (try? c.decodeIfPresent(String.self, forKey: .workdir)).flatMap { $0 } ?? cwd
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        modelNow = try? c.decodeIfPresent(String.self, forKey: .modelNow)
        suggestion = (try? c.decodeIfPresent(String.self, forKey: .suggestion)).flatMap { $0.isEmpty ? nil : $0 }
        daybreak = (try? c.decodeIfPresent(Bool.self, forKey: .daybreak)) ?? nil
        sets = (try? c.decodeIfPresent(Bool.self, forKey: .sets)) ?? nil
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        mode = (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? "manual"
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        customName = (try? c.decodeIfPresent(Bool.self, forKey: .customName)) ?? false
        status = (try? c.decodeIfPresent(TerminalStatus.self, forKey: .status)) ?? .idle
        cols = (try? c.decodeIfPresent(Int.self, forKey: .cols)) ?? 80
        rows = (try? c.decodeIfPresent(Int.self, forKey: .rows)) ?? 24
        createdAt = (try? c.decodeIfPresent(Int64.self, forKey: .createdAt)) ?? 0
        lastOutputAt = (try? c.decodeIfPresent(Int64.self, forKey: .lastOutputAt)) ?? createdAt
        exitCode = try? c.decodeIfPresent(Int.self, forKey: .exitCode)
        agentSessionId = try? c.decodeIfPresent(String.self, forKey: .agentSessionId)
        resumedFrom = try? c.decodeIfPresent(String.self, forKey: .resumedFrom)
        forked = (try? c.decodeIfPresent(Bool.self, forKey: .forked)) ?? false
        permissions = (try? c.decodeIfPresent([TerminalPermission].self, forKey: .permissions)) ?? []
        activity = try? c.decodeIfPresent(TerminalActivity.self, forKey: .activity)
        statusSince = try? c.decodeIfPresent(Int64.self, forKey: .statusSince)
        subagents = (try? c.decodeIfPresent([TerminalSubagent].self, forKey: .subagents)) ?? []
        progress = try? c.decodeIfPresent(TurnProgress.self, forKey: .progress)
        sent = (try? c.decodeIfPresent([SentReply].self, forKey: .sent)) ?? []
    }

    public var created: Date { Date(milliseconds: createdAt) }
    public var lastOutput: Date { Date(milliseconds: lastOutputAt) }
    public var isRunning: Bool { status != .exited }
    public var harnessName: String { ModelName.harness(harness) }
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
    /// variants). Empty: it takes no level. Nil: the Mac does not say (an older Mac, or the agent's list was not read).
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

/// `GET /terminals`: the terminals, the agents this Mac can start, each one's models, and what "default" is today for
/// the agents that say (a Mac that predates it sends none).
public struct TerminalList: Decodable, Sendable, Hashable {
    public let terminals: [TerminalInfo]
    public let agents: [String]
    public let models: [String: [TerminalModelOption]]
    public let defaults: [String: String]
    /// Per agent, the thinking levels when no model is chosen (its default model's; pi's one list). None for an agent
    /// whose levels belong to a model (OpenCode's variants).
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

/// What the model control under a terminal's reply box opens (docs/simple-view-v0.md §5.4): the agent's models where
/// the Mac can set one for it — Claude Code by its own command, another where the terminal says so (`sets`: a Codex or
/// an OpenCode behind its own server, pi) — else the agent's own picker on its own screen. The phone listed models for
/// Claude Code alone until 2026-10-07 (user, of a Codex terminal: 手机上怎么还是不能选模型).
public enum TerminalModelMenu: Equatable, Sendable {
    /// The terminal has ended.
    case ended
    /// Choose one of these (as Codex's Daybreak switch stands, where it has one).
    case models([TerminalModelOption])
    /// It takes a model from here, but not while it works or waits for an answer.
    case busy
    /// Its own picker, in the terminal view.
    case picker

    public static func offer(harness: String, sets: Bool?, exited: Bool, resting: Bool, options: [TerminalModelOption], daybreak: Bool?) -> TerminalModelMenu {
        if exited { return .ended }
        let offered = TerminalDaybreak.offered(options, on: daybreak)
        guard sets ?? (harness == "claude-code"), !offered.isEmpty else { return .picker }
        return resting ? .models(offered) : .busy
    }

    /// Whether its level is chosen on the slider here, and when: Claude Code takes one while it works too (the next
    /// request of the turn runs at it), the others only at rest. Nil: not from here.
    public static func levelTakenWhileWorking(harness: String, sets: Bool?) -> Bool? {
        guard sets ?? (harness == "claude-code") else { return nil }
        return harness == "claude-code"
    }
}

/// Codex's Daybreak switch and its models (docs/simple-view-v0.md §5.8; the Mac app has the same rules): with the
/// switch on a turn goes out under the model's Daybreak program, off under its standard one — a model without the one
/// in force cannot run, so it is not offered.
public enum TerminalDaybreak {
    /// The models to choose from as the switch stands (nil: no switch — all of them). One Codex says nothing of
    /// stays either way.
    public static func offered(_ options: [TerminalModelOption], on: Bool?) -> [TerminalModelOption] {
        guard let on else { return options }
        return options.filter { $0.daybreak != (on ? "never" : "only") }
    }

    /// Why the model it is on cannot run as the switch stands, as a line for the user; nil when it can (or nothing
    /// says otherwise). `name`: the model as the control beside the line writes it.
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

/// `POST /terminals`. Bypass is chosen on the Mac only (the daemon answers 403 to a phone).
public struct NewTerminalRequest: Encodable, Sendable, Equatable {
    public let harness: String
    public let cwd: String
    public let model: String?
    /// How hard it thinks, one of the levels the Mac lists for the model; nil: the agent's own default.
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

/// The named keys `POST /terminals/:id/keys` takes (daemon terminals/keys.ts).
public enum TerminalKey: String, Sendable, CaseIterable, Codable {
    case esc, tab, shiftTab = "shift-tab", enter, backspace, up, down, left, right, pageUp = "pgup", pageDown = "pgdn"
    /// One notch of the wheel: the Mac sends it the way the program asked (a mouse report, an arrow, or nothing).
    case wheelUp = "wheel-up", wheelDown = "wheel-down"
    case ctrlC = "ctrl-c", ctrlD = "ctrl-d", ctrlL = "ctrl-l", ctrlR = "ctrl-r"
    case y, n, one = "1", two = "2", three = "3", four = "4", five = "5", six = "6", seven = "7", eight = "8", nine = "9"
}

/// The reply's result: how many credentials the sealer turned into ciphertext on the way in.
public struct TerminalInputResult: Decodable, Sendable, Equatable {
    public let sealed: Int
    /// Files sent with it; nil from a Mac that predates attachments (it sent the placeholders as text).
    public let attached: Int?

    public init(sealed: Int, attached: Int? = nil) { self.sealed = sealed; self.attached = attached }

    private enum CodingKeys: String, CodingKey { case sealed, attached }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        sealed = (try? c?.decodeIfPresent(Int.self, forKey: .sealed)) ?? 0
        attached = (try? c?.decodeIfPresent(Int.self, forKey: .attached)) ?? nil
    }
}

/// `GET /terminals/style`: the user's iTerm2 colours (or the built-in set), as CSS colours.
public struct TerminalStyle: Decodable, Sendable, Equatable {
    public let theme: [String: String]

    public init(theme: [String: String]) { self.theme = theme }

    private enum CodingKeys: String, CodingKey { case theme }

    public init(from decoder: Decoder) throws {
        theme = (try? decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([String: String].self, forKey: .theme)) ?? [:]
    }

    /// The 16 ANSI colours in order, as 8-bit RGB; nil when any is missing or not a #rrggbb colour.
    public var ansi: [RGB]? {
        let names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen",
                     "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]
        let colors = names.compactMap { theme[$0].flatMap(RGB.init(hex:)) }
        return colors.count == names.count ? colors : nil
    }

    public var background: RGB? { theme["background"].flatMap(RGB.init(hex:)) }
    public var foreground: RGB? { theme["foreground"].flatMap(RGB.init(hex:)) }

    public struct RGB: Sendable, Equatable {
        public let r: UInt8, g: UInt8, b: UInt8

        public init(r: UInt8, g: UInt8, b: UInt8) {
            self.r = r
            self.g = g
            self.b = b
        }

        /// `#rrggbb` (the style's colours; `rgba(...)` selection colours are not read).
        public init?(hex: String) {
            let s = hex.trimmingCharacters(in: .whitespaces)
            guard s.count == 7, s.hasPrefix("#"), let v = UInt32(s.dropFirst(), radix: 16) else { return nil }
            r = UInt8((v >> 16) & 0xFF)
            g = UInt8((v >> 8) & 0xFF)
            b = UInt8(v & 0xFF)
        }
    }
}

/// One event of a terminal's stream (`GET /terminals/:id/stream`).
public enum TerminalEvent: Sendable, Equatable {
    /// The screen as it is (escape sequences that draw it), at the size it has.
    case snapshot(seq: Int64, cols: Int, rows: Int, data: String)
    case output(seq: Int64, data: String)
    case status(TerminalStatus)
    case name(String)
    /// The size, and the screen that owns it (this phone's, another's, or nil when none does: its owner left). Sent on
    /// every connect too.
    case resize(cols: Int, rows: Int, by: String?)
    case permission(TerminalPermission)
    case permissionResolved(id: String)
    /// Every request waiting, sent on each (re)connect: the screen's list becomes this (one answered elsewhere while
    /// the phone was away goes).
    case permissions([TerminalPermission])
    case exit(code: Int?)
    /// The terminal was closed: screens leave it.
    case removed
    /// What it is doing now changed: the tool and its sub-agents (a stream that follows the record, simple-view-v0 §4).
    case activity(TerminalActivity?, [TerminalSubagent])
    /// How far the turn has come changed, as the agent's own screen counts it (nil: it says nothing now).
    case progress(TurnProgress?)
    /// The replies sent and not yet in the record changed.
    case sent([SentReply])
    /// Its session's record changed.
    case record(rev: String)
    /// The agent is on another model now.
    case model(String)
    /// What it offers as your next message changed (nil: it offers none now).
    case suggestion(String?)
    /// Codex's Daybreak switch stands otherwise now.
    case daybreak(Bool)

    /// The SSE frame: the event name, the JSON data. Anything unknown or broken is skipped (nil), not fatal.
    public static func parse(event: String, data: String) -> TerminalEvent? {
        guard let json = data.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
        let int = { (k: String) in (obj[k] as? NSNumber)?.intValue }
        let seq = { (obj["seq"] as? NSNumber)?.int64Value }
        switch event {
        case "snapshot":
            guard let s = seq(), let cols = int("cols"), let rows = int("rows"), let d = obj["data"] as? String else { return nil }
            return .snapshot(seq: s, cols: cols, rows: rows, data: d)
        case "output":
            guard let s = seq(), let d = obj["data"] as? String else { return nil }
            return .output(seq: s, data: d)
        case "status":
            return (obj["status"] as? String).map { .status(TerminalStatus(rawValue: $0)) }
        case "name":
            return (obj["name"] as? String).map { .name($0) }
        case "resize":
            guard let cols = int("cols"), let rows = int("rows") else { return nil }
            return .resize(cols: cols, rows: rows, by: obj["by"] as? String)
        case "permission":
            guard let request = obj["request"], let raw = try? JSONSerialization.data(withJSONObject: request),
                  let p = try? JSONDecoder().decode(TerminalPermission.self, from: raw) else { return nil }
            return .permission(p)
        case "permission_resolved":
            return (obj["id"] as? String).map { .permissionResolved(id: $0) }
        case "permissions":
            guard let requests = obj["requests"], let raw = try? JSONSerialization.data(withJSONObject: requests),
                  let all = try? JSONDecoder().decode([TerminalPermission].self, from: raw) else { return nil }
            return .permissions(all)
        case "exit":
            return .exit(code: int("code"))
        case "removed":
            return .removed
        case "activity":
            let decode = { (key: String) -> Data? in obj[key].flatMap { $0 is NSNull ? nil : try? JSONSerialization.data(withJSONObject: $0) } }
            let activity = decode("activity").flatMap { try? JSONDecoder().decode(TerminalActivity.self, from: $0) }
            let subagents = decode("subagents").flatMap { try? JSONDecoder().decode([TerminalSubagent].self, from: $0) } ?? []
            return .activity(activity, subagents)
        case "progress":
            let progress = (obj["progress"] as? [String: Any]).flatMap { p in (p["tokens"] as? Int).map { TurnProgress(tokens: $0, way: p["way"] as? String ?? "down") } }
            return .progress(progress)
        case "sent":
            let replies = (obj["replies"] as? [[String: Any]] ?? []).compactMap { r -> SentReply? in
                guard let id = r["id"] as? String, let text = r["text"] as? String else { return nil }
                return SentReply(id: id, text: text, at: (r["at"] as? NSNumber)?.int64Value ?? 0, files: r["files"] as? Int ?? 0)
            }
            return .sent(replies)
        case "record":
            return (obj["rev"] as? String).map { .record(rev: $0) }
        case "model":
            return (obj["model"] as? String).map { .model($0) }
        case "suggestion":
            return .suggestion((obj["text"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        case "daybreak":
            return (obj["on"] as? Bool).map { .daybreak($0) }
        default:
            return nil
        }
    }

    /// The seq output events carry: the stream resumes after the last one it delivered.
    public var seq: Int64? {
        switch self {
        case .snapshot(let s, _, _, _), .output(let s, _): return s
        default: return nil
        }
    }
}

/// A folder's git at a glance (docs/terminal-v0.md §1 文件夹行的 git 状态): after its name in the tree, `main ±5 ↑2 ↓4`.
public struct GitSummary: Codable, Sendable, Equatable {
    /// The branch, or the commit's short id when detached.
    public let branch: String
    /// Files changed, staged or not, untracked included.
    public let changed: Int
    public let ahead: Int
    public let behind: Int

    public init(branch: String, changed: Int = 0, ahead: Int = 0, behind: Int = 0) {
        self.branch = branch
        self.changed = changed
        self.ahead = ahead
        self.behind = behind
    }

    /// As the tree shows it; what is 0 is left out.
    public var said: String {
        [branch, changed > 0 ? "±\(changed)" : "", ahead > 0 ? "↑\(ahead)" : "", behind > 0 ? "↓\(behind)" : ""]
            .filter { !$0.isEmpty }.joined(separator: " ")
    }
}

struct FolderGitList: Decodable {
    let folders: [String: GitSummary]
}

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

