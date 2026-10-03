import Foundation

// The assistant conversation (assistant-v0 §1.1, daemon assistant/log.ts), ported from the iPhone Kit
// (Assistant/Conversation.swift): the messages, the log the page holds, an entry as a delete takes it, what the input
// box sends and what comes back.

/// One message of the conversation; the text is sealed (ciphertexts, never plaintext): show it through
/// DispatchMessageDisplay.
public struct DispatchMessage: Decodable, Sendable, Hashable, Identifiable {
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
    /// The client's id for a message it sent (user messages only): how a send never heard back from is found.
    public let clientId: String?
    /// On an answer: the message it answers.
    public let replyTo: Int?

    public init(seq: Int, ts: Int64, role: Role, text: String, kind: Kind, taskIds: [String] = [], clientId: String? = nil,
                replyTo: Int? = nil) {
        self.seq = seq
        self.ts = ts
        self.role = role
        self.text = text
        self.kind = kind
        self.taskIds = taskIds
        self.clientId = clientId
        self.replyTo = replyTo
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let role = c.first(String.self, "role").flatMap(Role.init(rawValue:)) ?? .assistant
        self.init(seq: try c.require(Int.self, "seq"), ts: c.first(Int64.self, "ts") ?? 0, role: role,
                  text: c.first(String.self, "text") ?? "",
                  kind: c.first(Kind.self, "kind") ?? (role == .user ? .message : .other),
                  taskIds: c.first([String].self, "taskIds") ?? [], clientId: c.first(String.self, "clientId"),
                  replyTo: c.first(Int.self, "replyTo"))
    }

    public var id: Int { seq }
    public var date: Date { Date(dispatchMilliseconds: ts) }
    /// A reply that created its tasks (as opposed to one that only talks about them).
    public var createdTasks: Bool { kind == .task || kind == .fallback }
    /// Said by the assistant on its own, not in answer to a message.
    public var unprompted: Bool { kind == .notice || kind == .waiting || kind == .progress }
    /// An answer to what you asked (not a task created, not a report): it gets a visible `Read Aloud` under it.
    public var isAnswer: Bool { kind == .reply || kind == .status }
}

/// The conversation as the page holds it: each message once, by sequence number, the newest `keep`. A value: merging
/// returns a new log.
public struct DispatchConversationLog: Sendable, Equatable {
    public static let keep = 200

    public let messages: [DispatchMessage]
    private let keep: Int

    public init(_ messages: [DispatchMessage] = [], keep: Int = DispatchConversationLog.keep) {
        let unique = Dictionary(messages.map { ($0.seq, $0) }, uniquingKeysWith: { _, newer in newer })
        self.messages = Array(unique.values.sorted { $0.seq < $1.seq }.suffix(keep))
        self.keep = keep
    }

    /// The highest sequence number held: the next poll asks for what came after it.
    public var lastSeq: Int { messages.last?.seq ?? 0 }
    public var isEmpty: Bool { messages.isEmpty }

    public func merging(_ incoming: [DispatchMessage]) -> DispatchConversationLog {
        incoming.isEmpty ? self : DispatchConversationLog(messages + incoming, keep: keep)
    }

    /// Whether the Mac stored the message sent with this client id (a send whose answer was lost on the way).
    public func contains(clientId: String) -> Bool {
        messages.contains { $0.role == .user && $0.clientId == clientId }
    }

    /// The entry `message` belongs to, as a delete takes it (threads-v0 手动删除): a message you sent with every answer to
    /// it, or a line said on its own; with the tasks its answers created.
    public func entry(of message: DispatchMessage) -> DispatchConversationEntry {
        let root = message.role == .user ? message.seq : message.replyTo
        var lines = root.map { root in messages.filter { $0.seq == root || $0.replyTo == root } } ?? []
        if !lines.contains(message) { lines.append(message) }
        var seen = Set<String>()
        let created = lines.filter(\.createdTasks).flatMap(\.taskIds).filter { seen.insert($0).inserted }
        return DispatchConversationEntry(seq: message.seq, seqs: lines.map(\.seq).sorted(), exchange: root != nil, createdTaskIds: created)
    }

    /// Without these lines (deleted on the Mac); the next full load confirms.
    public func removing(_ seqs: [Int]) -> DispatchConversationLog {
        let gone = Set(seqs)
        return DispatchConversationLog(messages.filter { !gone.contains($0.seq) }, keep: keep)
    }

    /// Assistant messages in `incoming` this log does not hold yet, oldest first (what to sound or read aloud).
    public func newAssistantMessages(in incoming: [DispatchMessage]) -> [DispatchMessage] {
        let known = Set(messages.map(\.seq))
        return incoming.filter { $0.role == .assistant && !known.contains($0.seq) }.sorted { $0.seq < $1.seq }
    }
}

/// One entry of the record (DispatchConversationLog.entry): the Mac finds all of it from any one line.
public struct DispatchConversationEntry: Sendable, Hashable {
    /// The line it was chosen by: what `DELETE /assistant/:seq` takes.
    public let seq: Int
    /// The lines the page holds of it.
    public let seqs: [Int]
    /// A message and its answers, rather than one line said on its own.
    public let exchange: Bool
    /// The tasks its answers created: deleted with it.
    public let createdTaskIds: [String]

    public init(seq: Int, seqs: [Int], exchange: Bool, createdTaskIds: [String]) {
        self.seq = seq
        self.seqs = seqs
        self.exchange = exchange
        self.createdTaskIds = createdTaskIds
    }
}

/// `POST /assistant`: the stored message, the answer, and the task when one was created.
public struct DispatchAssistantReply: Decodable, Sendable, Hashable {
    public let user: DispatchMessage
    public let assistant: DispatchMessage
    public let task: DispatchTask?

    public init(user: DispatchMessage, assistant: DispatchMessage, task: DispatchTask? = nil) {
        self.user = user
        self.assistant = assistant
        self.task = task
    }
}

/// `GET /assistant` → `{messages}`.
struct DispatchMessageList: Decodable { let messages: [DispatchMessage] }

/// What the input box sends (`POST /assistant`, as the phone sends it). The client id stays the same across a resend,
/// so the Mac acts on it once. Attachments are `POST /uploads` ids; `pin` is `Pin Model`.
public struct DispatchNewMessage: Encodable, Sendable, Hashable {
    public let text: String
    public let clientId: String
    public let attachments: [String]?
    public let pin: DispatchTarget?

    /// The daemon's limit (api/assistant.ts MAX_MESSAGE_CHARS), in UTF-16 units (DispatchLimits).
    public static let maxCharacters = DispatchLimits.message
    /// What is sent when only files are (the phone's attachments-only task).
    public static let attachmentsOnlyText = "请查看附件。"

    public init(text: String, clientId: String = DispatchNewMessage.newClientId(), attachments: [String]? = nil,
                pin: DispatchTarget? = nil) {
        self.text = text
        self.clientId = clientId
        self.attachments = attachments?.isEmpty == true ? nil : attachments
        self.pin = pin
    }

    /// The same message with the staged upload ids (a resend keeps the client id and does not upload again).
    public func staging(_ ids: [String]) -> DispatchNewMessage {
        DispatchNewMessage(text: text, clientId: clientId, attachments: ids, pin: pin)
    }

    /// A fresh id for a new message (not for a resend): `[A-Za-z0-9_-]{8,64}` as the daemon requires.
    public static func newClientId() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    /// The text to send for what was typed with `files` attached; nil when there is nothing to send.
    public static func text(typed: String, hasAttachments: Bool) -> String? {
        let written = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if written.isEmpty { return hasAttachments ? attachmentsOnlyText : nil }
        return written
    }

    private enum CodingKeys: String, CodingKey { case text, clientId = "client_id", attachments, pin }
}
