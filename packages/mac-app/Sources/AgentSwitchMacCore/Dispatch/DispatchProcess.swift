import Foundation

/// The task page's `// Process` list (control-v0 §5; ported from the Kit's ProcessFolding and the phone's ToolGroupRow):
/// consecutive tool calls fold into one line ("读取 3 个文件，运行 5 条命令"), opened on a click; a lone call stays its own
/// line, since its own words say more than a count. `tool_result` events are never rows (they belong to their call). A
/// refused call is kept apart: what was stopped should be seen.
public enum DispatchProcess {
    public enum Item: Sendable, Hashable, Identifiable {
        case event(DispatchTaskEvent)
        case tools([DispatchTaskEvent])

        public var id: String {
            switch self {
            case .event(let e): return e.id
            case .tools(let calls): return "tools:" + (calls.first?.id ?? "")
            }
        }
    }

    /// Folds of at least `minimum` calls; smaller runs stay as they are.
    public static let minimum = 2

    public static func items(_ events: [DispatchTaskEvent]) -> [Item] {
        var out: [Item] = []
        var run: [DispatchTaskEvent] = []
        func flush() {
            if run.count >= minimum { out.append(.tools(run)) } else { out.append(contentsOf: run.map(Item.event)) }
            run = []
        }
        for event in events where event.type != "tool_result" {
            if folds(event) { run.append(event) } else { flush(); out.append(.event(event)) }
        }
        flush()
        return out
    }

    static func folds(_ event: DispatchTaskEvent) -> Bool {
        event.type == "tool_call" && event.payload["denied"] == nil
    }

    /// Whether `item` is still going: the task runs and nothing came after it (its fold says 正在…).
    public static func isOngoing(_ item: Item, in items: [Item], taskActive: Bool) -> Bool {
        taskActive && item.id == items.last?.id
    }

    /// The `tool_result` of each call, by the call's id (the first one wins).
    public static func results(_ events: [DispatchTaskEvent]) -> [String: DispatchTaskEvent] {
        Dictionary(events.filter { $0.type == "tool_result" }.compactMap { e in e.payload["id"]?.string.map { ($0, e) } },
                   uniquingKeysWith: { first, _ in first })
    }

    /// How many calls of a fold failed (`，2 次失败` after its summary).
    public static func failures(_ calls: [DispatchTaskEvent], results: [String: DispatchTaskEvent]) -> Int {
        calls.filter { DispatchToolCall(event: $0, results: results).failed }.count
    }

    /// What kind of work a call is, by its verb (DispatchToolDisplay).
    public enum Kind: Int, Sendable, CaseIterable {
        case read, run, search, edit, browser, other

        init(tool: String) {
            let label = DispatchToolDisplay.label(tool)
            switch label {
            case "读取": self = .read
            case "运行": self = .run
            case "搜索", "查找文件": self = .search
            case "修改", "写入", "修改笔记本": self = .edit
            default: self = label.hasPrefix("浏览器 · ") ? .browser : .other
            }
        }

        /// Files count once each, however often they were read or changed.
        var countsTargets: Bool { self == .read || self == .edit }

        func clause(_ n: Int) -> String {
            switch self {
            case .read: return "读取 \(n) 个文件"
            case .run: return "运行 \(n) 条命令"
            case .search: return "搜索 \(n) 次"
            case .edit: return "修改 \(n) 个文件"
            case .browser: return "浏览器操作 \(n) 次"
            case .other: return "调用工具 \(n) 次"
            }
        }
    }

    /// "读取 3 个文件，运行 5 条命令，搜索 2 次"; `ongoing` says "正在读取 3 个文件，…".
    public static func summary(_ calls: [DispatchTaskEvent], ongoing: Bool = false) -> String {
        var counts: [Kind: Int] = [:]
        var targets: [Kind: Set<String>] = [:]
        for call in calls {
            let kind = Kind(tool: call.payload["tool"]?.string ?? "")
            if kind.countsTargets, let target = DispatchToolDisplay.target(call.payload) {
                if targets[kind, default: []].insert(target).inserted { counts[kind, default: 0] += 1 }
            } else {
                counts[kind, default: 0] += 1
            }
        }
        let clauses = Kind.allCases.compactMap { kind in counts[kind].map { kind.clause($0) } }
        return (ongoing ? "正在" : "") + clauses.joined(separator: "，")
    }

    /// Model-written lines (its text, the final result or error) are Markdown; the daemon's own lines (tool calls,
    /// routing) stay plain, so a `*` in a command is never taken for emphasis.
    public static let markdownTypes: Set<String> = ["text", "done", "partial", "blocked", "failed"]

    public static func isMarkdown(_ event: DispatchTaskEvent) -> Bool { markdownTypes.contains(event.type) }
}

/// One tool call of the process (the phone's ToolCallRow): one line that opens to its input field by field and what
/// came back. The result is the `tool_result` event with the same id (Claude, Codex) or the call's own `output`
/// (OpenCode, which reports a call once it finished).
public struct DispatchToolCall: Sendable, Hashable {
    public let event: DispatchTaskEvent
    public let result: DispatchTaskEvent?

    public init(event: DispatchTaskEvent, result: DispatchTaskEvent?) {
        self.event = event
        self.result = result
    }

    public init(event: DispatchTaskEvent, results: [String: DispatchTaskEvent]) {
        self.init(event: event, result: event.payload["id"]?.string.flatMap { results[$0] })
    }

    /// A call with something to show: its input or command (not a refused one, not an old bare count).
    public static func opens(_ event: DispatchTaskEvent) -> Bool {
        event.type == "tool_call" && event.payload["denied"] == nil && (event.payload["input"] != nil || event.payload["command"]?.string != nil)
    }

    public var line: String { DispatchEventDescriber.line(event) }

    public var failed: Bool { result?.payload["ok"]?.bool == false || event.payload["error"]?.string != nil }

    /// The row's mark: busy while the task runs and nothing came back, failed, done, or unknown (it ended without a
    /// result).
    public func level(taskActive: Bool) -> StatusLevel {
        if failed { return .error }
        if result != nil || event.payload["output"] != nil { return .ok }
        return taskActive ? .busy : .off
    }

    /// How long it took, once it came back (`0.1s`, `58s`).
    public var duration: String? {
        guard let result, result.ts >= event.ts else { return nil }
        return DispatchClock.short(seconds: TimeInterval(result.ts - event.ts) / 1000)
    }

    /// The opened call's input, field by field, keys as words (`File`, `Command`); a plain command when there is no input.
    public var fields: [(name: String, value: String)] {
        let input = DispatchToolDisplay.fields(event.payload["input"])
        let raw = input.isEmpty ? (event.payload["command"]?.string.map { [("Command", DispatchEventDescriber.unwrapShell($0))] } ?? []) : input
        return raw.map { (Self.name($0.name), DispatchMessageDisplay.readable($0.value)) }
    }

    /// What came back: `Result` / `Result · Failed` / `Error`, its text, and whether it is only a placeholder (faint).
    public func outcome(taskActive: Bool) -> (title: String, text: String, faint: Bool) {
        if let error = event.payload["error"]?.string { return ("Error", DispatchMessageDisplay.readable(error), false) }
        let output = result?.payload["output"]?.string ?? event.payload["output"]?.string
        if let output {
            return (failed ? "Result · Failed" : "Result", output.isEmpty ? "No Output" : DispatchMessageDisplay.readable(output), output.isEmpty)
        }
        return ("Result", taskActive ? "Busy" : "None", true)
    }

    /// Input keys as words; unknown ones stay as the tool named them.
    public static func name(_ key: String) -> String { names[key] ?? key }

    private static let names = [
        // Short words in English (docs/ui-v0.md §7.2.7), the tools' own names where they read well.
        "command": "Command", "description": "About", "file_path": "File", "filePath": "File", "notebook_path": "File", "path": "Path",
        "url": "URL", "pattern": "Pattern", "query": "Query", "element": "Element", "ref": "Ref", "text": "Text", "timeout": "Timeout",
        "content": "Content", "old_string": "Old", "new_string": "New", "replace_all": "Replace All", "offset": "From Line",
        "limit": "Lines", "glob": "Files", "output_mode": "Output", "prompt": "Prompt", "subagent_type": "Agent Type",
        "files": "Files", "key": "Key", "values": "Values", "time": "Time", "filename": "File", "skill": "Skill",
    ]
}

/// How long a finished task took (control-v0 §5), for the muted line at the end of the process.
public enum DispatchTaskDuration {
    /// From its first `queued` or `dispatched` event to its end event; without those, created → last change.
    public static func seconds(_ task: DispatchTask, events: [DispatchTaskEvent]) -> TimeInterval? {
        guard task.status.isTerminal else { return nil }
        let start = events.first { $0.type == "queued" || $0.type == "dispatched" }?.ts ?? task.createdAt
        let end = events.first(where: \.endsStream)?.ts ?? task.updatedAt
        guard end >= start else { return nil }
        return TimeInterval(end - start) / 1000
    }

    /// 用时 45 秒 · 用时 2 分 13 秒 · 用时 1 小时 5 分.
    public static func text(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60)
        if h > 0 { return m > 0 ? "用时 \(h) 小时 \(m) 分" : "用时 \(h) 小时" }
        if m > 0 { return s > 0 ? "用时 \(m) 分 \(s) 秒" : "用时 \(m) 分" }
        return "用时 \(max(s, 1)) 秒"
    }

    /// The line under the process, or nil (still running; or stopped by a restart, whose end is not when it finished).
    public static func line(_ task: DispatchTask, events: [DispatchTaskEvent]) -> String? {
        guard !task.isInterrupted, let seconds = seconds(task, events: events) else { return nil }
        return text(seconds)
    }
}
