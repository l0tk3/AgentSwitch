import Foundation

// A terminal in a window of its own (docs/dispatch-v0.md §1 单独的窗口; docs/terminal-v0.md §1, 2026-10-05): what such a
// window reads of its terminal — the terminal as the service lists it, the requests in its stream —, how a question is
// answered, the words on its bars and cards, and the routes it calls. All native: the main window's terminal page draws
// the same things in a web view (terminal.js), with the same words and rules.

/// A terminal as the service lists it (`GET /terminals`, `GET /terminals/:id`): what the list, the bars and a window of
/// its own show of it. Every field but the id is lenient on the wire, so one odd terminal never empties the list.
public struct TerminalInfo: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let harness: String
    /// Where it was started, and where its agent works now (the same until the agent moves).
    public let cwd: String
    public let workdir: String
    public let model: String?
    /// The thinking level it was started at, when one was chosen.
    public let effort: String?
    /// How it asks now, in its own word, once anything has said (`mode` is what it was started with).
    public let modeNow: String?
    /// What Claude Code offers as your next message, while it rests and shows one on its screen.
    public let suggestion: String?
    /// A screen can set its model and level; nil from a service that does not say (then by the agent's kind).
    public let sets: Bool?
    /// Codex's Daybreak switch for the session it is on (docs/simple-view-v0.md §5.8); nil: this terminal has none.
    public let daybreak: Bool?
    public let mode: String?
    /// The list's name for it: the user's own (`customName`), else the agent's title, else the folder's.
    public let name: String
    public let customName: Bool
    /// `working`, `waiting`, `idle`, `exited`.
    public let status: String
    public let cols: Int?
    public let rows: Int?
    public let createdAt: Int64
    public let exitCode: Int?
    /// The agent's own session, the one it was continued from, and whether as a fork: the tree lists none of them
    /// again while the terminal runs.
    public let agentSessionId: String?
    public let resumedFrom: String?
    public let forked: Bool
    public let permissions: [TerminalRequest]
    /// Its sub-agents at work, a row each under it.
    public let subagents: [TerminalSubagent]
    /// The name of the profile it runs under (docs/profiles-v0.md); nil: the Mac's own (`Default`).
    public private(set) var profileName: String?
    /// That profile's colour (docs/profiles-v0.md §3.2): the lit dot this terminal is marked with while it runs.
    public private(set) var profileColor: ProfileColor?
    /// The device Claude Code says it is in this terminal (docs/profiles-v0.md §3.5): its own id for the folder it runs
    /// with, a profile's own; nil: not known yet, or another agent.
    public private(set) var device: String?

    private enum CodingKeys: String, CodingKey {
        case id, harness, cwd, workdir, model, effort, modeNow, suggestion, sets, daybreak, mode, name, customName, status, cols, rows, createdAt, exitCode, agentSessionId, resumedFrom, forked,
             permissions, subagents, profile, device
    }

    public init(id: String, harness: String, cwd: String, workdir: String? = nil, model: String? = nil, mode: String? = nil,
                name: String, customName: Bool = false, status: String, cols: Int? = nil, rows: Int? = nil, createdAt: Int64 = 0,
                exitCode: Int? = nil, agentSessionId: String? = nil, resumedFrom: String? = nil, forked: Bool = false,
                permissions: [TerminalRequest] = [], subagents: [TerminalSubagent] = [], effort: String? = nil, modeNow: String? = nil,
                suggestion: String? = nil, sets: Bool? = nil, daybreak: Bool? = nil) {
        self.sets = sets
        self.daybreak = daybreak
        self.suggestion = suggestion.flatMap { $0.isEmpty ? nil : $0 }
        self.effort = effort.flatMap { $0.isEmpty ? nil : $0 }
        self.modeNow = modeNow.flatMap { $0.isEmpty ? nil : $0 }
        self.id = id
        self.harness = harness
        self.cwd = cwd
        self.workdir = workdir.flatMap { $0.isEmpty ? nil : $0 } ?? cwd
        self.model = model.flatMap { $0.isEmpty ? nil : $0 }
        self.mode = mode.flatMap { $0.isEmpty ? nil : $0 }
        self.name = name
        self.customName = customName
        self.status = status
        self.cols = cols
        self.rows = rows
        self.createdAt = createdAt
        self.exitCode = exitCode
        self.agentSessionId = agentSessionId.flatMap { $0.isEmpty ? nil : $0 }
        self.resumedFrom = resumedFrom.flatMap { $0.isEmpty ? nil : $0 }
        self.forked = forked
        self.permissions = permissions
        self.subagents = subagents
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  harness: (try? c.decodeIfPresent(String.self, forKey: .harness)) ?? "",
                  cwd: (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? "",
                  workdir: (try? c.decodeIfPresent(String.self, forKey: .workdir)) ?? nil,
                  model: (try? c.decodeIfPresent(String.self, forKey: .model)) ?? nil,
                  mode: (try? c.decodeIfPresent(String.self, forKey: .mode)) ?? nil,
                  name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "",
                  customName: (try? c.decodeIfPresent(Bool.self, forKey: .customName)) ?? false,
                  status: (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "idle",
                  cols: (try? c.decodeIfPresent(Int.self, forKey: .cols)) ?? nil,
                  rows: (try? c.decodeIfPresent(Int.self, forKey: .rows)) ?? nil,
                  createdAt: (try? c.decodeIfPresent(Int64.self, forKey: .createdAt)) ?? 0,
                  exitCode: (try? c.decodeIfPresent(Int.self, forKey: .exitCode)) ?? nil,
                  agentSessionId: (try? c.decodeIfPresent(String.self, forKey: .agentSessionId)) ?? nil,
                  resumedFrom: (try? c.decodeIfPresent(String.self, forKey: .resumedFrom)) ?? nil,
                  forked: (try? c.decodeIfPresent(Bool.self, forKey: .forked)) ?? false,
                  permissions: (try? c.decodeIfPresent([TerminalRequest].self, forKey: .permissions)) ?? [],
                  subagents: (try? c.decodeIfPresent([TerminalSubagent].self, forKey: .subagents)) ?? [],
                  effort: (try? c.decodeIfPresent(String.self, forKey: .effort)) ?? nil,
                  modeNow: (try? c.decodeIfPresent(String.self, forKey: .modeNow)) ?? nil,
                  suggestion: (try? c.decodeIfPresent(String.self, forKey: .suggestion)) ?? nil,
                  sets: (try? c.decodeIfPresent(Bool.self, forKey: .sets)) ?? nil,
                  daybreak: (try? c.decodeIfPresent(Bool.self, forKey: .daybreak)) ?? nil)
        struct Profile: Decodable { let name: String; let exit: ProfileExit?; let color: String? }
        let profile = (try? c.decodeIfPresent(Profile.self, forKey: .profile)) ?? nil
        // A profile with a proxy of its own: where that proxy let traffic out when the terminal started goes with its
        // name wherever the name is shown (docs/profiles-v0.md §4: 代理标注在底栏).
        profileName = profile.map { [$0.name, $0.exit?.text].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }
        profileColor = profile?.color.flatMap(ProfileColor.init(rawValue:))
        device = ((try? c.decodeIfPresent(String.self, forKey: .device)) ?? nil).flatMap { DeviceID.valid($0) ? $0 : nil }
    }

    public var running: Bool { status != "exited" }
    public var isRunning: Bool { running }

    /// The same terminal as one that runs under a profile (what the service says of it when it does): the profile's
    /// words and its colour.
    public func under(profile words: String, color: ProfileColor?, device: String? = nil) -> TerminalInfo {
        var copy = self
        copy.profileName = words
        copy.profileColor = color
        copy.device = device ?? self.device
        return copy
    }

    /// The same terminal with what its stream just said: its status, its name.
    public func with(status: String? = nil, name: String? = nil, exitCode: Int? = nil) -> TerminalInfo {
        var copy = TerminalInfo(id: id, harness: harness, cwd: cwd, workdir: workdir, model: model, mode: mode, name: name ?? self.name,
                     customName: customName, status: status ?? self.status, cols: cols, rows: rows, createdAt: createdAt,
                     exitCode: exitCode ?? self.exitCode, agentSessionId: agentSessionId, resumedFrom: resumedFrom, forked: forked,
                     permissions: permissions, subagents: subagents, effort: effort, modeNow: modeNow, suggestion: suggestion, sets: sets, daybreak: daybreak)
        copy.profileName = profileName
        copy.profileColor = profileColor
        copy.device = device
        return copy
    }

    /// The status bar's words for it (MainStatus.swift): agent and model, mode, grid; the lock acts while it runs.
    public var context: TerminalContext {
        var context = TerminalContext(harness: harness, model: model, mode: mode, cols: cols, rows: rows, away: nil, running: running)
        context.profile = profileName
        context.profileColor = profileColor
        context.device = device
        return context
    }
}

/// What an agent in a terminal waits for: leave to use a tool (allow or deny), or — with `questions` — its own question
/// (Claude Code's AskUserQuestion), answered with picks instead.
public struct TerminalRequest: Decodable, Equatable, Sendable, Identifiable {
    public struct Option: Decodable, Equatable, Sendable {
        public let label: String
        public let description: String

        private enum CodingKeys: String, CodingKey { case label, description }

        public init(label: String, description: String = "") {
            self.label = label
            self.description = description
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(label: try c.decode(String.self, forKey: .label), description: try c.decodeIfPresent(String.self, forKey: .description) ?? "")
        }
    }

    /// One question: the agent's short label for it, the question, its options; one to pick or several. Without
    /// options it takes only words.
    public struct Question: Decodable, Equatable, Sendable {
        public let question: String
        public let header: String
        public let multiSelect: Bool
        public let options: [Option]

        private enum CodingKeys: String, CodingKey { case question, header, multiSelect, options }

        public init(question: String, header: String = "", multiSelect: Bool = false, options: [Option] = []) {
            self.question = question
            self.header = header
            self.multiSelect = multiSelect
            self.options = options
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.init(question: try c.decode(String.self, forKey: .question),
                      header: try c.decodeIfPresent(String.self, forKey: .header) ?? "",
                      multiSelect: try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false,
                      options: try c.decodeIfPresent([Option].self, forKey: .options) ?? [])
        }
    }

    public let id: String
    public let tool: String
    /// One line to read: `Edit: /path/to/file`.
    public let summary: String
    public let questions: [Question]

    private enum CodingKeys: String, CodingKey { case id, tool, summary, questions }

    public init(id: String, tool: String, summary: String, questions: [Question] = []) {
        self.id = id
        self.tool = tool
        self.summary = summary
        self.questions = questions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  tool: try c.decodeIfPresent(String.self, forKey: .tool) ?? "",
                  summary: try c.decodeIfPresent(String.self, forKey: .summary) ?? "",
                  questions: try c.decodeIfPresent([Question].self, forKey: .questions) ?? [])
    }

    public var isQuestion: Bool { !questions.isEmpty }
}

/// One event of `GET /terminals/:id/stream` the window acts on (the screen takes the rest: TerminalStreamEvent).
public enum TerminalWindowEvent: Equatable, Sendable {
    case status(String)
    case name(String)
    case exit(code: Int?)
    /// The terminal was deleted: its window closes.
    case removed
    case permission(TerminalRequest)
    case resolved(String)
    /// Every request waiting now, on each connect: what the window holds is replaced.
    case permissions([TerminalRequest])

    public static func decode(event: String, data: String) -> TerminalWindowEvent? {
        let bytes = Data(data.utf8)
        switch event {
        case "status":
            struct Body: Decodable { let status: String }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .status($0.status) }
        case "name":
            struct Body: Decodable { let name: String }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .name($0.name) }
        case "exit":
            struct Body: Decodable { let code: Int? }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .exit(code: $0.code) }
        case "removed":
            return .removed
        case "permission":
            struct Body: Decodable { let request: TerminalRequest }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .permission($0.request) }
        case "permission_resolved":
            struct Body: Decodable { let id: String }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .resolved($0.id) }
        case "permissions":
            struct Body: Decodable { let requests: [TerminalRequest] }
            return (try? JSONDecoder().decode(Body.self, from: bytes)).map { .permissions($0.requests) }
        default:
            return nil
        }
    }
}

/// The requests a window holds, as its terminal's stream says them.
public enum TerminalRequests {
    public static func applying(_ event: TerminalWindowEvent, to waiting: [TerminalRequest]) -> [TerminalRequest] {
        switch event {
        case .permission(let request): waiting.contains { $0.id == request.id } ? waiting : waiting + [request]
        case .resolved(let id): waiting.filter { $0.id != id }
        case .permissions(let all): all
        case .exit, .removed: []
        case .status, .name: waiting
        }
    }
}

/// A request as its card says it (terminal.js addToast): the tool in plain words, what it acts on — a path from the
/// terminal's folder when it is under it, else from `~` —, and the folder.
public struct TerminalRequestText: Equatable, Sendable {
    public let tool: String
    public let detail: String
    public let folder: String?

    static let toolWords = ["Write": "Write File", "Edit": "Edit File", "MultiEdit": "Edit File", "NotebookEdit": "Edit Notebook",
                            "Bash": "Run Command", "WebFetch": "Fetch Page", "WebSearch": "Search Web"]

    public init(_ request: TerminalRequest, cwd: String?, home: String) {
        tool = Self.toolWords[request.tool] ?? request.tool
        let prefix = "\(request.tool): "
        let raw = request.summary.hasPrefix(prefix) ? String(request.summary.dropFirst(prefix.count)) : request.summary
        let cwd = cwd.flatMap { $0.isEmpty ? nil : $0 }
        if let cwd, raw.hasPrefix(cwd + "/") {
            detail = String(raw.dropFirst(cwd.count + 1))
        } else {
            detail = DisplayPath.short(raw, home: home)
        }
        folder = cwd.map { DisplayPath.short($0, home: home) }
    }
}

/// The answers to a request's questions as the card holds them (terminal.js addQuestion): one option of several, or
/// several; words written in Other take the one pick's place, or go beside several.
public struct TerminalAnswers: Equatable, Sendable {
    public struct Pick: Equatable, Sendable {
        public let labels: [String]
        public let other: String
    }

    /// One question's answer as the service takes it.
    public struct Answer: Encodable, Equatable, Sendable {
        public let labels: [String]
        public let other: String?
    }

    public enum Key: Equatable, Sendable {
        case pick(String)
        case other
    }

    public let questions: [TerminalRequest.Question]
    public let picks: [Pick]

    public init(_ questions: [TerminalRequest.Question]) {
        self.init(questions, picks: questions.map { _ in Pick(labels: [], other: "") })
    }

    private init(_ questions: [TerminalRequest.Question], picks: [Pick]) {
        self.questions = questions
        self.picks = picks
    }

    private func replacing(_ index: Int, _ pick: Pick) -> TerminalAnswers {
        TerminalAnswers(questions, picks: picks.enumerated().map { $0.offset == index ? pick : $0.element })
    }

    /// An option clicked: picked (several: or unpicked); one of several clears what was written in Other.
    public func picking(_ index: Int, _ label: String) -> TerminalAnswers {
        guard questions.indices.contains(index) else { return self }
        let now = picks[index]
        if questions[index].multiSelect {
            let labels = now.labels.contains(label) ? now.labels.filter { $0 != label } : now.labels + [label]
            return replacing(index, Pick(labels: labels, other: now.other))
        }
        return replacing(index, Pick(labels: [label], other: ""))
    }

    /// Words written in Other: in place of the one option picked, or beside several.
    public func writing(_ index: Int, _ text: String) -> TerminalAnswers {
        guard questions.indices.contains(index) else { return self }
        let written = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let labels = !questions[index].multiSelect && written ? [] : picks[index].labels
        return replacing(index, Pick(labels: labels, other: text))
    }

    public func isOn(_ index: Int, _ label: String) -> Bool {
        picks.indices.contains(index) && picks[index].labels.contains(label)
    }

    public func otherOn(_ index: Int) -> Bool {
        picks.indices.contains(index) && !picks[index].other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func answered(_ index: Int) -> Bool {
        picks.indices.contains(index) && (!picks[index].labels.isEmpty || otherOn(index))
    }

    /// Every question has an answer: the card's Submit acts.
    public var complete: Bool { questions.indices.allSatisfy(answered) }

    /// Where the keyboard goes when an answer is missing.
    public var firstUnanswered: Int { questions.indices.first { !answered($0) } ?? 0 }

    /// A number key in question `index`: its option, or Other for the number after the last.
    public func key(_ number: Int, in index: Int) -> Key? {
        guard questions.indices.contains(index), number >= 1 else { return nil }
        let options = questions[index].options
        if number <= options.count { return .pick(options[number - 1].label) }
        return number == options.count + 1 ? .other : nil
    }

    /// The answers as the service takes them: the question's own text → what was picked and written.
    public var body: [String: Answer] {
        Dictionary(questions.enumerated().map { index, question in
            let other = picks[index].other.trimmingCharacters(in: .whitespacesAndNewlines)
            return (question.question, Answer(labels: picks[index].labels, other: other.isEmpty ? nil : other))
        }, uniquingKeysWith: { first, _ in first })
    }
}

/// `GET /folders/git`: a folder's branch and how far it is from clean and from its remote.
public struct FolderGit: Decodable, Equatable, Sendable {
    public let branch: String
    public let changed: Int
    public let ahead: Int
    public let behind: Int

    private enum CodingKeys: String, CodingKey { case branch, changed, ahead, behind }

    public init(branch: String, changed: Int = 0, ahead: Int = 0, behind: Int = 0) {
        self.branch = branch
        self.changed = changed
        self.ahead = ahead
        self.behind = behind
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(branch: try c.decodeIfPresent(String.self, forKey: .branch) ?? "",
                  changed: try c.decodeIfPresent(Int.self, forKey: .changed) ?? 0,
                  ahead: try c.decodeIfPresent(Int.self, forKey: .ahead) ?? 0,
                  behind: try c.decodeIfPresent(Int.self, forKey: .behind) ?? 0)
    }
}

/// The window's short words, as the terminal page says them (terminal.js).
public enum TerminalWindowText {
    /// A path's last component (`AgentSwitch`): the bar's title is the folder the agent works in.
    public static func folder(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// `main ±5 ↑2 ↓1`: only what is not nothing.
    public static func git(_ git: FolderGit) -> String {
        [git.branch, git.changed > 0 ? "±\(git.changed)" : "", git.ahead > 0 ? "↑\(git.ahead)" : "", git.behind > 0 ? "↓\(git.behind)" : ""]
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Mission Control's and the Window menu's name for the window: the folder, and the terminal's name when it has
    /// one of its own.
    public static func title(folder: String, name: String) -> String {
        name.isEmpty || name == folder ? folder : "\(folder) — \(name)"
    }

    /// The line under the output after a reply with secrets in it.
    public static func sealed(_ count: Int) -> String {
        "\(count) \(count == 1 ? "secret" : "secrets") sealed"
    }

    /// The placeholder while the terminal is in use elsewhere (`iphone`, `mac`, else the web console).
    public static func away(_ place: String) -> (head: String, line: String) {
        switch place {
        case "iphone": ("On iPhone", "这个终端正在 iPhone 上使用。")
        case "mac": ("On Mac", "这个终端正在 Mac 的另一个窗口中使用。")
        default: ("On Web", "这个终端正在浏览器中使用。")
        }
    }
}

/// Where a new window of this kind stands: a step down and right of the last one opened (else of the main window's top
/// left corner, else in the middle of the screen); back at the screen's top left once it would run off it.
public enum TerminalWindowPlace {
    public static let step: CGFloat = 28
    public static let size = CGSize(width: 900, height: 600)
    public static let minSize = CGSize(width: 480, height: 300)

    public static func next(after last: CGRect?, size: CGSize, screen: CGRect, beside main: CGRect?) -> CGRect {
        let origin: CGPoint
        if let last {
            origin = CGPoint(x: last.minX + step, y: last.maxY - step - size.height)
        } else if let main {
            origin = CGPoint(x: main.minX + step, y: main.maxY - step - size.height)
        } else {
            return CGRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height)
        }
        let frame = CGRect(origin: origin, size: size)
        guard !screen.contains(frame) else { return frame }
        return CGRect(x: screen.minX + step, y: screen.maxY - step - size.height, width: min(size.width, screen.width - step), height: min(size.height, screen.height - step))
    }
}

/// The window's own keys (terminal.js `shortcut` and its cards' key handlers, natively): what a key press does there,
/// by what has the keyboard — the screen, the sealed reply's field (`inSeal`), another field (`editing`: a question's
/// Other), or the question card (`cardHasKeys`: numbers pick, ⇥ moves on, ↩ submits, the rest goes nowhere).
public enum ItemWindowKey: Equatable, Sendable {
    /// ⌘W: the window closes; its terminal runs on.
    case close
    /// ⌘T: a new terminal, in the main window.
    case newTerminal
    /// ⌘⇧V: the sealed reply's box opens or closes.
    case seal
    /// ⌘↩, or ↩ in the card: the first request allowed, a question submitted.
    case primary
    /// ⌘⌫: the first request denied.
    case deny
    case send
    case closeSeal
    /// ⇧↩ in the sealed reply: a new line.
    case newLine
    /// esc in a question's Other: the keyboard back to the card.
    case leaveField
    /// esc in the card: the keyboard back to the screen.
    case giveKeysBack
    case number(Int)
    /// ⇥ / ⇧⇥: the next question, or the one before.
    case question(Int)
    /// A key the card takes and does nothing with (it is not typed into the terminal behind it).
    case swallow
    /// ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z to the field in focus, by the action's name: there is no Edit menu to send them.
    case edit(String)

    public struct Press: Equatable, Sendable {
        public let key: String
        public let keyCode: UInt16
        public let command: Bool
        public let control: Bool
        public let option: Bool
        public let shift: Bool

        public init(key: String, keyCode: UInt16 = 0, command: Bool = false, control: Bool = false, option: Bool = false, shift: Bool = false) {
            self.key = key
            self.keyCode = keyCode
            self.command = command
            self.control = control
            self.option = option
            self.shift = shift
        }
    }

    static let returnKey: UInt16 = 36, tabKey: UInt16 = 48, deleteKey: UInt16 = 51, escapeKey: UInt16 = 53

    /// Nil: the key is not the window's (it goes on to the screen or the field).
    public static func action(for press: Press, editing: Bool, marking: Bool, inSeal: Bool, cardHasKeys: Bool) -> ItemWindowKey? {
        guard !press.control, !press.option else { return nil }
        if press.command { return command(press, editing: editing, inSeal: inSeal) }
        // An input method's Return and Esc are its own (they take or drop a candidate).
        guard !marking else { return nil }
        switch press.keyCode {
        case escapeKey:
            if inSeal { return .closeSeal }
            if cardHasKeys { return editing ? .leaveField : .giveKeysBack }
            return editing ? .giveKeysBack : nil
        case returnKey:
            if inSeal { return press.shift ? .newLine : .send }
            return editing || cardHasKeys ? .primary : nil
        case tabKey:
            return cardHasKeys && !editing ? .question(press.shift ? -1 : 1) : nil
        default:
            break
        }
        guard cardHasKeys, !editing else { return nil }
        if !press.shift, let number = Int(press.key), (1...9).contains(number) { return .number(number) }
        return .swallow
    }

    private static func command(_ press: Press, editing: Bool, inSeal: Bool) -> ItemWindowKey? {
        if press.shift {
            switch press.key {
            case "v": return .seal
            case "z": return editing ? .edit("redo:") : nil
            default: return nil
            }
        }
        switch press.keyCode {
        case returnKey: return inSeal ? .send : .primary
        // In a field ⌘⌫ deletes to the line's start, as everywhere.
        case deleteKey: return editing ? nil : .deny
        default: break
        }
        switch press.key {
        case "w": return .close
        case "t": return .newTerminal
        case "c": return editing ? .edit("copy:") : nil
        case "v": return editing ? .edit("paste:") : nil
        case "x": return editing ? .edit("cut:") : nil
        case "a": return editing ? .edit("selectAll:") : nil
        case "z": return editing ? .edit("undo:") : nil
        default: return nil
        }
    }
}

extension DaemonError {
    /// 404 in the service's own words: the request was answered elsewhere, the terminal is gone. No error to show.
    public var isGone: Bool {
        if case .http(status: 404, _) = self { return true }
        return false
    }
}

extension DaemonClient {
    /// `GET /terminals/:id`.
    public func terminal(id: String) async throws -> TerminalInfo {
        struct Body: Decodable { let terminal: TerminalInfo }
        return try decode(Body.self, try await call("GET", "/terminals/\(Self.segment(id))")).terminal
    }

    /// `GET /folders/git`: the folders the terminal list shows, by path; one outside a repository is not there.
    public func folderGit() async throws -> [String: FolderGit] {
        struct Body: Decodable { let folders: [String: FolderGit] }
        return try decode(Body.self, try await call("GET", "/folders/git")).folders
    }

    /// A reply through the sealer (`POST /terminals/:id/input`): passwords and tokens in it reach the agent as
    /// ciphertext. Returns how many were sealed.
    @discardableResult
    public func replyToTerminal(id: String, text: String) async throws -> Int {
        struct Reply: Decodable { let sealed: Int? }
        let data = try await call("POST", "/terminals/\(Self.segment(id))/input", body: try JSONEncoder().encode(["text": text]))
        return (try? JSONDecoder().decode(Reply.self, from: data))?.sealed ?? 0
    }

    /// Allow or deny a terminal's request (`POST /terminals/:id/permissions/:pid`).
    public func decideTerminal(id: String, request: String, allow: Bool) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/permissions/\(Self.segment(request))",
                           body: try JSONEncoder().encode(["decision": allow ? "allow" : "deny"]))
    }

    /// A question's answers; what was written in Other goes through the sealer. Returns how many were sealed.
    @discardableResult
    public func answerTerminal(id: String, request: String, answers: [String: TerminalAnswers.Answer]) async throws -> Int {
        struct Body: Encodable { let decision = "allow"; let answers: [String: TerminalAnswers.Answer] }
        struct Reply: Decodable { let sealed: Int? }
        let data = try await call("POST", "/terminals/\(Self.segment(id))/permissions/\(Self.segment(request))",
                                  body: try JSONEncoder().encode(Body(answers: answers)))
        return (try? JSONDecoder().decode(Reply.self, from: data))?.sealed ?? 0
    }
}
