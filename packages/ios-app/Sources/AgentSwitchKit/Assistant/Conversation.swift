import Foundation

/// One message of the assistant conversation (assistant-v0 §1.1); the text is sealed (ciphertexts, never plaintext).
public struct AssistantMessage: Decodable, Sendable, Hashable, Identifiable {
    public enum Role: String, Decodable, Sendable { case user, assistant }
    public enum Kind: String, Decodable, Sendable {
        /// `notice`: a task ended; `waiting`: a task waits for you (its card shows the question); `progress`: a
        /// watched task's line; `watch`: the answer that set or stopped a watch.
        case message, reply, task, status, cancel, fallback, notice, waiting, watch, progress, other
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
    /// The phone's id for a message it sent (user messages only): how a send the phone never heard back from is found.
    public let clientId: String?
    /// On an answer: the message it answers.
    public let replyTo: Int?

    public var id: Int { seq }
    public var date: Date { Date(milliseconds: ts) }
    /// A reply that created its tasks (as opposed to one that only talks about them).
    public var createdTasks: Bool { kind == .task || kind == .fallback }
    /// Said by the assistant on its own, not in answer to a message.
    public var unprompted: Bool { kind == .notice || kind == .waiting || kind == .progress }
}

/// The conversation as the phone holds it: each message once, by sequence number, the newest `keep`. Values, not
/// shared state: merging returns a new log.
public struct ConversationLog: Sendable, Equatable {
    public static let keep = 200

    public let messages: [AssistantMessage]
    private let keep: Int

    public init(_ messages: [AssistantMessage] = [], keep: Int = ConversationLog.keep) {
        let unique = Dictionary(messages.map { ($0.seq, $0) }, uniquingKeysWith: { _, newer in newer })
        self.messages = Array(unique.values.sorted { $0.seq < $1.seq }.suffix(keep))
        self.keep = keep
    }

    /// The highest sequence number held: the next poll asks for what came after it.
    public var lastSeq: Int { messages.last?.seq ?? 0 }
    public var isEmpty: Bool { messages.isEmpty }

    public func merging(_ incoming: [AssistantMessage]) -> ConversationLog {
        incoming.isEmpty ? self : ConversationLog(messages + incoming, keep: keep)
    }

    /// Whether the Mac stored the message sent with this client id (a send whose answer was lost on the way).
    public func contains(clientId: String) -> Bool {
        messages.contains { $0.role == .user && $0.clientId == clientId }
    }

    /// The entry `message` belongs to, as a delete takes it (threads-v0 手动删除): a message you sent with every answer to
    /// it, or a line said on its own; with the tasks its answers created.
    public func entry(of message: AssistantMessage) -> ConversationEntry {
        let root = message.role == .user ? message.seq : message.replyTo
        var lines = root.map { root in messages.filter { $0.seq == root || $0.replyTo == root } } ?? []
        if !lines.contains(message) { lines.append(message) }
        var seen = Set<String>()
        let created = lines.filter(\.createdTasks).flatMap(\.taskIds).filter { seen.insert($0).inserted }
        return ConversationEntry(seq: message.seq, seqs: lines.map(\.seq).sorted(), exchange: root != nil, createdTaskIds: created)
    }

    /// Without the lines the Mac no longer has. `recent` is the Mac's newest messages, read whole: a line held here that
    /// is as new as the oldest of them and not among them was taken out there (deleted on the Mac, or an install's
    /// notice a later one replaced). Lines older than what was read are left as they are.
    public func agreeing(with recent: [AssistantMessage]) -> ConversationLog {
        guard let oldest = recent.map(\.seq).min() else { return self }
        let there = Set(recent.map(\.seq))
        let kept = messages.filter { $0.seq < oldest || there.contains($0.seq) }
        return kept.count == messages.count ? self : ConversationLog(kept, keep: keep)
    }

    /// Without these lines (deleted on the Mac); the next full load confirms.
    public func removing(_ seqs: [Int]) -> ConversationLog {
        let gone = Set(seqs)
        return ConversationLog(messages.filter { !gone.contains($0.seq) }, keep: keep)
    }

    /// Assistant messages in `incoming` this log does not hold yet, oldest first (what to sound or read aloud).
    public func newAssistantMessages(in incoming: [AssistantMessage]) -> [AssistantMessage] {
        let known = Set(messages.map(\.seq))
        return incoming.filter { $0.role == .assistant && !known.contains($0.seq) }.sorted { $0.seq < $1.seq }
    }
}

/// One entry of the home screen (ConversationLog.entry): the Mac finds all of it from any one line.
public struct ConversationEntry: Sendable, Hashable {
    /// The line it was chosen by.
    public let seq: Int
    /// The lines the phone holds of it.
    public let seqs: [Int]
    /// A message and its answers, rather than one line said on its own.
    public let exchange: Bool
    /// The tasks its answers created: deleted with it.
    public let createdTaskIds: [String]
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

        /// Said by the assistant on its own (an end, a question, progress).
        var unprompted: Bool {
            if case .assistant(let m, _) = self { return m.unprompted }
            return false
        }

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

    /// A task's end is said once (ui-v0 §7.4): the card has the result, so a "task ended" line right under its card —
    /// nothing but other such lines in between — is left out; further down it stays, as one line (the view's part).
    public static func timeline(messages: [AssistantMessage], tasks: [AgentTask], limit: Int = defaultLimit) -> [Item] {
        let byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let owned = Set(messages.filter(\.createdTasks).flatMap(\.taskIds))
        let talk: [Item] = messages.map { m in
            m.role == .user ? .user(m) : .assistant(m, created: m.createdTasks ? m.taskIds.compactMap { byId[$0] } : [])
        }
        let loose: [Item] = tasks.filter { !owned.contains($0.id) }.map { .task($0) }
        let ordered = (talk + loose).enumerated().sorted { ($0.element.time, $0.offset) < ($1.element.time, $1.offset) }.map(\.element)
        var kept: [Item] = []
        var cardAt: [String: Int] = [:]
        for item in ordered {
            switch item {
            case .assistant(let m, let created):
                if m.kind == .notice, let id = m.taskIds.first, let card = cardAt[id], kept[(card + 1)...].allSatisfy(\.unprompted) { continue }
                for task in created { cardAt[task.id] = kept.count }
            case .task(let task):
                cardAt[task.id] = kept.count
            case .user:
                break
            }
            kept.append(item)
        }
        return Array(kept.suffix(limit))
    }

    /// A fresh id for a new message (not for a resend).
    public static func newClientId() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}
