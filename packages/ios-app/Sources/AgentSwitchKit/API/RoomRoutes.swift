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
private struct SayBody: Encodable { let text: String; let replyTo: Int? }
private struct ReadBody: Encodable { let seq: Int }
private struct NotesBody: Encodable { let text: String }
private struct NotesReply: Decodable { let notes: RoomNotes? }
private struct Nothing: Encodable {}
private struct SeatReply: Decodable { let seat: RoomSeat }
private struct SummaryReply: Decodable { let room: RoomSummary }
private struct ReadReply: Decodable { let readSeq: Int }
private struct Done: Decodable { let ok: Bool? }

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

    public func unseat(_ handle: String, in room: String) async throws {
        let _: Done = try await perform("DELETE", ["rooms", room, "seats", handle], query: [], body: nil)
    }

    /// The user speaks; who it is for is read from the `@names` in the text.
    @discardableResult
    public func say(_ text: String, in room: String, replyTo: Int? = nil) async throws -> RoomSaid {
        try await post(["rooms", room, "messages"], body: SayBody(text: text, replyTo: replyTo))
    }

    /// The user has seen up to `seq`.
    @discardableResult
    public func markRoomRead(_ room: String, upTo seq: Int) async throws -> Int {
        (try await post(["rooms", room, "read"], body: ReadBody(seq: seq)) as ReadReply).readSeq
    }

    /// The user has seen the sessions' rounds go by (`OK`): counted from here again. Nothing was stopped.
    public func roundsSeen(_ room: String) async throws {
        let _: Done = try await post(["rooms", room, "rounds", "ok"], body: Nothing())
    }

    /// The pinned notes, whole, in place of what was there; nil: they are empty now.
    @discardableResult
    public func setRoomNotes(_ room: String, text: String) async throws -> RoomNotes? {
        (try await send("PUT", ["rooms", room, "notes"], body: NotesBody(text: text)) as NotesReply).notes
    }
}
