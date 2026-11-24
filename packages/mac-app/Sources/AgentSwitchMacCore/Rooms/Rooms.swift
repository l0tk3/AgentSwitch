import Foundation

// Chat Room as the service gives it (docs/chatroom-v0.md §1–§6, `packages/daemon/src/api/rooms.ts`): the rooms, a room
// with its seats and what was said, and what the user does in one. Beside the shapes, what the page decides without
// AppKit: a state's word and tone, a receipt's line, which messages run together, the `@names` in a text.

// MARK: - shapes

/// A seat's face (§1 头像): five rows of five, `#` lit; one of ten colours. Made by the service, kept with the seat.
public struct RoomFace: Decodable, Equatable, Sendable {
    public let rows: [String]
    public let color: Int

    public init(rows: [String], color: Int) {
        self.rows = rows
        self.color = color
    }

    /// The lit cells, a face of anything but five rows of five drawn as nothing.
    public var cells: [(x: Int, y: Int)] {
        guard rows.count == 5, rows.allSatisfy({ $0.count == 5 }) else { return [] }
        return rows.enumerated().flatMap { y, row in row.enumerated().compactMap { x, c in c == "#" ? (x, y) : nil } }
    }

    /// The ten colours a face comes in (the concept page's `--f0…--f9`): soft, each clear of the state colours, the
    /// signal and the accent, so a face's colour is never read as a state.
    public static let dark: [UInt32] = [0xB18CFF, 0xE2C48D, 0x7FE3C0, 0xE08CE8, 0xC3C95A, 0x9DB2D9, 0xF0A585, 0xA3A9F5, 0xEDA0B8, 0x86BFC9]
    public static let light: [UInt32] = [0x7A4FE0, 0x9A7B3F, 0x1F9A75, 0xB043BC, 0x7C8220, 0x5A719F, 0xC0623A, 0x5560D6, 0xC2557A, 0x2F8496]

    /// Which of the ten: whatever number the service gave, one of them.
    public var colorIndex: Int { ((color % 10) + 10) % 10 }
}

/// A session's avatar (2026-11-24, daemon `rooms/avatars.ts`): one for the pixel look, one for the classic, the same in
/// every room. nil of either: unchosen — the seat's face in the pixel look, its initials in the classic.
public struct RoomAvatar: Decodable, Equatable, Sendable {
    public enum Pixel: Equatable, Sendable {
        case face(id: String?, RoomFace)
        /// A 16 × 16 picture: each cell a palette index (`0-9a-zA-Z`), `.` empty.
        case grid(id: String, palette: [UInt32], rows: [String])

        public var id: String? { switch self { case .face(let id, _): id; case .grid(let id, _, _): id } }

        /// The cells of a grid with their colours.
        public var cells: [(x: Int, y: Int, rgb: UInt32)] {
            guard case .grid(_, let palette, let rows) = self else { return [] }
            return rows.enumerated().flatMap { y, row in row.enumerated().compactMap { x, ch -> (Int, Int, UInt32)? in
                guard let i = RoomAvatar.index(ch), i < palette.count else { return nil }
                return (x, y, palette[i])
            } }
        }
    }
    public struct Classic: Equatable, Sendable { public let id: String?; public let emoji: String; public let bg: Int }

    public let pixel: Pixel?
    public let classic: Classic?

    public init(pixel: Pixel?, classic: Classic?) { self.pixel = pixel; self.classic = classic }

    static func index(_ c: Character) -> Int? {
        let digits = Array("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
        return digits.firstIndex(of: c)
    }

    private struct Raw: Decodable {
        let kind: String?; let id: String?; let rows: [String]?; let color: Int?; let palette: [String]?; let emoji: String?; let bg: Int?
    }
    private enum CodingKeys: String, CodingKey { case pixel, classic }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let p = try? c.decodeIfPresent(Raw.self, forKey: .pixel)
        switch p?.kind {
        case "face": pixel = p.flatMap { r in r.rows.map { .face(id: r.id, RoomFace(rows: $0, color: r.color ?? 0)) } }
        case "grid": pixel = p.flatMap { r in r.rows.map { .grid(id: r.id ?? "", palette: (r.palette ?? []).map { UInt32($0, radix: 16) ?? 0 }, rows: $0) } }
        default: pixel = nil
        }
        let k = try? c.decodeIfPresent(Raw.self, forKey: .classic)
        classic = k?.kind == "emoji" ? k?.emoji.map { Classic(id: k?.id, emoji: $0, bg: k?.bg ?? 0) } : nil
    }
}

/// The library a picker offers (`GET /rooms/avatars`).
public struct RoomAvatarLibrary: Decodable, Equatable, Sendable {
    public struct Face: Decodable, Equatable, Sendable, Identifiable { public let id: String; public let rows: [String]; public let color: Int }
    public struct Art: Decodable, Equatable, Sendable, Identifiable { public let id: String; public let palette: [String]; public let rows: [String] }
    public struct Emoji: Decodable, Equatable, Sendable, Identifiable { public let id: String; public let emoji: String }
    public let faces: [Face]
    public let art: [Art]
    public let emoji: [Emoji]
}

/// A seat's state in the room (§6.1). The first four are a terminal's own; the others say what is wrong with it.
public enum SeatState: String, Sendable, CaseIterable {
    case busy, waiting, idle, exited, reconnecting, limited, signedOut = "signed_out", blocked, error, offline

    /// The pixel look's word; the classic look's is `ClassicWords.word` of it (Busy → Working …).
    public var word: String {
        switch self {
        case .busy: "Busy"
        case .waiting: "Waiting"
        case .idle: "Idle"
        case .exited: "Exited"
        case .reconnecting: "Reconnecting"
        case .limited: "Limited"
        case .signedOut: "Signed Out"
        case .blocked: "Blocked"
        case .error: "Error"
        case .offline: "Offline"
        }
    }

    /// How its mark is drawn. Amber is what needs the user's hands, red what went wrong; what mends itself has no
    /// colour — a spinner while it tries again, a dithered key while it only waits. Never the colour alone.
    public enum Tone: Equatable, Sendable { case working, retrying, needsYou, ready, off, failed, held }

    public var tone: Tone {
        switch self {
        case .busy: .working
        case .reconnecting: .retrying
        case .waiting, .signedOut: .needsYou
        case .idle: .ready
        case .exited: .off
        case .blocked, .error: .failed
        case .limited, .offline: .held
        }
    }

    /// What becomes of a message sent to a seat in this state, in a sentence; nil for the four everyday states.
    public var says: String? {
        switch self {
        case .reconnecting: "连不上它的服务，正在重试。发给它的消息先留着，连上之后交给它。"
        case .limited: "额度用完或被限速。发给它的消息留到恢复之后。"
        case .signedOut: "登录失效，需要你重新登录。发给它的消息交不了。"
        case .blocked: "这一轮被模型的安全措施拦下了。发给它的那一条它没能处理。"
        case .error: "这一轮出错结束。发给它的消息会再试一次。"
        case .offline: "它所在的节点连不上。发给它的消息留到节点回来。"
        case .busy, .waiting, .idle, .exited: nil
        }
    }

    /// A message for a seat in this state is kept until the seat mends: its receipt says the state, not `Queued`.
    public var holds: Bool { self == .reconnecting || self == .limited || self == .offline || self == .error }
}

/// A seat's card (§1 名片): no account, no address.
public struct SeatCard: Decodable, Equatable, Sendable {
    public let agent: String
    public let name: String
    public let cwd: String
    public let model: String?
    public let profile: String?
    public let color: String?
    public let mode: String?
    public let node: String?

    public init(agent: String, name: String, cwd: String, model: String? = nil, profile: String? = nil, color: String? = nil, mode: String? = nil, node: String? = nil) {
        self.agent = agent
        self.name = name
        self.cwd = cwd
        self.model = model
        self.profile = profile
        self.color = color
        self.mode = mode
        self.node = node
    }

    public var profileColor: ProfileColor? { color.flatMap(ProfileColor.init(rawValue:)) }
}

public struct RoomSeat: Decodable, Equatable, Sendable, Identifiable {
    public let handle: String
    public let kind: String
    public let terminal: String?
    public let face: RoomFace?
    public let joinedAt: Int64
    public let addedBy: String
    public let canAdd: Bool
    public let byAgent: Bool
    public let left: Int64?
    /// Muted by an admin or the user (docs/chatroom-v0.md §6.2): it reads and works but may not post or write the notes.
    public let muted: Bool
    public let mutedBy: String?
    /// What the seat has cost so far, as the room counts it: woken how often, with how many characters, how many
    /// messages it posted and tool calls it made here. The tokens are the agent's own to say.
    public struct Stats: Decodable, Equatable, Sendable {
        public let wakes: Int
        public let chars: Int
        public let posts: Int
        public let calls: Int

        /// `Woken 12× · 8.4K chars · 5 posts · 20 calls`.
        public var says: String {
            let size = chars < 1000 ? "\(chars)" : String(format: "%.1fK", Double(chars) / 1000)
            return "Woken \(wakes)× · \(size) chars · \(posts) posts · \(calls) calls"
        }
    }
    public let stats: Stats?
    /// What its own screen asks now (a list to choose from, like "trust this folder?" at its start); `trust`: it is
    /// exactly that question, which the room can answer for all at once.
    public struct Asks: Decodable, Equatable, Sendable {
        public let title: String
        public let options: [String]
        public let trust: Bool
    }
    public let asks: Asks?
    /// How many of the room's messages it has not read yet.
    public let unread: Int
    /// The state as the service wrote it; one this app does not know reads as `error`.
    public let stateWord: String?
    public let card: SeatCard?
    /// Its session has the Chatroom Kit (§6): it can speak in the room and be woken. False for one started before
    /// there was a Kit, until it is resumed; nil for the user, and from a service that does not say.
    public let kit: Bool?
    /// Its session's avatar, one for each look (2026-11-24); nil: unchosen.
    public let avatar: RoomAvatar?

    public var id: String { handle }
    /// Seated, running, and without the Kit: it reads nothing and says nothing until it is resumed once.
    public var needsResume: Bool { !isUser && here && kit == false && state != .exited }
    public static let needsResumeSays = "这个会话还没连上房间，消息送不到它。刚启动的会话可能正停在它自己的确认上（比如“是否信任这个文件夹”）：到终端里看一眼。很早以前启动的会话没有 Chatroom Kit：恢复一次。"
    public var isUser: Bool { kind == "user" }
    public var here: Bool { left == nil }
    public var state: SeatState? { stateWord.map { SeatState(rawValue: $0) ?? .error } }

    private enum CodingKeys: String, CodingKey { case handle, kind, terminal, face, joinedAt, addedBy, canAdd, byAgent, left, card, kit, muted, mutedBy, stats, asks, unread, avatar, stateWord = "state" }

    public init(handle: String, kind: String = "session", terminal: String? = nil, face: RoomFace? = nil, joinedAt: Int64 = 0, addedBy: String = Room.you,
                canAdd: Bool = false, byAgent: Bool = false, left: Int64? = nil, muted: Bool = false, mutedBy: String? = nil,
                state: SeatState? = nil, card: SeatCard? = nil, kit: Bool? = nil) {
        self.kit = kit
        self.handle = handle
        self.kind = kind
        self.terminal = terminal
        self.face = face
        self.joinedAt = joinedAt
        self.addedBy = addedBy
        self.canAdd = canAdd
        self.byAgent = byAgent
        self.left = left
        self.muted = muted
        self.mutedBy = mutedBy
        self.stats = nil
        self.asks = nil
        self.unread = 0
        self.stateWord = state?.rawValue
        self.card = card
        self.avatar = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = try c.decode(String.self, forKey: .handle)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "session"
        terminal = try? c.decodeIfPresent(String.self, forKey: .terminal)
        face = try? c.decodeIfPresent(RoomFace.self, forKey: .face)
        joinedAt = RoomJSON.int(c, .joinedAt) ?? 0
        addedBy = (try? c.decodeIfPresent(String.self, forKey: .addedBy)) ?? Room.you
        canAdd = (try? c.decodeIfPresent(Bool.self, forKey: .canAdd)) ?? false
        byAgent = (try? c.decodeIfPresent(Bool.self, forKey: .byAgent)) ?? false
        left = RoomJSON.int(c, .left)
        muted = (try? c.decodeIfPresent(Bool.self, forKey: .muted)) ?? false
        mutedBy = try? c.decodeIfPresent(String.self, forKey: .mutedBy)
        stats = try? c.decodeIfPresent(Stats.self, forKey: .stats)
        asks = try? c.decodeIfPresent(Asks.self, forKey: .asks)
        unread = (try? c.decodeIfPresent(Int.self, forKey: .unread)) ?? 0
        stateWord = try? c.decodeIfPresent(String.self, forKey: .stateWord)
        card = try? c.decodeIfPresent(SeatCard.self, forKey: .card)
        kit = try? c.decodeIfPresent(Bool.self, forKey: .kit)
        avatar = try? c.decodeIfPresent(RoomAvatar.self, forKey: .avatar)
    }
}

public struct RoomMessage: Decodable, Equatable, Sendable, Identifiable {
    public let seq: Int
    public let from: String
    public let to: [String]
    public let replyTo: Int?
    public let text: String
    public let at: Int64
    /// Files it comes with, by where they are on the room's node (§3 附件).
    public let files: [String]
    /// The task of the room's list it is about (`T3`), as a topic (2026-11-24); nil: about no one task.
    public let task: Int?

    public var id: Int { seq }
    public var date: Date { Date(timeIntervalSince1970: Double(at) / 1000) }

    private enum CodingKeys: String, CodingKey { case seq, from, to, replyTo, text, at, files, task }

    public init(seq: Int, from: String, to: [String] = [], replyTo: Int? = nil, text: String, at: Int64 = 0, files: [String] = [], task: Int? = nil) {
        self.files = files
        self.task = task
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
        to = (try? c.decodeIfPresent([String].self, forKey: .to)) ?? []
        replyTo = try? c.decodeIfPresent(Int.self, forKey: .replyTo)
        text = try c.decode(String.self, forKey: .text)
        at = RoomJSON.int(c, .at) ?? 0
        files = (try? c.decodeIfPresent([String].self, forKey: .files)) ?? []
        task = try? c.decodeIfPresent(Int.self, forKey: .task)
    }
}

/// The room's pinned notes (§9): one text every member reads and writes whole.
public struct RoomNotes: Decodable, Equatable, Sendable {
    public let text: String
    public let at: Int64
    public let by: String

    public init(text: String, at: Int64, by: String) {
        self.text = text
        self.at = at
        self.by = by
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        at = RoomJSON.int(c, .at) ?? 0
        by = (try? c.decodeIfPresent(String.self, forKey: .by)) ?? Room.you
    }

    private enum CodingKeys: String, CodingKey { case text, at, by }
    public var date: Date { Date(timeIntervalSince1970: Double(at) / 1000) }
    public var who: String { by == Room.you ? "You" : "@\(by)" }
}

/// Where a message is on its way to a seat (§5); a seat that has dealt with it has none.
public enum RoomReceipt: String, Sendable {
    case sent, queued, delivered, ended

    public var word: String {
        switch self {
        case .sent: "Sent"
        case .queued: "Queued"
        case .delivered: "Delivered"
        case .ended: "Ended"
        }
    }

    /// The mark before the name in the receipts' line.
    public var tick: String {
        switch self {
        case .sent: "·"
        case .queued: "…"
        case .delivered: "✓"
        case .ended: "×"
        }
    }
}

/// One thing in a room that waits on the user's hand (等你处理, 2026-11-24): a member's screen asking (trust its
/// folder, or a list to choose from), a member waiting on a permission, a task stuck, a question put to the user and
/// not answered yet, or sessions talking long with no word from the user.
public struct RoomAttention: Decodable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case trust, asks, permission, blocked, question, rounds, other }
    public let room: String
    public let roomName: String
    public let kind: Kind
    public let handle: String?
    public let terminal: String?
    public let task: Int?
    public let seq: Int?
    public let text: String
    public let at: Int64

    public var id: String { "\(room)|\(kind.rawValue)|\(handle ?? "")|\(task ?? 0)|\(seq ?? 0)" }

    private enum CodingKeys: String, CodingKey { case room, roomName, kind, handle, terminal, task, seq, text, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        room = try c.decode(String.self, forKey: .room)
        roomName = (try? c.decodeIfPresent(String.self, forKey: .roomName)) ?? ""
        kind = Kind(rawValue: (try? c.decode(String.self, forKey: .kind)) ?? "") ?? .other
        handle = try? c.decodeIfPresent(String.self, forKey: .handle)
        terminal = try? c.decodeIfPresent(String.self, forKey: .terminal)
        task = try? c.decodeIfPresent(Int.self, forKey: .task)
        seq = try? c.decodeIfPresent(Int.self, forKey: .seq)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        at = (try? c.decodeIfPresent(Int64.self, forKey: .at)) ?? 0
    }

    /// Its line in the list, in the user's words.
    public var line: String {
        let who = handle.map { "@" + $0 } ?? ""
        switch kind {
        case .trust: return "\(who) 等你信任它的文件夹"
        case .asks: return "\(who) 在等你选：\(text)"
        case .permission: return "\(who) 等你确认权限"
        case .blocked: return "T\(task ?? 0) 卡住：\(text)"
        case .question: return "\(who) 问你：\(RoomAttention.oneLine(text))"
        case .rounds: return "会话之间已聊 \(text) 条，没有你参与"
        case .other: return text
        }
    }

    static func oneLine(_ s: String) -> String { s.split(whereSeparator: \.isNewline).joined(separator: " ") }
}

/// A room in the list.
public struct RoomSummary: Decodable, Equatable, Sendable, Identifiable {
    public struct Last: Decodable, Equatable, Sendable {
        public let seq: Int
        public let from: String
        public let text: String
        public let at: Int64
    }

    public let id: String
    public let name: String
    public let topic: String
    public let paused: Bool
    public let members: Int
    public let last: Last?
    public let unread: Int
    /// One of the unread is for the user: amber.
    public let forYou: Bool
    /// Sessions have exchanged this many messages with no word from the user (§7); nil under the room's limit.
    public let rounds: Int?
    /// The sessions seated here, by terminal: a session sits in one room at a time.
    public let terminals: [String]
    /// How many things in it wait on the user's hand (等你处理, `GET /rooms/attention`).
    public let attention: Int
    /// The dispatch desk (调度台): the user and the dispatch session; listed first.
    public let desk: Bool

    private enum CodingKeys: String, CodingKey { case id, name, topic, paused, members, last, unread, forYou, rounds, terminals, attention, desk }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        topic = (try? c.decodeIfPresent(String.self, forKey: .topic)) ?? ""
        paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
        members = (try? c.decodeIfPresent(Int.self, forKey: .members)) ?? 0
        last = try? c.decodeIfPresent(Last.self, forKey: .last)
        unread = (try? c.decodeIfPresent(Int.self, forKey: .unread)) ?? 0
        forYou = (try? c.decodeIfPresent(Bool.self, forKey: .forYou)) ?? false
        rounds = try? c.decodeIfPresent(Int.self, forKey: .rounds)
        terminals = (try? c.decodeIfPresent([String].self, forKey: .terminals)) ?? []
        attention = (try? c.decodeIfPresent(Int.self, forKey: .attention)) ?? 0
        desk = (try? c.decodeIfPresent(Bool.self, forKey: .desk)) ?? false
    }

    /// The list's second line: who said the last thing and what, on one line; the topic before anything is said.
    public var lastLine: String {
        guard let last else { return topic }
        let text = last.text.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        return "\(last.from == Room.you ? "You" : last.from): \(text)"
    }
}

/// One piece of the room's work (§9 任务表): who does what, and how far it is.
public struct RoomTask: Decodable, Equatable, Sendable, Identifiable {
    /// `blocked`: its owner can not go on; its note says why (2026-11-24).
    public enum State: String, Sendable, CaseIterable { case blocked, doing, todo, done }

    public let n: Int
    public let title: String
    public let detail: String?
    public let state: State
    public let owner: String?
    public let by: String
    public let updatedAt: Int64
    /// Tasks that come first, by number.
    public let after: [Int]
    /// How it ended, in a line.
    public let note: String?

    public var id: Int { n }
    public var name: String { "T\(n)" }

    private enum CodingKeys: String, CodingKey { case n, title, detail, state, owner, by, updatedAt, after, note }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        n = try c.decode(Int.self, forKey: .n)
        title = try c.decode(String.self, forKey: .title)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        state = State(rawValue: (try? c.decode(String.self, forKey: .state)) ?? "") ?? .todo
        owner = try? c.decodeIfPresent(String.self, forKey: .owner)
        by = (try? c.decodeIfPresent(String.self, forKey: .by)) ?? Room.you
        updatedAt = RoomJSON.int(c, .updatedAt) ?? 0
        after = (try? c.decodeIfPresent([Int].self, forKey: .after)) ?? []
        note = try? c.decodeIfPresent(String.self, forKey: .note)
    }
}

/// A member saying which files it is changing (§9): a word to the others, not a lock, gone by itself at `until`.
public struct RoomClaim: Decodable, Equatable, Sendable {
    public let handle: String
    public let paths: [String]
    public let why: String?
    public let until: Int64

    private enum CodingKeys: String, CodingKey { case handle, paths, why, until }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = try c.decode(String.self, forKey: .handle)
        paths = (try? c.decodeIfPresent([String].self, forKey: .paths)) ?? []
        why = try? c.decodeIfPresent(String.self, forKey: .why)
        until = RoomJSON.int(c, .until) ?? 0
    }

    public var untilDate: Date { Date(timeIntervalSince1970: Double(until) / 1000) }

    /// `form.ts +2`: the first one's name, and how many more.
    public var names: String {
        let all = paths.map { ($0 as NSString).lastPathComponent }
        return (all.first ?? "") + (all.count > 1 ? " +\(all.count - 1)" : "")
    }
}

/// What is in a room's shared folder (§9), the newest first.
public struct RoomFiles: Decodable, Equatable, Sendable {
    public struct File: Decodable, Equatable, Sendable, Identifiable {
        /// Under the folder.
        public let path: String
        public let size: Int64
        public let modifiedAt: Int64

        public var id: String { path }
        public var date: Date { Date(timeIntervalSince1970: Double(modifiedAt) / 1000) }

        private enum CodingKeys: String, CodingKey { case path, size, modifiedAt }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            path = try c.decode(String.self, forKey: .path)
            size = RoomJSON.int(c, .size) ?? 0
            modifiedAt = RoomJSON.int(c, .modifiedAt) ?? 0
        }
    }

    public let folder: String
    public let files: [File]
    public let more: Bool

    private enum CodingKeys: String, CodingKey { case folder, files, more }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        folder = try c.decode(String.self, forKey: .folder)
        files = (try? c.decodeIfPresent([File].self, forKey: .files)) ?? []
        more = (try? c.decodeIfPresent(Bool.self, forKey: .more)) ?? false
    }
}

/// Which models a session may start a session on, per profile (docs/chatroom-v0.md §6.2): every agent's models and
/// profiles, and for each profile the models the user has turned off.
public struct RoomModels: Decodable, Equatable, Sendable {
    public struct Model: Decodable, Equatable, Sendable, Identifiable {
        public let id: String; public let name: String
        public let description: String?
        /// A newer one of the same family is listed: folded under "Earlier versions".
        public let older: Bool?
        public var isOlder: Bool { older == true }
    }
    public struct Profile: Decodable, Equatable, Sendable, Identifiable {
        public let id: String; public let name: String; public let off: [String]
        /// This profile's own models (another vendor's address lists its own); nil from an older service: the agent's.
        public let models: [Model]?
        /// `agent`, `vendor` (the address listed them) or `profile` (only the model the profile was given).
        public let source: String?
        /// The model it starts on unless told.
        public let model: String?
        public let baseUrl: String?
        public func models(_ agent: Agent) -> [Model] { models ?? agent.models }
        public var elsewhere: Bool { source == "vendor" || source == "profile" }
        /// Where it sends its requests, for the row's label: the address's host.
        public var host: String? { baseUrl.flatMap { URL(string: $0)?.host } }
    }
    public struct Agent: Decodable, Equatable, Sendable { public let models: [Model]; public let current: String?; public let profiles: [Profile] }
    public let agents: [String: Agent]
}

/// A room as it is read: itself, its seats (those that left too: they said things), what was said, and the receipts
/// still open.
public struct Room: Decodable, Equatable, Sendable {
    public static let you = "you"
    public static let all = "all"

    public struct Head: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let topic: String
        public let paused: Bool
        public let lastSeq: Int
        public let readSeq: Int
        /// Sessions have exchanged this many messages with no word from the user (§7); nil under the limit.
        public let rounds: Int?
        public let roundsLimit: Int?
        /// The dispatch desk (调度台): what the user says is for the dispatch, named or not.
        public let desk: Bool?
    }

    /// What the notice of many rounds says: nothing was stopped.
    public static func roundsSays(_ n: Int) -> String { "这里的会话已经连续往返 \(n) 次，没有你参与。没有中断它们。" }

    public let notes: RoomNotes?
    public let tasks: [RoomTask]
    /// What members say they are changing now.
    public let claims: [RoomClaim]
    /// Who has read which message: message number → the members that were given it whole or read it themselves.
    public let reads: [String: [String]]
    /// The room's shared folder on its node; nil from a service that has none.
    public let folder: String?
    public let room: Head
    public let seats: [RoomSeat]
    public let messages: [RoomMessage]
    /// Message number → handle → where it is.
    public let receipts: [String: [String: String]]

    /// What each task has cost so far, by its number (2026-11-24): the wakes, characters, messages and calls counted
    /// while a member worked on it.
    public let taskStats: [Int: RoomSeat.Stats]

    private enum CodingKeys: String, CodingKey { case room, seats, messages, receipts, notes, tasks, claims, folder, reads, taskStats }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        room = try c.decode(Head.self, forKey: .room)
        seats = try c.decode([RoomSeat].self, forKey: .seats)
        messages = try c.decode([RoomMessage].self, forKey: .messages)
        receipts = (try? c.decodeIfPresent([String: [String: String]].self, forKey: .receipts)) ?? [:]
        notes = try? c.decodeIfPresent(RoomNotes.self, forKey: .notes)
        tasks = (try? c.decodeIfPresent([RoomTask].self, forKey: .tasks)) ?? []
        claims = (try? c.decodeIfPresent([RoomClaim].self, forKey: .claims)) ?? []
        reads = (try? c.decodeIfPresent([String: [String]].self, forKey: .reads)) ?? [:]
        folder = try? c.decodeIfPresent(String.self, forKey: .folder)
        let stats = (try? c.decodeIfPresent([String: RoomSeat.Stats].self, forKey: .taskStats)) ?? [:]
        taskStats = Dictionary(uniqueKeysWithValues: stats.compactMap { k, v in Int(k).map { ($0, v) } })
    }

    /// The tasks in the order they are read: being done, to do, done (the last finished first).
    public func tasks(_ state: RoomTask.State) -> [RoomTask] {
        let found = tasks.filter { $0.state == state }
        return state == .done ? found.sorted { $0.updatedAt > $1.updatedAt } : found
    }

    /// The tasks a task still waits for.
    public func waits(_ task: RoomTask) -> [Int] { task.after.filter { n in tasks.contains { $0.n == n && $0.state != .done } } }

    /// Of the sessions a message was for: those that have read it, and those that have not yet (the ones still seated).
    public func readers(of message: RoomMessage) -> (read: [String], unread: [String]) {
        let here = Set(sessions.map(\.handle))
        let asked = message.to.filter { here.contains($0) && $0 != message.from }
        let read = Set(reads[String(message.seq)] ?? [])
        return (asked.filter { read.contains($0) }, asked.filter { !read.contains($0) })
    }

    /// What a member says it is changing now.
    public func claim(of handle: String) -> RoomClaim? { claims.first { $0.handle == handle } }

    public init(room: Head, seats: [RoomSeat], messages: [RoomMessage], receipts: [String: [String: String]] = [:], notes: RoomNotes? = nil) {
        self.notes = notes
        self.tasks = []
        self.claims = []
        self.reads = [:]
        self.taskStats = [:]
        self.folder = nil
        self.room = room
        self.seats = seats
        self.messages = messages
        self.receipts = receipts
    }

    public func seat(_ handle: String) -> RoomSeat? { seats.first { $0.handle == handle } }

    /// The sessions seated now, in the order they sat down.
    public var sessions: [RoomSeat] { seats.filter { !$0.isUser && $0.here } }

    /// A message's open receipts, by the seats' order.
    public func receipts(of seq: Int) -> [(handle: String, receipt: RoomReceipt)] {
        guard let of = receipts[String(seq)] else { return [] }
        let order = seats.map(\.handle)
        return of.compactMap { handle, raw in RoomReceipt(rawValue: raw).map { (handle, $0) } }
            .sorted { (order.firstIndex(of: $0.handle) ?? .max, $0.handle) < (order.firstIndex(of: $1.handle) ?? .max, $1.handle) }
    }
}

enum RoomJSON {
    /// A whole number the service may write with a fraction (a time in milliseconds).
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Int64? {
        if let n = try? c.decodeIfPresent(Int64.self, forKey: key) { return n }
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return Int64(d.rounded()) }
        return nil
    }
}

// MARK: - what the page decides

public enum RoomText {
    /// A receipt's line under a message: `… daemon · Queued`. One that waits for a seat that must mend first says the
    /// seat's state in its place (`gate · Reconnecting`); one that can not be given says why when the seat's state
    /// tells (`web · Signed Out`), else `Ended`.
    public static func receipt(_ receipt: RoomReceipt, to seat: RoomSeat?, handle: String, classic: Bool) -> String {
        let word: String
        if let state = seat?.state, receipt == .ended ? (state == .signedOut || state == .blocked) : (receipt != .delivered && state.holds) {
            word = state.word
        } else {
            word = receipt.word
        }
        return "\(receipt.tick) \(handle == Room.you ? "You" : handle) · \(classic ? ClassicWords.word(word, in: .classic) : word)"
    }

    /// A receipt that says something went wrong (red); the others are quiet.
    public static func failed(_ receipt: RoomReceipt) -> Bool { receipt == .ended }

    /// A piece of a message's text: plain, code between backticks, or an `@name` of the room.
    public enum Piece: Equatable, Sendable {
        case plain(String), code(String), mention(String)
    }

    /// A text cut into its pieces. An `@name` is a mention only when it names a seat of the room (or `all`), and
    /// stands where a word begins: an address in an e-mail is not one.
    public static func pieces(_ text: String, handles: Set<String>) -> [Piece] {
        var out: [Piece] = []
        var plain = ""
        func flush() { if !plain.isEmpty { out.append(.plain(plain)); plain = "" } }
        let chars = Array(text)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "`", let end = chars[(i + 1)...].firstIndex(of: "`"), end > i + 1, !chars[(i + 1)..<end].contains("\n") {
                flush()
                out.append(.code(String(chars[(i + 1)..<end])))
                i = end + 1
                continue
            }
            if c == "@", i == 0 || !wordish(chars[i - 1]) {
                var j = i + 1
                while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "-" || chars[j] == "_" { j += 1 }
                let name = String(chars[(i + 1)..<j]).lowercased()
                if !name.isEmpty, handles.contains(name) || name == Room.all {
                    flush()
                    out.append(.mention(name))
                    i = j
                    continue
                }
            }
            plain.append(c)
            i += 1
        }
        flush()
        return out
    }

    private static func wordish(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "@" || c == "." || c == "-" }

    /// A quoted message's first words for the line above a reply, its Markdown kept (2026-11-24): one line, at most
    /// `limit` characters, a bold or a code cut in two closed again so it is drawn and not shown as marks.
    public static func quoteHead(_ text: String, handles: Set<String>, limit: Int = 60) -> String {
        var line = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
            .map { $0.replacingOccurrences(of: #"^(#{1,6}|[-*+]|>)\s+"#, with: "", options: .regularExpression) }
            .filter { !$0.isEmpty }.joined(separator: " ")
        if line.count > limit { line = String(line.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…" }
        if line.components(separatedBy: "`").count % 2 == 0 { line += "`" }
        if line.replacingOccurrences(of: "`[^`]*`", with: "", options: .regularExpression).components(separatedBy: "**").count % 2 == 0 { line += "**" }
        return line
    }

    /// A quoted message's line above a reply: one line, without its backticks and its `@names`.
    public static func quote(_ text: String, handles: Set<String>) -> String {
        pieces(text, handles: handles).compactMap { piece -> String? in
            switch piece {
            case .plain(let s), .code(let s): s
            case .mention: nil
            }
        }.joined().split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// What is being typed after the last `@`, when the caret's word is one: the member list is offered for it.
    public static func mentionQuery(_ draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex, wordish(draft[draft.index(before: at)]) { return nil }
        let term = draft[draft.index(after: at)...]
        guard term.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
        return term.lowercased()
    }

    /// The draft with the `@…` being typed finished as `@handle `.
    public static func completing(_ draft: String, with handle: String) -> String {
        guard mentionQuery(draft) != nil, let at = draft.lastIndex(of: "@") else { return draft + "@\(handle) " }
        return draft[..<at] + "@\(handle) "
    }

    /// The names offered for what is typed after `@`: the sessions seated whose handle begins with it, then `all`.
    public static func offered(_ query: String, in room: Room) -> [String] {
        (room.sessions.map(\.handle) + [Room.all]).filter { $0.hasPrefix(query) }
    }
}

/// A message as the timeline draws it.
public struct RoomRow: Equatable, Sendable, Identifiable {
    public let message: RoomMessage
    /// It runs on from the one before: the same seat, soon after, no quote — no face and no name again.
    public let continues: Bool
    /// The day's line stands before it: the first message, or the first of another day.
    public let day: String?
    /// It is for the user and the user has not seen it: amber, what waits for you.
    public let forYou: Bool
    public var id: Int { message.seq }

    /// Messages of one seat within this long run together.
    public static let together: Int64 = 5 * 60 * 1000

    /// `task`: only the messages about that task of the list (the label clicked); nil: all of them.
    public static func rows(_ room: Room, task: Int? = nil, now: Date = Date(), calendar: Calendar = .current) -> [RoomRow] {
        var out: [RoomRow] = []
        var previous: RoomMessage?
        for message in room.messages where task == nil || message.task == task {
            let newDay = previous.map { !calendar.isDate($0.date, inSameDayAs: message.date) } ?? true
            let continues = !newDay && previous?.from == message.from && message.replyTo == nil && previous?.task == message.task && message.at - (previous?.at ?? 0) <= together
            out.append(RoomRow(message: message, continues: continues, day: newDay ? TimeText.day(message.date, now: now, calendar: calendar) : nil,
                               forYou: message.seq > room.room.readSeq && message.from != Room.you && message.to.contains(Room.you)))
            previous = message
        }
        return out
    }
}

// MARK: - the service

public extension DaemonClient {
    private struct RoomList: Decodable { let rooms: [RoomSummary] }

    /// The rooms, unless the service still has the list under `version`.
    func rooms(version: String? = nil) async throws -> Versioned<[RoomSummary]>? {
        guard let answer = try await callUnlessUnchanged("/rooms", version: version) else { return nil }
        return Versioned(value: try decode(RoomList.self, answer.value).rooms, version: answer.version)
    }

    /// A room with its last messages, unless unchanged.
    func room(_ id: String, version: String? = nil) async throws -> Versioned<Room>? {
        guard let answer = try await callUnlessUnchanged("/rooms/\(DaemonClient.segment(id))", version: version) else { return nil }
        return Versioned(value: try decode(Room.self, answer.value), version: answer.version)
    }

    /// What the service did not seat of the sessions named, each in a sentence.
    struct RoomMade: Decodable, Sendable {
        public let room: Room.Head
        public let problems: [String]
    }

    func makeRoom(name: String, topic: String, terminals: [String]) async throws -> RoomMade {
        let body = try JSONSerialization.data(withJSONObject: ["name": name, "topic": topic, "terminals": terminals])
        return try decode(RoomMade.self, try await call("POST", "/rooms", body: body, timeout: 10))
    }

    func updateRoom(_ id: String, name: String? = nil, topic: String? = nil, paused: Bool? = nil) async throws {
        var object: [String: Any] = [:]
        if let name { object["name"] = name }
        if let topic { object["topic"] = topic }
        if let paused { object["paused"] = paused }
        _ = try await call("PATCH", "/rooms/\(DaemonClient.segment(id))", body: try JSONSerialization.data(withJSONObject: object), timeout: 10)
    }

    func deleteRoom(_ id: String) async throws { _ = try await call("DELETE", "/rooms/\(DaemonClient.segment(id))", timeout: 10) }

    func seat(terminal: String, in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/seats", body: try JSONSerialization.data(withJSONObject: ["terminal": terminal]), timeout: 10)
    }

    func setCanAdd(_ on: Bool, seat handle: String, in room: String) async throws {
        _ = try await call("PATCH", "/rooms/\(DaemonClient.segment(room))/seats/\(DaemonClient.segment(handle))", body: try JSONSerialization.data(withJSONObject: ["canAdd": on]), timeout: 10)
    }

    /// Muted or unmuted by the user (docs/chatroom-v0.md §6.2): it reads and works, but may not post.
    func setMuted(_ on: Bool, seat handle: String, in room: String) async throws {
        _ = try await call("PATCH", "/rooms/\(DaemonClient.segment(room))/seats/\(DaemonClient.segment(handle))", body: try JSONSerialization.data(withJSONObject: ["muted": on]), timeout: 10)
    }

    /// The same conversation behind an ended seat goes on in a new terminal; the seat keeps its name.
    func resumeSeat(_ handle: String, in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/seats/\(DaemonClient.segment(handle))/resume", timeout: 60)
    }

    /// Out of the room. `close`: `"end"` closes its terminal too (the conversation is kept), `"delete"` deletes the
    /// conversation's record as well.
    func unseat(_ handle: String, close: String? = nil, in room: String) async throws {
        _ = try await call("DELETE", "/rooms/\(DaemonClient.segment(room))/seats/\(DaemonClient.segment(handle))" + (close.map { "?close=\($0)" } ?? ""), timeout: 30)
    }

    /// A member's name in the room (its nickname there; its session's own name is another thing).
    func renameSeat(_ handle: String, to name: String, in room: String) async throws {
        _ = try await call("PATCH", "/rooms/\(DaemonClient.segment(room))/seats/\(DaemonClient.segment(handle))", body: try JSONSerialization.data(withJSONObject: ["name": name]), timeout: 10)
    }

    func roomModels() async throws -> RoomModels { try decode(RoomModels.self, try await call("GET", "/rooms/models", timeout: 15)) }

    /// The models turned off, under one profile of an agent, for sessions a session starts.
    func setRoomModels(off: [String], agent: String, profile: String) async throws {
        _ = try await call("PUT", "/rooms/models/\(DaemonClient.segment(agent))/\(DaemonClient.segment(profile))", body: try JSONSerialization.data(withJSONObject: ["off": off]), timeout: 10)
    }

    /// Every member whose session has ended is brought back.
    func resumeAll(in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/resume", timeout: 180)
    }

    /// "Trust this folder?" answered yes for every member whose screen asks exactly that.
    func trustAll(in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/trust", timeout: 20)
    }

    /// The body of what the user says: `files` only when there are some (the service takes no unknown or empty extra).
    static func sayBody(_ text: String, replyTo: Int?, files: [String], task: Int? = nil) -> [String: Any] {
        var object: [String: Any] = ["text": text]
        if let task { object["task"] = task }
        if let replyTo { object["replyTo"] = replyTo }
        if !files.isEmpty { object["files"] = files }
        return object
    }

    /// The user has seen the sessions' rounds go by (`OK`): counted from here again.
    func roundsSeen(in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/rounds/ok", timeout: 10)
    }

    /// A task the user adds; `owner`: the member whose it is.
    func addTask(_ title: String, detail: String = "", owner: String? = nil, in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/tasks", body: try JSONSerialization.data(withJSONObject: DaemonClient.taskBody(title: title, detail: detail, owner: owner)), timeout: 10)
    }

    static func taskBody(title: String, detail: String, owner: String?) -> [String: Any] {
        var object: [String: Any] = ["title": title]
        if !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { object["detail"] = detail }
        if let owner { object["owner"] = owner }
        return object
    }

    /// A task's state, or whose it is (`.some(nil)`: nobody's).
    func setTask(_ n: Int, state: RoomTask.State? = nil, owner: String?? = nil, in room: String) async throws {
        var object: [String: Any] = [:]
        if let state { object["state"] = state.rawValue }
        if let owner { object["owner"] = owner ?? NSNull() }
        _ = try await call("PATCH", "/rooms/\(DaemonClient.segment(room))/tasks/\(n)", body: try JSONSerialization.data(withJSONObject: object), timeout: 10)
    }

    func deleteTask(_ n: Int, in room: String) async throws {
        _ = try await call("DELETE", "/rooms/\(DaemonClient.segment(room))/tasks/\(n)", timeout: 10)
    }

    /// What is in the room's shared folder.
    func roomFiles(_ room: String) async throws -> RoomFiles {
        try decode(RoomFiles.self, try await call("GET", "/rooms/\(DaemonClient.segment(room))/files", timeout: 10))
    }

    /// The pinned notes, whole, in place of what was there.
    func writeNotes(_ text: String, in room: String) async throws {
        _ = try await call("PUT", "/rooms/\(DaemonClient.segment(room))/notes", body: try JSONSerialization.data(withJSONObject: ["text": text]), timeout: 10)
    }

    func say(_ text: String, replyTo: Int? = nil, files: [String] = [], task: Int? = nil, in room: String) async throws {
        let object = DaemonClient.sayBody(text, replyTo: replyTo, files: files, task: task)
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/messages", body: try JSONSerialization.data(withJSONObject: object), timeout: 10)
    }

    private struct Attention: Decodable { let items: [RoomAttention] }
    /// What waits on the user in every room (等你处理), newest first.
    func roomAttention() async throws -> [RoomAttention] {
        try decode(Attention.self, try await call("GET", "/rooms/attention", timeout: 10)).items
    }

    private struct Found: Decodable { let messages: [RoomMessage] }
    /// The messages of a room whose words contain `query`, newest first; of one task when `task` is given.
    func searchRoom(_ room: String, query: String, task: Int? = nil, limit: Int = 50) async throws -> [RoomMessage] {
        var path = "/rooms/\(DaemonClient.segment(room))/messages?limit=\(limit)&q=\(query.addingPercentEncoding(withAllowedCharacters: CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?#"))) ?? "")"
        if let task { path += "&task=\(task)" }
        return try decode(Found.self, try await call("GET", path, timeout: 10)).messages
    }

    func avatarLibrary() async throws -> RoomAvatarLibrary { try decode(RoomAvatarLibrary.self, try await call("GET", "/rooms/avatars", timeout: 10)) }

    /// A member's avatar: a JSON object of `pixel` / `classic` as the service takes them (`{"id": "p7"}`,
    /// `{"emoji": "🦊", "bg": 2}`), null to go back to its own; a key left out is not changed.
    func setAvatar(_ body: Data, seat handle: String, in room: String) async throws {
        _ = try await call("PUT", "/rooms/\(DaemonClient.segment(room))/seats/\(DaemonClient.segment(handle))/avatar", body: body, timeout: 10)
    }

    func markRead(_ seq: Int, in room: String) async throws {
        _ = try await call("POST", "/rooms/\(DaemonClient.segment(room))/read", body: try JSONSerialization.data(withJSONObject: ["seq": seq]), timeout: 10)
    }
}
