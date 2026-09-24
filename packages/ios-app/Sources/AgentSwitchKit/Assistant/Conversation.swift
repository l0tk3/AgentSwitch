import Foundation

/// One message of the assistant conversation (assistant-v0 §1.1); the text is sealed (ciphertexts, never plaintext).
public struct AssistantMessage: Decodable, Sendable, Hashable, Identifiable {
    public enum Role: String, Decodable, Sendable { case user, assistant }
    public enum Kind: String, Decodable, Sendable {
        case message, reply, task, status, cancel, fallback, notice, other
        public init(from decoder: Decoder) throws {
            self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
        }
    }

    public let seq: Int
    public let ts: Int64
    public let role: Role
    public let text: String
    public let kind: Kind
    public let taskIds: [String]

    public var id: Int { seq }
    public var date: Date { Date(milliseconds: ts) }
    /// A reply that created its tasks (as opposed to one that only talks about them).
    public var createdTasks: Bool { kind == .task || kind == .fallback }
}

/// `POST /assistant`: the stored message, the answer, and the task when one was created.
public struct AssistantReply: Decodable, Sendable {
    public let user: AssistantMessage
    public let assistant: AssistantMessage
    public let task: AgentTask?
}

struct AssistantMessages: Decodable { let messages: [AssistantMessage] }

/// What the input box sends. The client id stays the same across a resend, so the Mac acts on it once.
public struct NewMessage: Encodable, Sendable {
    public let text: String
    public let clientId: String
    public let attachments: [String]?
    public let pin: TargetRef?

    public init(text: String, clientId: String, attachments: [String]? = nil, pin: TargetRef? = nil) {
        self.text = text
        self.clientId = clientId
        self.attachments = attachments?.isEmpty == true ? nil : attachments
        self.pin = pin
    }

    private enum CodingKeys: String, CodingKey { case text, clientId = "client_id", attachments, pin }
}

/// The home screen's timeline: the conversation, each task under the reply that created it, and tasks created
/// elsewhere (the web console, before the assistant) on their own, all by time.
public enum Conversation {
    public enum Item: Sendable, Hashable, Identifiable {
        case user(AssistantMessage)
        case assistant(AssistantMessage, created: [AgentTask])
        case task(AgentTask)

        public var id: String {
            switch self {
            case .user(let m), .assistant(let m, _): return "m\(m.seq)"
            case .task(let t): return "task-\(t.id)"
            }
        }

        /// Tasks an answer talks about without owning them (a status or a cancel), for small links.
        public var mentions: [String] {
            guard case .assistant(let m, _) = self, !m.createdTasks else { return [] }
            return m.taskIds
        }

        var time: Int64 {
            switch self {
            case .user(let m), .assistant(let m, _): return m.ts
            case .task(let t): return t.createdAt
            }
        }
    }

    public static let defaultLimit = 60

    public static func timeline(messages: [AssistantMessage], tasks: [AgentTask], limit: Int = defaultLimit) -> [Item] {
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let owned = Set(messages.filter(\.createdTasks).flatMap(\.taskIds))
        let talk: [Item] = messages.map { m in
            m.role == .user ? .user(m) : .assistant(m, created: m.createdTasks ? m.taskIds.compactMap { byId[$0] } : [])
        }
        let loose: [Item] = tasks.filter { !owned.contains($0.id) }.map { .task($0) }
        let ordered = (talk + loose).enumerated().sorted { ($0.element.time, $0.offset) < ($1.element.time, $1.offset) }.map(\.element)
        return Array(ordered.suffix(limit))
    }

    /// A fresh id for a new message (not for a resend).
    public static func newClientId() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
