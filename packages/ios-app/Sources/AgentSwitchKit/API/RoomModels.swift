import Foundation

// Chat Room as the Mac gives it (docs/chatroom-v0.md; the service's `api/rooms.ts`): the rooms, a room with its seats
// and what was said, and what the pages make of them — a seat's state in the room's words, who a message still has to
// reach, how the timeline is laid out, the `@name` being typed.

/// A seat's face (§1 头像): five rows of five, `#` lit; one of ten colours. Made on the Mac from the seat's name, so
/// every screen draws the same one.
public struct RoomFace: Decodable, Sendable, Hashable {
    public let rows: [String]
    public let color: Int

    public init(rows: [String], color: Int) {
        self.rows = rows
        self.color = color
    }

    /// The lit cells, column and row.
    public var cells: [(x: Int, y: Int)] {
        rows.prefix(5).enumerated().flatMap { y, row in row.prefix(5).enumerated().compactMap { x, c in c == "#" ? (x, y) : nil } }
    }

    /// The ten face colours, on a dark and on a light ground (the concept page's `--f0…--f9`): none of them a state's
    /// colour, the signal pink or the accent blue.
    public static let colorsDark: [UInt32] = [0xB18CFF, 0xE2C48D, 0x7FE3C0, 0xE08CE8, 0xC3C95A, 0x9DB2D9, 0xF0A585, 0xA3A9F5, 0xEDA0B8, 0x86BFC9]
    public static let colorsLight: [UInt32] = [0x7A4FE0, 0x9A7B3F, 0x1F9A75, 0xB043BC, 0x7C8220, 0x5A719F, 0xC0623A, 0x5560D6, 0xC2557A, 0x2F8496]

    public func rgb(dark: Bool) -> UInt32 {
        let set = dark ? Self.colorsDark : Self.colorsLight
        return set[((color % set.count) + set.count) % set.count]
    }
}

/// A seat's state in the room (§6.1). The first four are the terminal's own; the rest say what is wrong with it.
public enum SeatState: String, Sendable, Hashable, CaseIterable {
    case busy, waiting, idle, exited, reconnecting, limited
    case signedOut = "signed_out"
    case blocked, error, offline

    /// How its mark is drawn. Amber is what needs the user's hands, red what went wrong; what mends itself has no
    /// colour (a spinner while it tries, a dim key while it only waits).
    public enum Mark: Sendable, Hashable { case spinner, amber, ready, ended, red, held }

    public var mark: Mark {
        switch self {
        case .busy, .reconnecting: return .spinner
        case .waiting, .signedOut: return .amber
        case .idle: return .ready
        case .exited: return .ended
        case .blocked, .error: return .red
        case .limited, .offline: return .held
        }
    }

    /// The pixel look's word; the classic look's where it differs (`ClassicWords`: Working, Needs You, Ready, Ended).
    public var word: String {
        switch self {
        case .busy: return "Busy"
        case .waiting: return "Waiting"
        case .idle: return "Idle"
        case .exited: return "Exited"
        case .reconnecting: return "Reconnecting"
        case .limited: return "Limited"
        case .signedOut: return "Signed Out"
        case .blocked: return "Blocked"
        case .error: return "Error"
        case .offline: return "Offline"
        }
    }

    public func word(in look: InterfaceLook) -> String { ClassicWords.word(word, in: look) }

    /// What becomes of a message sent to a seat in this state; nil for the four everyday ones.
    public var says: String? {
        switch self {
        case .reconnecting: return "连不上它的服务，正在重试。发给它的消息先留着，连上之后交给它。"
        case .limited: return "额度用完或被限速。发给它的消息留到恢复之后。"
        case .signedOut: return "登录失效，需要你重新登录。发给它的消息交不了。"
        case .blocked: return "这一轮被模型的安全措施拦下了。发给它的那一条它没能处理。"
        case .error: return "这一轮出错结束。发给它的消息会再试一次。"
        case .offline: return "它所在的节点连不上。发给它的消息留到节点回来。"
        default: return nil
        }
    }

    /// A message for it is kept until it mends itself.
    public var holds: Bool { self == .reconnecting || self == .limited || self == .offline || self == .error }
}

/// A seat's card (§1 名片): no account, no address.
public struct SeatCard: Decodable, Sendable, Hashable {
    public let agent: String
    public let name: String
    public let cwd: String
    public let model: String?
    /// The profile's name; nil: the Mac's own (`Default`).
    public let profile: String?
    public let color: ProfileColor?
    /// How it asks, in its agent's own word.
    public let mode: String?
    /// The node it runs on; nil: the one asked.
    public let node: String?

    private enum CodingKeys: String, CodingKey { case agent, name, cwd, model, profile, color, mode, node }

    public init(agent: String, name: String, cwd: String, model: String? = nil, profile: String? = nil, color: ProfileColor? = nil, mode: String? = nil, node: String? = nil) {
        self.agent = agent
        self.name = name
        self.cwd = cwd
        self.model = model
        self.profile = profile
        self.color = color
        self.mode = mode
        self.node = node
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = (try? c.decode(String.self, forKey: .agent)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        cwd = (try? c.decode(String.self, forKey: .cwd)) ?? ""
        model = (try? c.decodeIfPresent(String.self, forKey: .model)).flatMap { $0 }
        profile = (try? c.decodeIfPresent(String.self, forKey: .profile)).flatMap { $0 }
        color = (try? c.decodeIfPresent(String.self, forKey: .color)).flatMap { $0 }.flatMap(ProfileColor.init(rawValue:))
        mode = (try? c.decodeIfPresent(String.self, forKey: .mode)).flatMap { $0 }
        node = (try? c.decodeIfPresent(String.self, forKey: .node)).flatMap { $0 }
    }
}

public struct RoomSeat: Decodable, Sendable, Hashable, Identifiable {
    /// The user's own seat, in every room.
    public static let you = "you"
    /// Everyone in the room; only the user may write it.
    public static let all = "all"

    /// What others write after `@`; never changes.
    public let handle: String
    public let isUser: Bool
    /// The terminal behind it, on the Mac asked.
    public let terminal: String?
    public let face: RoomFace?
    public let joinedAt: Int64
    public let addedBy: String
    /// Chatroom Kit's one switch (§6).
    public let canAdd: Bool
    /// Started by another session: its switch stays off.
    public let byAgent: Bool
    /// When it left; nil while it sits.
    public let left: Int64?
    /// nil for the user, and for a state this app does not know (shown as it is, no mark).
    public let state: SeatState?
    public let card: SeatCard?

    public var id: String { handle }
    public var here: Bool { left == nil }

    private enum CodingKeys: String, CodingKey { case handle, kind, terminal, face, joinedAt, addedBy, canAdd, byAgent, left, state, card }

    public init(handle: String, isUser: Bool = false, terminal: String? = nil, face: RoomFace? = nil, joinedAt: Int64 = 0, addedBy: String = RoomSeat.you,
                canAdd: Bool = false, byAgent: Bool = false, left: Int64? = nil, state: SeatState? = nil, card: SeatCard? = nil) {
        self.handle = handle
        self.isUser = isUser
        self.terminal = terminal
        self.face = face
        self.joinedAt = joinedAt
        self.addedBy = addedBy
        self.canAdd = canAdd
        self.byAgent = byAgent
        self.left = left
        self.state = state
        self.card = card
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = try c.decode(String.self, forKey: .handle)
        isUser = (try? c.decode(String.self, forKey: .kind)) == "user"
        terminal = (try? c.decodeIfPresent(String.self, forKey: .terminal)).flatMap { $0 }
        face = (try? c.decodeIfPresent(RoomFace.self, forKey: .face)).flatMap { $0 }
        joinedAt = (try? c.decode(Int64.self, forKey: .joinedAt)) ?? 0
        addedBy = (try? c.decode(String.self, forKey: .addedBy)) ?? RoomSeat.you
        canAdd = (try? c.decode(Bool.self, forKey: .canAdd)) ?? false
        byAgent = (try? c.decode(Bool.self, forKey: .byAgent)) ?? false
        left = (try? c.decodeIfPresent(Int64.self, forKey: .left)).flatMap { $0 }
        state = (try? c.decodeIfPresent(String.self, forKey: .state)).flatMap { $0 }.flatMap(SeatState.init(rawValue:))
        card = (try? c.decodeIfPresent(SeatCard.self, forKey: .card)).flatMap { $0 }
    }
}

public struct RoomMessage: Decodable, Sendable, Hashable, Identifiable {
    public let seq: Int
    public let from: String
    /// The seats it is for, by handle; empty: written into the room, waking nobody.
    public let to: [String]
    public let replyTo: Int?
    public let text: String
    /// Milliseconds since 1970.
    public let at: Int64

    public var id: Int { seq }
    public var date: Date { Date(timeIntervalSince1970: TimeInterval(at) / 1000) }

    private enum CodingKeys: String, CodingKey { case seq, from, to, replyTo, text, at }

    public init(seq: Int, from: String, to: [String] = [], replyTo: Int? = nil, text: String, at: Int64 = 0) {
        self.seq = seq
        self.from = from
        self.to = to
        self.replyTo = replyTo
        self.text = text
        self.at = at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        from = try c.decode(String.self, forKey: .from)
        to = (try? c.decode([String].self, forKey: .to)) ?? []
        replyTo = (try? c.decodeIfPresent(Int.self, forKey: .replyTo)).flatMap { $0 }
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        at = (try? c.decode(Int64.self, forKey: .at)) ?? 0
    }
}

/// Where a message is on its way to a seat (§5). Dealt with, there is no receipt.
public enum RoomReceipt: String, Sendable, Hashable {
    case sent, queued, delivered, ended

    public var word: String {
        switch self {
        case .sent: return "Sent"
        case .queued: return "Queued"
        case .delivered: return "Delivered"
        case .ended: return "Ended"
        }
    }

    public var tick: String {
        switch self {
        case .sent: return "·"
        case .queued: return "…"
        case .delivered: return "✓"
        case .ended: return "×"
        }
    }
}

public struct RoomInfo: Decodable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let topic: String
    public let paused: Bool
    public let createdAt: Int64
    public let lastSeq: Int
    public let readSeq: Int

    private enum CodingKeys: String, CodingKey { case id, name, topic, paused, createdAt, lastSeq, readSeq }

    public init(id: String, name: String, topic: String = "", paused: Bool = false, createdAt: Int64 = 0, lastSeq: Int = 0, readSeq: Int = 0) {
        self.id = id
        self.name = name
        self.topic = topic
        self.paused = paused
        self.createdAt = createdAt
        self.lastSeq = lastSeq
        self.readSeq = readSeq
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        topic = (try? c.decode(String.self, forKey: .topic)) ?? ""
        paused = (try? c.decode(Bool.self, forKey: .paused)) ?? false
        createdAt = (try? c.decode(Int64.self, forKey: .createdAt)) ?? 0
        lastSeq = (try? c.decode(Int.self, forKey: .lastSeq)) ?? 0
        readSeq = (try? c.decode(Int.self, forKey: .readSeq)) ?? 0
    }
}

/// A room as its page has it: the seats as they are now, the last messages, and what has not arrived.
public struct RoomDetail: Decodable, Sendable, Hashable {
    public let room: RoomInfo
    public let seats: [RoomSeat]
    public let messages: [RoomMessage]
    /// Message number → handle → where it is.
    public let receipts: [Int: [String: RoomReceipt]]
    /// Why a session named when the room was made could not be seated.
    public let problems: [String]

    private enum CodingKeys: String, CodingKey { case room, seats, messages, receipts, problems }

    public init(room: RoomInfo, seats: [RoomSeat], messages: [RoomMessage] = [], receipts: [Int: [String: RoomReceipt]] = [:], problems: [String] = []) {
        self.room = room
        self.seats = seats
        self.messages = messages
        self.receipts = receipts
        self.problems = problems
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        room = try c.decode(RoomInfo.self, forKey: .room)
        seats = (try? c.decode([RoomSeat].self, forKey: .seats)) ?? []
        messages = (try? c.decode([RoomMessage].self, forKey: .messages)) ?? []
        receipts = RoomDetail.receipts((try? c.decode([String: [String: String]].self, forKey: .receipts)) ?? [:])
        problems = (try? c.decode([String].self, forKey: .problems)) ?? []
    }

    static func receipts(_ raw: [String: [String: String]]) -> [Int: [String: RoomReceipt]] {
        var made: [Int: [String: RoomReceipt]] = [:]
        for (seq, of) in raw {
            guard let n = Int(seq) else { continue }
            let kept = of.compactMapValues(RoomReceipt.init(rawValue:))
            if !kept.isEmpty { made[n] = kept }
        }
        return made
    }

    public func seat(_ handle: String) -> RoomSeat? { seats.first { $0.handle == handle } }
    /// The sessions sitting now, in the order they sat down.
    public var sessions: [RoomSeat] { seats.filter { !$0.isUser && $0.here } }
    public func message(_ seq: Int) -> RoomMessage? { messages.first { $0.seq == seq } }
}

/// A room as the list has it.
public struct RoomSummary: Decodable, Sendable, Hashable, Identifiable {
    public struct Last: Decodable, Sendable, Hashable {
        public let seq: Int
        public let from: String
        public let text: String
        public let at: Int64

        public init(seq: Int, from: String, text: String, at: Int64) {
            self.seq = seq
            self.from = from
            self.text = text
            self.at = at
        }
    }

    public struct Sitter: Decodable, Sendable, Hashable {
        public let handle: String
        public let face: RoomFace?
    }

    public let id: String
    public let name: String
    public let topic: String
    public let paused: Bool
    public let createdAt: Int64
    /// Seats taken, the user's among them.
    public let members: Int
    public let faces: [Sitter]
    public let last: Last?
    /// Messages after what the user has seen; `forYou`: one of them names the user.
    public let unread: Int
    public let forYou: Bool

    private enum CodingKeys: String, CodingKey { case id, name, topic, paused, createdAt, members, faces, last, unread, forYou }

    public init(id: String, name: String, topic: String = "", paused: Bool = false, createdAt: Int64 = 0, members: Int = 1, faces: [Sitter] = [], last: Last? = nil, unread: Int = 0, forYou: Bool = false) {
        self.id = id
        self.name = name
        self.topic = topic
        self.paused = paused
        self.createdAt = createdAt
        self.members = members
        self.faces = faces
        self.last = last
        self.unread = unread
        self.forYou = forYou
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        topic = (try? c.decode(String.self, forKey: .topic)) ?? ""
        paused = (try? c.decode(Bool.self, forKey: .paused)) ?? false
        createdAt = (try? c.decode(Int64.self, forKey: .createdAt)) ?? 0
        members = (try? c.decode(Int.self, forKey: .members)) ?? 1
        faces = (try? c.decode([Sitter].self, forKey: .faces)) ?? []
        last = (try? c.decodeIfPresent(Last.self, forKey: .last)).flatMap { $0 }
        unread = (try? c.decode(Int.self, forKey: .unread)) ?? 0
        forYou = (try? c.decode(Bool.self, forKey: .forYou)) ?? false
    }

    /// The list's second line: who said the last thing and what; the topic before anything was said.
    public var lastLine: String {
        guard let last else { return topic.isEmpty ? "还没有消息" : topic }
        let text = last.text.replacingOccurrences(of: "\n", with: " ")
        return "\(last.from == RoomSeat.you ? "You" : last.from): \(text)"
    }
}

public struct RoomList: Decodable, Sendable, Hashable {
    public let rooms: [RoomSummary]

    public init(rooms: [RoomSummary]) { self.rooms = rooms }

    /// Messages not seen yet, in all rooms: the tab's badge.
    public var unread: Int { rooms.reduce(0) { $0 + $1.unread } }
}

// MARK: - what the pages make of them

/// One line under a message: a seat it has not reached, and where it is.
public struct RoomReceiptLine: Sendable, Hashable, Identifiable {
    public let handle: String
    public let tick: String
    /// `Sent`, `Queued`, `Delivered`, `Ended` — or the seat's own state where that says why (`Reconnecting`, `Signed Out`).
    public let word: String
    /// It can not be given at all.
    public let failed: Bool

    public var id: String { handle }

    /// The lines for one message, in the order its seats sat down. Said only while it matters: a message everyone has
    /// taken has none.
    public static func lines(_ message: RoomMessage, in room: RoomDetail) -> [RoomReceiptLine] {
        guard let of = room.receipts[message.seq], !of.isEmpty else { return [] }
        let order = room.seats.map(\.handle)
        return of.keys.sorted { (order.firstIndex(of: $0) ?? .max, $0) < (order.firstIndex(of: $1) ?? .max, $1) }.map { handle in
            let receipt = of[handle]!
            let state = room.seat(handle)?.state
            var word = receipt.word
            // One that waits says what for; one that could not be handed over says why — the seat's state, in its word.
            if receipt == .queued, let state, state.holds { word = state.word }
            if receipt == .ended, let state, state != .idle, state != .busy, state != .waiting { word = state.word }
            return RoomReceiptLine(handle: handle, tick: receipt.tick, word: word, failed: receipt == .ended)
        }
    }
}

/// The timeline's rows: a speaker's consecutive messages run together under one head; a reply, a new day and a long
/// pause start a new one.
public struct RoomRow: Sendable, Hashable, Identifiable {
    public let message: RoomMessage
    /// It goes on under the head of the one before: no face, no name.
    public let continues: Bool
    /// The first of its day: the day is written above it.
    public let newDay: Bool
    /// The message it answers, when the page has it.
    public let quoted: RoomMessage?

    public var id: Int { message.seq }

    /// Messages further apart than this do not run together.
    public static let gap: TimeInterval = 5 * 60

    public static func rows(_ messages: [RoomMessage], calendar: Calendar = .current) -> [RoomRow] {
        var rows: [RoomRow] = []
        var before: RoomMessage?
        for m in messages {
            let newDay = before.map { !calendar.isDate($0.date, inSameDayAs: m.date) } ?? true
            let continues = !newDay && m.replyTo == nil && before?.from == m.from && m.date.timeIntervalSince(before?.date ?? m.date) < gap
            rows.append(RoomRow(message: m, continues: continues, newDay: newDay, quoted: m.replyTo.flatMap { n in messages.first { $0.seq == n } }))
            before = m
        }
        return rows
    }

    /// A quoted message in one line: no code marks, no `@names`.
    public static func quote(_ text: String) -> String {
        let plain = RoomText.pieces(text, handles: nil).compactMap { piece -> String? in
            switch piece {
            case .text(let s), .code(let s): return s
            case .mention: return nil
            }
        }.joined()
        return plain.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }
}

/// A message's text in pieces: plain words, `code` between backticks, and the `@names` that are seats of the room.
public enum RoomText {
    public enum Piece: Sendable, Hashable {
        case text(String)
        case code(String)
        /// A seat's handle (or `all`), without the `@`.
        case mention(String)
    }

    /// `handles`: the names that count, lower case; nil: every `@name` does. As the service reads them: the `@` stands
    /// at the start or after something that is not part of a word (an e-mail address is not a mention).
    public static func pieces(_ text: String, handles: Set<String>?) -> [Piece] {
        var pieces: [Piece] = []
        var plain = ""
        func flush() { if !plain.isEmpty { pieces.append(.text(plain)); plain = "" } }
        let chars = Array(text)
        var i = 0
        var before: Character?
        while i < chars.count {
            let c = chars[i]
            if c == "`", let end = chars[(i + 1)...].firstIndex(of: "`"), end > i + 1, !chars[(i + 1)..<end].contains("\n") {
                flush()
                pieces.append(.code(String(chars[(i + 1)..<end])))
                before = "`"
                i = end + 1
                continue
            }
            if c == "@", before.map({ !wordly($0) && $0 != "@" && $0 != "." && $0 != "-" }) ?? true, i + 1 < chars.count, chars[i + 1].isLetter || chars[i + 1].isNumber {
                var j = i + 1
                while j < chars.count, wordly(chars[j]) || chars[j] == "-" { j += 1 }
                let name = String(chars[(i + 1)..<j]).lowercased()
                if handles?.contains(name) ?? true {
                    flush()
                    pieces.append(.mention(name))
                    before = chars[j - 1]
                    i = j
                    continue
                }
            }
            plain.append(c)
            before = c
            i += 1
        }
        flush()
        return pieces
    }

    private static func wordly(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }

    /// The names a room's messages may mention: its seats and `all`.
    public static func handles(of seats: [RoomSeat]) -> Set<String> { Set(seats.map(\.handle) + [RoomSeat.all]) }
}

/// The `@name` being typed at the end of the reply box, and the seats it may become.
public enum RoomMention {
    /// What stands after the last `@` when the text ends in one being typed (`"看一下 @da"` → `"da"`, `"@"` → `""`);
    /// nil when it does not.
    public static func query(_ text: String) -> String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex {
            let before = text[text.index(before: at)]
            if before.isLetter || before.isNumber || before == "_" || before == "@" || before == "." || before == "-" { return nil }
        }
        let typed = text[text.index(after: at)...]
        guard typed.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else { return nil }
        return typed.lowercased()
    }

    /// The seats to offer: the sessions sitting whose name starts with what was typed, then `all` (the user's alone).
    public static func offers(_ query: String, seats: [RoomSeat]) -> [String] {
        (seats.filter { !$0.isUser && $0.here }.map(\.handle) + [RoomSeat.all]).filter { $0.hasPrefix(query) }
    }

    /// The text with the `@name` being typed made whole, a space after it.
    public static func complete(_ text: String, with handle: String) -> String {
        guard query(text) != nil, let at = text.lastIndex(of: "@") else { return text }
        return "\(text[..<at])@\(handle) "
    }
}
