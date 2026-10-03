import Foundation

// Topics (threads-v0), the executor catalog for `Pin Model` (`GET /targets`) and task search (`GET /search`), ported
// from the iPhone Kit (API/ServerModels.swift, API/ControlModels.swift).

/// `GET /threads?status=`: which topics to list (History: in progress / archived).
public enum DispatchThreadFilter: String, Sendable, CaseIterable {
    case open, archived, all
}

/// The summarizer's view of a topic (threads-v0 §3), the part the page shows.
public struct DispatchThreadSummary: Decodable, Sendable, Hashable {
    public let title: String?
    public let goal: String?
    public let progress: String?

    public init(title: String? = nil, goal: String? = nil, progress: String? = nil) {
        self.title = title
        self.goal = goal
        self.progress = progress
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(title: c.first(String.self, "title"), goal: c.first(String.self, "goal"), progress: c.first(String.self, "progress"))
    }
}

/// threads/types.ts Thread plus what `GET /threads` folds in (the iPhone's AgentThread).
public struct DispatchThread: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let createdAt: Int64
    public let updatedAt: Int64
    public let title: String?
    public let cwd: String?
    /// `open` or `archived`.
    public let status: String
    /// An archived topic is deleted once this passes (7 days after archiving).
    public let expiresAt: Int64?
    public let summary: DispatchThreadSummary?
    public let lastTarget: DispatchTarget?
    public let lastActivity: Int64?
    public let taskCount: Int
    public let handoffs: Int

    public init(id: String, createdAt: Int64, updatedAt: Int64, title: String? = nil, cwd: String? = nil, status: String = "open",
                expiresAt: Int64? = nil, summary: DispatchThreadSummary? = nil, lastTarget: DispatchTarget? = nil,
                lastActivity: Int64? = nil, taskCount: Int = 0, handoffs: Int = 0) {
        self.id = id
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.title = title
        self.cwd = cwd
        self.status = status
        self.expiresAt = expiresAt
        self.summary = summary
        self.lastTarget = lastTarget
        self.lastActivity = lastActivity
        self.taskCount = taskCount
        self.handoffs = handoffs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(id: try c.require(String.self, "id"), createdAt: c.first(Int64.self, "createdAt") ?? 0,
                  updatedAt: c.first(Int64.self, "updatedAt") ?? 0, title: c.first(String.self, "title"),
                  cwd: c.first(String.self, "cwd"), status: c.first(String.self, "status") ?? "open",
                  expiresAt: c.first(Int64.self, "expiresAt"), summary: c.first(DispatchThreadSummary.self, "summary"),
                  lastTarget: c.first(DispatchTarget.self, "lastTarget"), lastActivity: c.first(Int64.self, "lastActivity"),
                  taskCount: c.first(Int.self, "taskCount") ?? 0, handoffs: c.first(Int.self, "handoffs") ?? 0)
    }

    public var isArchived: Bool { status == "archived" }
    /// The title, else 未命名话题.
    public var displayTitle: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名话题" }
    /// The last thing that happened in it (the list's order and its time).
    public var lastActive: Date { Date(dispatchMilliseconds: lastActivity ?? updatedAt) }

    /// The topic page's meta line: `3 个任务 · Sonnet 5 · 已归档 · 5m ago`.
    public func meta(now: Date = Date(), calendar: Calendar = .current) -> String {
        [String("\(taskCount) 个任务"), lastTarget.map(\.modelName), isArchived ? "已归档" : nil,
         TimeText.moment(lastActive, now: now, calendar: calendar)].compactMap { $0 }.joined(separator: " · ")
    }
}

/// `GET /threads/:id`: the topic, its latest summary and its tasks (oldest first).
public struct DispatchThreadDetail: Decodable, Sendable, Hashable {
    public let thread: DispatchThread
    public let tasks: [DispatchTask]

    public init(thread: DispatchThread, tasks: [DispatchTask]) {
        self.thread = thread
        self.tasks = tasks
    }

    public init(from decoder: Decoder) throws {
        thread = try DispatchThread(from: decoder)
        let listed = try decoder.container(keyedBy: AnyKey.self).first([DispatchTask].self, "tasks") ?? []
        tasks = listed.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    public var summary: DispatchThreadSummary? { thread.summary }
}

/// router/targets.ts ModelSpec, the fields the page needs.
public struct DispatchModelSpec: Decodable, Sendable, Hashable {
    public let cost: String?
    public let strengths: [String]
    public let efforts: [String]?
    public let unavailable: Bool
    public let preferred: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        cost = c.first(String.self, "cost")
        strengths = c.first([String].self, "strengths") ?? []
        efforts = c.first([String].self, "efforts")
        unavailable = c.first(Bool.self, "unavailable") ?? false
        preferred = c.first(Bool.self, "preferred") ?? false
    }
}

/// router/targets.ts HarnessSpec, the fields the page needs.
public struct DispatchHarnessSpec: Decodable, Sendable, Hashable {
    public let browser: Bool
    public let defaultModel: String?
    public let maxConcurrent: Int?
    public let models: [String: DispatchModelSpec]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        browser = c.first(Bool.self, "browser") ?? false
        defaultModel = c.first(String.self, "default_model", "defaultModel")
        maxConcurrent = c.first(Int.self, "max_concurrent", "maxConcurrent")
        models = c.first([String: DispatchModelSpec].self, "models") ?? [:]
    }
}

/// `GET /targets`: the catalog the router picks from, plus `quota` (harness → fraction left).
public struct DispatchTargets: Decodable, Sendable, Hashable {
    public let harnesses: [String: DispatchHarnessSpec]
    /// The router's own model and its default target.
    public let routerModel: DispatchTarget?
    public let defaultTarget: DispatchTarget?
    public let quota: [String: Double]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        harnesses = c.first([String: DispatchHarnessSpec].self, "harnesses") ?? [:]
        let router = c.first(DispatchJSON.self, "router")
        routerModel = Self.target(router)
        defaultTarget = Self.target(router?["default"])
        quota = c.first([String: Double].self, "quota") ?? [:]
    }

    private static func target(_ json: DispatchJSON?) -> DispatchTarget? {
        guard let harness = json?["harness"]?.string, let model = json?["model"]?.string else { return nil }
        return DispatchTarget(harness: harness, model: model)
    }

    /// What a message can be pinned to (`Pin Model`, `Hand to ▾`): every listed model that is not marked unavailable
    /// and is not a `prefix/*` wildcard, sorted by harness then model.
    public var pinOptions: [DispatchTarget] {
        harnesses.keys.sorted().flatMap { name -> [DispatchTarget] in
            let spec = harnesses[name]!
            return spec.models.keys.sorted()
                .filter { spec.models[$0]?.unavailable != true && !$0.hasSuffix("/*") }
                .map { DispatchTarget(harness: name, model: $0) }
        }
    }
}

/// One hit of `GET /search` (control-v0 §4); `snippet` marks the matches with ⟦ and ⟧ (DispatchSearchSnippet).
public struct DispatchSearchResult: Decodable, Sendable, Hashable, Identifiable {
    public let taskId: String
    public let title: String
    public let snippet: String
    public let status: DispatchTaskStatus
    public let updatedAt: Int64

    public init(taskId: String, title: String, snippet: String, status: DispatchTaskStatus, updatedAt: Int64) {
        self.taskId = taskId
        self.title = title
        self.snippet = snippet
        self.status = status
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        self.init(taskId: try c.require(String.self, "taskId"), title: c.first(String.self, "title") ?? "",
                  snippet: c.first(String.self, "snippet") ?? "", status: c.first(DispatchTaskStatus.self, "status") ?? .other(""),
                  updatedAt: c.first(Int64.self, "updatedAt") ?? 0)
    }

    public var id: String { taskId }
    public var updated: Date { Date(dispatchMilliseconds: updatedAt) }
}

/// `GET /search` → `{results}`.
struct DispatchSearchResults: Decodable { let results: [DispatchSearchResult] }
