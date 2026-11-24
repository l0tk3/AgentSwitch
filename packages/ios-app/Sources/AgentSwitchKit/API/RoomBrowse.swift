import Foundation

// The room as the second version of its page reads it (2026-11-24, design-room-ui-v2): what waits on the user in every
// room (等你处理), a page of messages — one task's, a search's, the ones above — with how many there are about each
// task, who has read the user's message, a reply's one-line quote, and what a task has cost.

/// What a seat or a task has cost so far as the room counts it: how often it was woken and with how many characters,
/// how many messages, how many tool calls.
public struct RoomStats: Decodable, Sendable, Hashable {
    public let wakes: Int
    public let chars: Int
    public let posts: Int
    public let calls: Int

    private enum CodingKeys: String, CodingKey { case wakes, chars, posts, calls }

    public init(wakes: Int = 0, chars: Int = 0, posts: Int = 0, calls: Int = 0) {
        self.wakes = wakes
        self.chars = chars
        self.posts = posts
        self.calls = calls
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wakes = (try? c.decode(Int.self, forKey: .wakes)) ?? 0
        chars = (try? c.decode(Int.self, forKey: .chars)) ?? 0
        posts = (try? c.decode(Int.self, forKey: .posts)) ?? 0
        calls = (try? c.decode(Int.self, forKey: .calls)) ?? 0
    }

    public var isEmpty: Bool { wakes == 0 && chars == 0 && posts == 0 && calls == 0 }

    /// `唤醒 3 次 · 1.2 万字 · 8 条消息 · 21 次调用`.
    public var line: String {
        let chars = self.chars >= 10_000 ? String(format: "%.1f 万字", Double(self.chars) / 10_000) : "\(self.chars) 字"
        return "唤醒 \(wakes) 次 · \(chars) · \(posts) 条消息 · \(calls) 次调用"
    }
}

/// One thing that waits on the user's hand (`GET /rooms/attention`).
public struct RoomAttentionItem: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable {
        /// A member's screen asks "do you trust this folder?".
        case trust
        /// A member's screen asks something else from a list.
        case asks
        /// A member waits on a permission.
        case permission
        /// A task is stuck.
        case blocked
        /// A question put to the user, not answered yet.
        case question
        /// Sessions have talked long with no word from the user.
        case rounds
        case other
    }

    public let room: String
    public let roomName: String
    public let kind: Kind
    public let handle: String?
    public let terminal: String?
    public let task: Int?
    public let seq: Int?
    public let text: String
    /// Milliseconds since 1970.
    public let at: Int64

    public var id: String { "\(room)/\(kind.rawValue)/\(handle ?? "")/\(task ?? 0)/\(seq ?? 0)" }
    public var date: Date { Date(timeIntervalSince1970: TimeInterval(at) / 1000) }

    private enum CodingKeys: String, CodingKey { case room, roomName, kind, handle, terminal, task, seq, text, at }

    public init(room: String, roomName: String, kind: Kind, handle: String? = nil, terminal: String? = nil, task: Int? = nil, seq: Int? = nil, text: String = "", at: Int64 = 0) {
        self.room = room
        self.roomName = roomName
        self.kind = kind
        self.handle = handle
        self.terminal = terminal
        self.task = task
        self.seq = seq
        self.text = text
        self.at = at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        room = try c.decode(String.self, forKey: .room)
        roomName = (try? c.decode(String.self, forKey: .roomName)) ?? ""
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(Kind.init(rawValue:)) ?? .other
        handle = (try? c.decodeIfPresent(String.self, forKey: .handle)).flatMap { $0 }
        terminal = (try? c.decodeIfPresent(String.self, forKey: .terminal)).flatMap { $0 }
        task = (try? c.decodeIfPresent(Int.self, forKey: .task)).flatMap { $0 }
        seq = (try? c.decodeIfPresent(Int.self, forKey: .seq)).flatMap { $0 }
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        at = (try? c.decode(Int64.self, forKey: .at)) ?? 0
    }

    /// It is a thing to do with the user's hands now (amber), not only to read.
    public var urgent: Bool { kind == .trust || kind == .asks || kind == .permission || kind == .blocked }

    /// Its line in the list, in the room's words: `⚠ ios 等你确认权限`, `T4 卡住：等字段名`, `api 问你：…`, `会话间已聊 7 条`.
    public var line: String {
        let who = handle.map { $0 == RoomSeat.you ? "你" : $0 } ?? "成员"
        let said = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        switch kind {
        case .trust: return "⚠ \(who) 等你信任文件夹"
        case .asks: return said.isEmpty ? "⚠ \(who) 的屏幕在等你选择" : "⚠ \(who) 在问：\(said)"
        case .permission: return "⚠ \(who) 等你确认权限"
        case .blocked: return "⚠ T\(task ?? 0) 卡住：\(said)"
        case .question: return "\(task.map { "T\($0) · " } ?? "")\(who) 问你：\(said)"
        case .rounds: return "会话间已聊 \(Int(said) ?? 0) 条，没有你参与"
        case .other: return said.isEmpty ? "有事等你处理" : said
        }
    }
}

/// `GET /rooms/attention`: newest first.
public struct RoomAttention: Decodable, Sendable, Hashable {
    public let items: [RoomAttentionItem]

    private enum CodingKeys: String, CodingKey { case items }

    public init(items: [RoomAttentionItem]) { self.items = items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decode([RoomAttentionItem].self, forKey: .items)) ?? []
    }
}

/// `GET /rooms/:id/messages`: some of what was said — oldest first, or for a search newest first — and how many
/// messages since `since` are about each task.
public struct RoomMessagePage: Decodable, Sendable, Hashable {
    public let messages: [RoomMessage]
    public let byTask: [Int: Int]

    private enum CodingKeys: String, CodingKey { case messages, byTask }

    public init(messages: [RoomMessage], byTask: [Int: Int] = [:]) {
        self.messages = messages
        self.byTask = byTask
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = (try? c.decode([RoomMessage].self, forKey: .messages)) ?? []
        byTask = ((try? c.decode([String: Int].self, forKey: .byTask)) ?? [:]).reduce(into: [:]) { out, e in if let n = Int(e.key) { out[n] = e.value } }
    }

    /// The same counts from messages the page has (a Mac that has no route for them, the sample screens).
    public static func byTask(_ messages: [RoomMessage], since: Int) -> [Int: Int] {
        messages.reduce(into: [:]) { out, m in if m.seq > since, let t = m.task { out[t, default: 0] += 1 } }
    }
}

/// What the Mac says of a member taken out of the room: `closed`, its terminal was closed; `handingOver`, it was asked
/// for its handover note first and is ended once that is written (two minutes at most).
public struct RoomUnseated: Decodable, Sendable, Hashable {
    public let closed: Bool
    public let handingOver: Bool

    private enum CodingKeys: String, CodingKey { case closed, handingOver }

    public init(closed: Bool = false, handingOver: Bool = false) {
        self.closed = closed
        self.handingOver = handingOver
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        closed = (try? c.decode(Bool.self, forKey: .closed)) ?? false
        handingOver = (try? c.decode(Bool.self, forKey: .handingOver)) ?? false
    }
}

/// How a seat is taken out (`DELETE /rooms/:id/seats/:handle?close=`).
public enum RoomSeatClose: String, Sendable, Hashable {
    /// Its terminal closed too; its conversation kept and resumable.
    case end
    /// And its conversation's record deleted.
    case delete
}

/// Who has read one of the user's messages (user #191: 回执只显示几个已读，长按看是谁): of the sessions it was for and
/// that still sit here, the ones that read it and the ones that have not yet. Empty for a message that is not the
/// user's or was for nobody.
public struct RoomReaders: Sendable, Hashable {
    public let read: [String]
    public let unread: [String]

    public var total: Int { read.count + unread.count }
    /// `2/3 已读`.
    public var word: String { "\(read.count)/\(total) 已读" }

    public static func of(_ message: RoomMessage, in room: RoomDetail) -> RoomReaders {
        guard message.from == RoomSeat.you else { return RoomReaders(read: [], unread: []) }
        let here = Set(room.sessions.map(\.handle))
        let asked = message.to.filter { here.contains($0) && $0 != message.from }
        // Who read what is kept for the newest few hundred: what is older counts as read by everyone.
        let old = message.seq <= room.room.lastSeq - 300
        let read = Set(room.reads[message.seq] ?? [])
        return RoomReaders(read: asked.filter { old || read.contains($0) }, unread: asked.filter { !old && !read.contains($0) })
    }
}

extension RoomRow {
    /// A reply's one-line quote (design v2): the message it answers in its first `limit` characters, its Markdown kept
    /// (bold, `code`) and closed where the cut left one open; new lines become spaces.
    public static func quoteLine(_ text: String, limit: Int = 60) -> String {
        var line = text.replacingOccurrences(of: "\n", with: " ")
        while line.contains("  ") { line = line.replacingOccurrences(of: "  ", with: " ") }
        line = line.trimmingCharacters(in: .whitespaces)
        guard line.count > limit else { return line }
        var cut = String(line.prefix(limit))
        if cut.filter({ $0 == "`" }).count % 2 == 1 { cut += "`" }
        // Outside code: an unpaired `**` is closed.
        let outside = cut.split(separator: "`", omittingEmptySubsequences: false).enumerated().filter { $0.offset % 2 == 0 }.map(\.element).joined()
        if outside.components(separatedBy: "**").count % 2 == 0 { cut += "**" }
        return cut + "…"
    }
}

/// A search's hit in a line (design v2): a little before it, the words found, a little after.
public struct RoomSnippet: Sendable, Hashable {
    public let before: String
    public let hit: String
    public let after: String

    /// `around`: how many characters each side. Matched without case; when the words are not in the text (the
    /// service matched them otherwise), its beginning.
    public static func of(_ text: String, query: String, around: Int = 24) -> RoomSnippet {
        // Read as words: no Markdown marks.
        let flat = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let range = flat.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) else {
            return RoomSnippet(before: "", hit: "", after: flat.count > around * 3 ? String(flat.prefix(around * 3)) + "…" : flat)
        }
        let head = flat[..<range.lowerBound], tail = flat[range.upperBound...]
        let before = head.count > around ? "…" + String(head.suffix(around)) : String(head)
        let after = tail.count > around ? String(tail.prefix(around)) + "…" : String(tail)
        return RoomSnippet(before: before, hit: String(flat[range]), after: after)
    }
}

extension RoomMessage {
    /// A message written in the room's whole timeline that begins with a task's name (`T3 …`): about that task, as
    /// the design has it (要指定就在开头打 T3). nil when it does not, or there is no such task.
    public static func taskNamed(at start: String, tasks: [RoomTask]) -> Int? {
        let text = start.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.first == "T" || text.first == "t" else { return nil }
        let digits = text.dropFirst().prefix { $0.isNumber }
        guard !digits.isEmpty, let n = Int(digits) else { return nil }
        let rest = text.dropFirst(1 + digits.count)
        guard rest.isEmpty || rest.first!.isWhitespace || rest.first == ":" || rest.first == "：" else { return nil }
        return tasks.contains { $0.n == n } ? n : nil
    }
}
