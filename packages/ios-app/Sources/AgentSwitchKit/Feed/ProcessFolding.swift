import Foundation

/// The task page's 过程 list (control-v0 §5): consecutive tool calls fold into one line ("读取 3 个文件，运行 5 条命令"),
/// opened on a tap; a lone call stays its own line, since its own words say more than a count. `tool_result` events
/// are never rows (they belong to their call). A refused call is kept apart: what was stopped should be seen.
public enum ProcessFolding {
    public enum Item: Sendable, Hashable, Identifiable {
        case event(TaskEvent)
        case tools([TaskEvent])

        public var id: String {
            switch self {
            case .event(let e): return e.id
            case .tools(let calls): return "tools:" + (calls.first?.id ?? "")
            }
        }
    }

    /// Folds of at least `minimum` calls; smaller runs stay as they are.
    public static let minimum = 2

    public static func items(_ events: [TaskEvent]) -> [Item] {
        var out: [Item] = []
        var run: [TaskEvent] = []
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

    static func folds(_ event: TaskEvent) -> Bool {
        event.type == "tool_call" && event.payload["denied"] == nil
    }

    /// What kind of work a call is, by its verb (ToolDisplay).
    public enum Kind: Int, Sendable, CaseIterable {
        case read, run, search, edit, browser, other

        init(tool: String) {
            let label = ToolDisplay.label(tool)
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

    /// "读取 3 个文件，运行 5 条命令，搜索 2 次"; `ongoing` (the task still runs and this is its latest fold) says
    /// "正在读取 3 个文件，…".
    public static func summary(_ calls: [TaskEvent], ongoing: Bool = false) -> String {
        var counts: [Kind: Int] = [:]
        var targets: [Kind: Set<String>] = [:]
        for call in calls {
            let kind = Kind(tool: call.payload["tool"]?.string ?? "")
            if kind.countsTargets, let target = ToolDisplay.target(call.payload) {
                if targets[kind, default: []].insert(target).inserted { counts[kind, default: 0] += 1 }
            } else {
                counts[kind, default: 0] += 1
            }
        }
        let clauses = Kind.allCases.compactMap { kind in counts[kind].map { kind.clause($0) } }
        return (ongoing ? "正在" : "") + clauses.joined(separator: "，")
    }
}

/// How long a finished task took (control-v0 §5), for the muted line at the end of 过程.
public enum TaskDuration {
    /// From its first `queued` or `dispatched` event to its end event; without those, created → last change.
    public static func seconds(_ task: AgentTask, events: [TaskEvent]) -> TimeInterval? {
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
}
