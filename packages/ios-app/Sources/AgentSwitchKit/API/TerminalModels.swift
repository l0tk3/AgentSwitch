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

    /// The word on screen (docs/ui-v0.md §7.2.7: busy · waiting · idle · exited).
    public var label: String {
        switch self {
        case .working: return "busy"
        case .waiting: return "waiting"
        case .idle: return "idle"
        case .exited: return "exited"
        case .other(let s): return s
        }
    }
}

/// A permission request from the agent's hook, waiting for a screen's answer.
public struct TerminalPermission: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let tool: String
    /// "Bash: rm -rf build", as the Mac shows it.
    public let summary: String
    public let at: Int64

    public init(id: String, tool: String, summary: String, at: Int64 = 0) {
        self.id = id
        self.tool = tool
        self.summary = summary
        self.at = at
    }

    private enum CodingKeys: String, CodingKey { case id, tool, summary, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? ""
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        at = (try? c.decodeIfPresent(Int64.self, forKey: .at)) ?? 0
    }

    /// What it asks, without the tool's name in front ("rm -rf build").
    public var detail: String {
        summary.hasPrefix("\(tool): ") ? String(summary.dropFirst(tool.count + 2)) : summary
    }
}

/// The tool a terminal's agent is using now and what on (a command, a file, a page), as it reported it before use.
public struct TerminalActivity: Decodable, Sendable, Hashable {
    public let tool: String
    public let target: String

    public init(tool: String, target: String) {
        self.tool = tool
        self.target = target
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
    public let model: String?
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

    public init(id: String, harness: String, cwd: String, model: String? = nil, mode: String = "manual", name: String,
                customName: Bool = false, status: TerminalStatus, cols: Int = 80, rows: Int = 24, createdAt: Int64,
                lastOutputAt: Int64, exitCode: Int? = nil, agentSessionId: String? = nil, resumedFrom: String? = nil,
                forked: Bool = false, permissions: [TerminalPermission] = [], activity: TerminalActivity? = nil, statusSince: Int64? = nil) {
        self.id = id
        self.harness = harness
        self.cwd = cwd
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
    }

    private enum CodingKeys: String, CodingKey {
        case id, harness, cwd, model, mode, name, customName, status, cols, rows, createdAt, lastOutputAt, exitCode,
             agentSessionId, resumedFrom, forked, permissions, activity, statusSince
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        harness = (try? c.decodeIfPresent(String.self, forKey: .harness)) ?? ""
        cwd = (try? c.decodeIfPresent(String.self, forKey: .cwd)) ?? ""
        model = try? c.decodeIfPresent(String.self, forKey: .model)
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

    public init(id: String, name: String, description: String? = nil, older: Bool = false) {
        self.id = id
        self.name = name
        self.description = description
        self.older = older
    }

    private enum CodingKeys: String, CodingKey { case id, name, description, older }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        older = try c.decodeIfPresent(Bool.self, forKey: .older) ?? false
    }
}

/// `GET /terminals`: the terminals, the agents this Mac can start, each one's models, and what "default" is today for
/// the agents that say (a Mac that predates it sends none).
public struct TerminalList: Decodable, Sendable, Hashable {
    public let terminals: [TerminalInfo]
    public let agents: [String]
    public let models: [String: [TerminalModelOption]]
    public let defaults: [String: String]

    public init(terminals: [TerminalInfo], agents: [String], models: [String: [TerminalModelOption]] = [:], defaults: [String: String] = [:]) {
        self.terminals = terminals
        self.agents = agents
        self.models = models
        self.defaults = defaults
    }

    private enum CodingKeys: String, CodingKey { case terminals, agents, models, defaults }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        terminals = (try? c.decodeIfPresent([TerminalInfo].self, forKey: .terminals)) ?? []
        agents = (try? c.decodeIfPresent([String].self, forKey: .agents)) ?? []
        models = (try? c.decodeIfPresent([String: [TerminalModelOption]].self, forKey: .models)) ?? [:]
        defaults = (try? c.decodeIfPresent([String: String].self, forKey: .defaults)) ?? [:]
    }
}

/// `POST /terminals`. Bypass is chosen on the Mac only (the daemon answers 403 to a phone).
public struct NewTerminalRequest: Encodable, Sendable, Equatable {
    public let harness: String
    public let cwd: String
    public let model: String?
    public let mode: String?
    public let cols: Int?
    public let rows: Int?

    public init(harness: String, cwd: String, model: String? = nil, mode: String? = nil, cols: Int? = nil, rows: Int? = nil) {
        self.harness = harness
        self.cwd = cwd
        self.model = model
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
}

/// What resuming gave: a new terminal, the one already open here, or the program that has the session open (only one
/// may write it; the caller may fork instead).
public enum ResumeOutcome: Sendable, Equatable {
    case started(TerminalInfo)
    case existing(TerminalInfo)
    case elsewhere(app: String?, pid: Int?)
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

