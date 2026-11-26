import Foundation

// Chat Room's routes a paired phone may use (docs/chatroom-v0.md §10; the daemon's remote allowlist): the rooms on the
// Mac asked, and the user in them — making a room, seating sessions that run there, speaking. The lists are sent with
// the version the page has (`If-None-Match`): an unchanged one is a 304, nothing new. A Mac from before Chat Room
// answers 403 or 404 for `/rooms`: read as "not there" (`RoomsUnsupported`).

/// The Mac asked has no Chat Room (an older AgentSwitch).
public struct RoomsUnsupported: Error, Equatable { public init() {} }

private struct CreateRoomBody: Encodable { let name: String; let topic: String?; let terminals: [String]? }
private struct UpdateRoomBody: Encodable { let name: String?; let topic: String?; let paused: Bool? }
private struct AddSeatBody: Encodable { let terminal: String; let canAdd: Bool? }
private struct SetSeatBody: Encodable { let canAdd: Bool }
private struct MuteSeatBody: Encodable { let muted: Bool }
private struct ResumedSeat: Decodable { let seat: RoomSeat }
private struct SayBody: Encodable { let text: String; let replyTo: Int?; let files: [String]?; let task: Int? }
private struct ReadBody: Encodable { let seq: Int }
private struct NotesBody: Encodable { let text: String }
private struct NotesReply: Decodable { let notes: RoomNotes? }
private struct AddTaskBody: Encodable { let title: String; let detail: String?; let owner: String?; let after: [Int]? }
private struct TaskReply: Decodable { let task: RoomTask }
/// Only what changes is sent; an owner taken away goes as `null`.
private struct SetTaskBody: Encodable {
    let state: RoomTaskState?
    let owner: RoomTaskOwner?
    let title: String?
    let detail: String?
    let note: String?

    private enum CodingKeys: String, CodingKey { case state, owner, title, detail, note }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(state?.rawValue, forKey: .state)
        switch owner {
        case .seat(let handle): try c.encode(handle, forKey: .owner)
        case .nobody: try c.encodeNil(forKey: .owner)
        case nil: break
        }
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(detail, forKey: .detail)
        try c.encodeIfPresent(note, forKey: .note)
    }
}
private struct Nothing: Encodable {}
private struct SeatReply: Decodable { let seat: RoomSeat }
private struct SummaryReply: Decodable { let room: RoomSummary }
private struct ReadReply: Decodable { let readSeq: Int }
private struct Done: Decodable { let ok: Bool? }
private struct PokeBody: Encodable { let handle: String? }
private struct PokeReply: Decodable { let results: [RoomPoke] }

/// What came of deleting a message (user #278): the members it had reached, those it was withdrawn from before it
/// reached them, and the line telling those who had it to leave it aside (its seq), when asked for.
public struct RoomMessageDeleted: Decodable, Sendable, Hashable {
    public let reached: [String]
    public let withdrawn: [String]
    public let told: Int?

    private enum CodingKeys: String, CodingKey { case reached, withdrawn, told }

    public init(reached: [String] = [], withdrawn: [String] = [], told: Int? = nil) {
        self.reached = reached
        self.withdrawn = withdrawn
        self.told = told
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reached = (try? c.decode([String].self, forKey: .reached)) ?? []
        withdrawn = (try? c.decode([String].self, forKey: .withdrawn)) ?? []
        told = (try? c.decodeIfPresent(Int.self, forKey: .told)).flatMap { $0 }
    }
}

/// What came of 戳一下 for one member: the user's message still waiting for it was given to it now, or why not.
public struct RoomPoke: Decodable, Sendable, Hashable {
    public let handle: String
    public let given: Bool
    public let why: String?

    public init(handle: String, given: Bool, why: String? = nil) {
        self.handle = handle
        self.given = given
        self.why = why
    }
}

/// Whose a task is to be: a seat's, by handle, or nobody's any more.
public enum RoomTaskOwner: Sendable, Hashable {
    case seat(String)
    case nobody
}

/// What the Mac says of a message just taken: the message, and who it still has to reach.
public struct RoomSaid: Decodable, Sendable, Hashable {
    public let message: RoomMessage
    public let receipts: [String: RoomReceipt]

    private enum CodingKeys: String, CodingKey { case message, receipts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        message = try c.decode(RoomMessage.self, forKey: .message)
        receipts = ((try? c.decode([String: String].self, forKey: .receipts)) ?? [:]).compactMapValues(RoomReceipt.init(rawValue:))
    }
}

extension AgentSwitchAPI {
    /// The rooms, the one talked in last first; nil: unchanged since `etag`.
    public func rooms(etag: String?) async throws -> (list: RoomList, etag: String?)? {
        do {
            guard let got: (folder: RoomList, etag: String?) = try await versioned(["rooms"], query: [], etag: etag) else { return nil }
            return (got.folder, got.etag)
        } catch APIError.http(let status, _) where status == 403 || status == 404 {
            throw RoomsUnsupported()
        }
    }

    /// One room with its seats as they are now and its last messages; nil: unchanged since `etag`.
    public func room(_ id: String, etag: String?) async throws -> (room: RoomDetail, etag: String?)? {
        guard let got: (folder: RoomDetail, etag: String?) = try await versioned(["rooms", id], query: [], etag: etag) else { return nil }
        return (got.folder, got.etag)
    }

    /// A new room with the sessions named seated in it; `problems` says which could not be.
    public func createRoom(name: String, topic: String, terminals: [String]) async throws -> RoomDetail {
        try await post(["rooms"], body: CreateRoomBody(name: name, topic: topic.isEmpty ? nil : topic, terminals: terminals.isEmpty ? nil : terminals))
    }

    @discardableResult
    public func updateRoom(_ id: String, name: String? = nil, topic: String? = nil, paused: Bool? = nil) async throws -> RoomSummary {
        (try await send("PATCH", ["rooms", id], body: UpdateRoomBody(name: name, topic: topic, paused: paused)) as SummaryReply).room
    }

    public func deleteRoom(_ id: String) async throws {
        let _: Done = try await perform("DELETE", ["rooms", id], query: [], body: nil)
    }

    /// A session running on the Mac asked takes a seat.
    @discardableResult
    public func seat(_ terminal: String, in room: String, canAdd: Bool? = nil) async throws -> RoomSeat {
        (try await post(["rooms", room, "seats"], body: AddSeatBody(terminal: terminal, canAdd: canAdd)) as SeatReply).seat
    }

    /// `Can Add Sessions` for one seat.
    @discardableResult
    public func setSeat(_ handle: String, in room: String, canAdd: Bool) async throws -> RoomSeat {
        (try await send("PATCH", ["rooms", room, "seats", handle], body: SetSeatBody(canAdd: canAdd)) as SeatReply).seat
    }

    /// Out of the room — its session left running; with `close`, its terminal closed too (`delete`: and its
    /// conversation's record). A member with work unfinished writes its handover note first (`handingOver`), unless
    /// `now`.
    @discardableResult
    public func unseat(_ handle: String, in room: String, close: RoomSeatClose? = nil, now: Bool = false) async throws -> RoomUnseated {
        var query: [URLQueryItem] = []
        if let close {
            query.append(URLQueryItem(name: "close", value: close.rawValue))
            if now { query.append(URLQueryItem(name: "now", value: "1")) }
        }
        return try await perform("DELETE", ["rooms", room, "seats", handle], query: query, body: nil)
    }

    /// Muted or unmuted (§6.2): a muted member reads and works but may not post.
    @discardableResult
    public func muteSeat(_ handle: String, in room: String, muted: Bool) async throws -> RoomSeat {
        (try await send("PATCH", ["rooms", room, "seats", handle], body: MuteSeatBody(muted: muted)) as SeatReply).seat
    }

    /// The session behind an ended seat goes on in a new terminal; the seat keeps its name and face.
    @discardableResult
    public func resumeSeat(_ handle: String, in room: String) async throws -> RoomSeat {
        (try await post(["rooms", room, "seats", handle, "resume"], body: Nothing()) as ResumedSeat).seat
    }

    /// Everything in every room that waits on the user's hand (等你处理), newest first.
    public func roomAttention() async throws -> RoomAttention {
        try await get(["rooms", "attention"])
    }

    /// Some of a room's messages: one task's last ones (`task`), the ones whose words contain `query` (newest first;
    /// within `task` when given), or the page above `before`; with how many since `since` are about each task.
    public func roomMessages(_ room: String, task: Int? = nil, query: String? = nil, before: Int? = nil, since: Int? = nil, limit: Int = 200) async throws -> RoomMessagePage {
        var items: [URLQueryItem] = []
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let task { items.append(URLQueryItem(name: "task", value: String(task))) }
        if let before { items.append(URLQueryItem(name: "before", value: String(before))) }
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        items.append(URLQueryItem(name: "limit", value: String(min(max(limit, 1), 200))))
        return try await get(["rooms", room, "messages"], query: items)
    }

    /// The user speaks; who it is for is read from the `@names` in the text. `files`: what it comes with, by where
    /// each is on the Mac (`RoomMessage.maxFiles` at most).
    @discardableResult
    public func say(_ text: String, in room: String, replyTo: Int? = nil, files: [String] = [], task: Int? = nil) async throws -> RoomSaid {
        try await post(["rooms", room, "messages"], body: SayBody(text: text, replyTo: replyTo, files: files.isEmpty ? nil : files, task: task))
    }

    /// The user has seen up to `seq`.
    @discardableResult
    public func markRoomRead(_ room: String, upTo seq: Int) async throws -> Int {
        (try await post(["rooms", room, "read"], body: ReadBody(seq: seq)) as ReadReply).readSeq
    }

    /// 戳一下: the user's messages still waiting for a busy member (`sent` or `queued` to it) are given to it now;
    /// nil: to every member something waits for.
    public func pokeRoom(_ room: String, handle: String? = nil) async throws -> [RoomPoke] {
        (try await post(["rooms", room, "poke"], body: PokeBody(handle: handle)) as PokeReply).results
    }

    /// 删除消息 (user #278): its words, files and search entry go, its place and number stay. Still on its way it is
    /// withdrawn; `tell`: the members who had it already are told to leave it aside.
    @discardableResult
    public func deleteRoomMessage(room: String, seq: Int, tell: Bool = false) async throws -> RoomMessageDeleted {
        try await perform("DELETE", ["rooms", room, "messages", String(seq)], query: tell ? [URLQueryItem(name: "tell", value: "1")] : [], body: nil)
    }

    /// The pinned notes, whole, in place of what was there; nil: they are empty now.
    @discardableResult
    public func setRoomNotes(_ room: String, text: String) async throws -> RoomNotes? {
        (try await send("PUT", ["rooms", room, "notes"], body: NotesBody(text: text)) as NotesReply).notes
    }

    /// The user adds a task to the room's list (§9); `owner`: whose it is from the start, `after`: the tasks that come first.
    @discardableResult
    public func addRoomTask(_ room: String, title: String, detail: String? = nil, owner: String? = nil, after: [Int] = []) async throws -> RoomTask {
        let detail = detail.flatMap { $0.isEmpty ? nil : $0 }
        return (try await post(["rooms", room, "tasks"], body: AddTaskBody(title: title, detail: detail, owner: owner, after: after.isEmpty ? nil : after)) as TaskReply).task
    }

    /// The user changes a task: only what is named. The user's change of state leaves whose it is alone; a task being
    /// done whose owner is taken away is to do again.
    @discardableResult
    public func setRoomTask(_ n: Int, in room: String, state: RoomTaskState? = nil, owner: RoomTaskOwner? = nil, title: String? = nil, detail: String? = nil, note: String? = nil) async throws -> RoomTask {
        (try await send("PATCH", ["rooms", room, "tasks", String(n)], body: SetTaskBody(state: state, owner: owner, title: title, detail: detail, note: note)) as TaskReply).task
    }

    public func deleteRoomTask(_ n: Int, in room: String) async throws {
        let _: Done = try await perform("DELETE", ["rooms", room, "tasks", String(n)], query: [], body: nil)
    }

    /// What is in the room's shared folder (§9), the newest first.
    public func roomFiles(_ room: String) async throws -> RoomFiles {
        try await get(["rooms", room, "files"])
    }

    /// A file of the room's shared folder as its bytes, by where it is under the folder (`RoomFiles.relative`): the
    /// room's own folder only, whatever this phone may see of the Mac's other files. One over
    /// `RoomFiles.maxFileBytes` is refused (413).
    public func roomFile(_ room: String, path: String) async throws -> Data {
        try await bytes(["rooms", room, "files", "content"], query: [URLQueryItem(name: "path", value: path)])
    }

    /// A file of this phone's put into the room's shared folder (a picture picked here), as its bytes: where it is on
    /// the Mac now — under its name, or that name with a number when one was there — is what a message then comes with.
    public func putRoomFile(_ room: String, name: String, data: Data) async throws -> MacUploaded {
        try await perform("PUT", ["rooms", room, "files", "content"], query: [URLQueryItem(name: "name", value: name)], body: data,
                          timeout: Self.uploadTimeout, contentType: "application/octet-stream")
    }
}
