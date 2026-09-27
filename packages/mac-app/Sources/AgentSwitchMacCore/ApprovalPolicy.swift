import Foundation

/// Who answers an executor's approval requests (docs/control-v0.md §1; the daemon's engine/approvalPolicy.ts).
public enum ApprovalMode: String, CaseIterable, Sendable, Identifiable {
    case manual, scoped, auto, skip

    public var id: String { rawValue }

    /// The interface words of control-v0 §1.
    public var title: String {
        switch self {
        case .manual: return "逐项确认"
        case .scoped: return "自动"
        case .auto: return "全部自动"
        case .skip: return "跳过权限"
        }
    }

    public var summary: String {
        switch self {
        case .manual: return "每项审批均由你确认。"
        case .scoped: return "由调度模型代为批准，勾选的类别仍由你确认。"
        case .auto: return "所有审批均由调度模型代为批准。"
        case .skip: return "执行器的审批请求直接放行，不经任何确认。"
        }
    }

    /// The daemon's default and the first-run wizard's suggestion.
    public static let recommended = ApprovalMode.scoped

    /// Boundaries that hold in every mode, skip included (control-v0 §1 “仍然生效的”).
    public static let alwaysApplies = [
        "禁区不可访问：AgentSwitch 的数据与配置、密钥、本机令牌、浏览器会话",
        "只读步骤只运行只读命令",
        "执行器提出的问题由你回答",
        "Codex 在沙箱中运行",
    ]

    /// The confirmation before switching to skip.
    public static var skipWarning: String {
        "执行器的审批请求将直接放行，不经任何确认。以下限制仍然生效：" + alwaysApplies.joined(separator: "；") + "。"
    }
}

/// A category the user can keep for themselves in scoped mode (`delete`, `git_push`, …) with the daemon's title.
public struct ApprovalCategory: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// `GET /approvals/policy` → `{policy: {mode, human}, categories: [{id, title}]}`; `PUT` answers `{policy}` alone.
public struct ApprovalPolicySettings: Decodable, Equatable, Sendable {
    /// Nil when the daemon reports a mode this app does not know yet; `rawMode` keeps what it said.
    public let mode: ApprovalMode?
    public let rawMode: String
    /// scoped only: the categories the user answers personally.
    public let human: [String]
    public let categories: [ApprovalCategory]

    public init(mode: ApprovalMode, human: [String], categories: [ApprovalCategory]) {
        self.mode = mode
        rawMode = mode.rawValue
        self.human = human
        self.categories = categories
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let policy = (try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("policy"))) ?? c
        rawMode = try policy.require(String.self, "mode")
        mode = ApprovalMode(rawValue: rawMode)
        human = policy.first([String].self, "human") ?? []
        var categories: [ApprovalCategory] = []
        if var list = try? c.nestedUnkeyedContainer(forKey: AnyKey("categories")) {
            while !list.isAtEnd {
                guard let item = try? list.nestedContainer(keyedBy: AnyKey.self) else { break }
                if let id = item.first(String.self, "id") {
                    categories.append(ApprovalCategory(id: id, title: item.first(String.self, "title") ?? id))
                }
            }
        }
        self.categories = categories
    }

    /// A saved policy (the PUT answer has no categories) with the categories already known.
    public func keepingCategories(of previous: ApprovalPolicySettings?) -> ApprovalPolicySettings {
        guard categories.isEmpty, let previous, let mode else { return self }
        return ApprovalPolicySettings(mode: mode, human: human, categories: previous.categories)
    }

    /// The human list with one category turned on or off, in the daemon's category order.
    public func human(setting category: String, on: Bool) -> [String] {
        let chosen = Set(human.filter { $0 != category } + (on ? [category] : []))
        let known = categories.map(\.id)
        return known.filter(chosen.contains) + chosen.filter { !known.contains($0) }.sorted()
    }
}

/// `PUT /approvals/policy {mode, human}`: the human list always goes along, so switching modes never loses it.
public struct ApprovalPolicyUpdate: Encodable, Equatable, Sendable {
    public let mode: String
    public let human: [String]

    public init(mode: ApprovalMode, human: [String]) {
        self.mode = mode.rawValue
        self.human = human
    }
}
