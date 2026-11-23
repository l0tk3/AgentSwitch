import AgentSwitchKit
import Foundation
import Observation
import SwiftUI

/// The Rooms tab's data (docs/chatroom-v0.md §10): the rooms on the Mac shown. Read with the version the list has, so
/// an unchanged one costs nothing; often while the tab is on screen, now and then from the other tabs (the tab's
/// badge), seldom from a Mac that has no Chat Room.
@MainActor
@Observable
final class RoomsStore {
    private(set) var list: RoomList?
    /// The Mac shown is from before Chat Room.
    private(set) var unsupported = false
    /// The last read failed (kept list shown); cleared by the next good one.
    var error: String?
    @ObservationIgnored private var etag: String?
    /// Bumped by `reset` (another Mac): a read that started before it is dropped.
    @ObservationIgnored private var generation = 0

    static let pollInterval: Duration = .seconds(3)
    static let backgroundInterval: Duration = .seconds(20)
    static let unsupportedInterval: Duration = .seconds(60)

    var rooms: [RoomSummary] { list?.rooms ?? [] }
    /// Messages not seen yet: the tab's badge.
    var unread: Int { list?.unread ?? 0 }

    func refresh(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        let asked = generation
        do {
            let fresh = try await api.rooms(etag: etag)
            guard asked == generation else { return }
            if let fresh { list = fresh.list; etag = fresh.etag }
            unsupported = false
            error = nil
        } catch is RoomsUnsupported {
            guard asked == generation else { return }
            unsupported = true
            list = RoomList(rooms: [])
            etag = nil
            error = nil
        } catch {
            if asked == generation { self.error = error.localizedDescription }
        }
    }

    func reset() {
        generation += 1
        list = nil
        etag = nil
        unsupported = false
        error = nil
    }

    #if DEBUG
    /// The sample screens' rooms.
    func show(_ list: RoomList) { self.list = list }
    #endif
}

/// One room's page: the room as the Mac last gave it, what is being written, and what the user does in it.
@MainActor
@Observable
final class RoomPageModel {
    let id: String
    private(set) var detail: RoomDetail?
    /// The room was deleted (here or elsewhere): the page closes.
    private(set) var gone = false
    var error: String?
    var draft = ""
    /// The message being answered.
    var replyTo: Int?
    private(set) var sending = false
    /// The pictures picked here to go with the next message (`RoomMessage.maxFiles` at most).
    private(set) var attachments: [RoomAttachment] = []
    /// Picked pictures are being read and shrunk.
    private(set) var preparing = false
    /// Which of the pictures is being put into the room's shared folder, counted from 1.
    private(set) var uploading: Int?
    /// Why the last message, or a picture for it, did not go: said above the box until the next try (the page's own
    /// error is cleared by the next good read of the room).
    var sendError: String?
    /// What the user had seen when the page opened: later messages that name the user are marked until it closes.
    private(set) var seenAtOpen: Int?
    @ObservationIgnored private var etag: String?
    @ObservationIgnored private var marking = false

    static let pollInterval: Duration = .seconds(2)

    init(id: String, detail: RoomDetail? = nil) {
        self.id = id
        self.detail = detail
        seenAtOpen = detail?.room.readSeq
    }

    /// Words, or pictures alone.
    var canSend: Bool { !sending && !preparing && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) }
    /// How many more pictures the next message may take.
    var attachmentRoom: Int { max(0, RoomMessage.maxFiles - attachments.count) }

    /// Pictures picked here join what waits above the box, as far as a message takes them.
    func attach(_ files: [UploadFile]) async {
        guard !files.isEmpty else { return }
        preparing = true
        defer { preparing = false }
        let made = await Task.detached(priority: .userInitiated) { RoomAttachment.prepared(files) }.value
        let taken = Array(made.ready.prefix(attachmentRoom))
        attachments += taken
        if made.unread > 0 {
            sendError = "有 \(made.unread) 张图片读不出来或超过 25 MB，没有加上。"
        } else if taken.count < made.ready.count {
            sendError = "一条消息最多带 \(RoomMessage.maxFiles) 个文件，多出的没有加上。"
        } else {
            sendError = nil
        }
    }

    func removeAttachment(_ id: UUID) {
        guard !sending else { return }
        attachments.removeAll { $0.id == id }
    }

    /// The words a message of pictures alone is written with: the service takes no message without words.
    static func wordsForPictures(_ n: Int) -> String { n == 1 ? "[图片]" : "[图片 × \(n)]" }

    func refresh(_ api: AgentSwitchAPI?) async {
        guard let api, !gone else { return }
        do {
            if let fresh = try await api.room(id, etag: etag) { take(fresh.room); etag = fresh.etag }
            error = nil
            await markRead(api)
        } catch APIError.http(let status, _) where status == 404 {
            gone = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func take(_ fresh: RoomDetail) {
        if seenAtOpen == nil { seenAtOpen = fresh.room.readSeq }
        detail = fresh
    }

    /// While the room is on screen, what is in it is seen.
    private func markRead(_ api: AgentSwitchAPI) async {
        guard let room = detail?.room, room.lastSeq > room.readSeq, !marking else { return }
        marking = true
        defer { marking = false }
        _ = try? await api.markRoomRead(id, upTo: room.lastSeq)
    }

    /// The user's words go — the pictures picked first, each put into the room's shared folder, and the message then
    /// comes with where they are. The box is emptied once the Mac has it, and the room is read again at once; when
    /// something fails the words and the pictures stay, and one already on the Mac is not put there again.
    func send(_ api: AgentSwitchAPI?) async {
        guard let api, canSend else { return }
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = words.isEmpty ? Self.wordsForPictures(attachments.count) : words
        sending = true
        sendError = nil
        defer { sending = false; uploading = nil }
        do {
            var paths: [String] = []
            for (n, item) in attachments.enumerated() {
                if let path = item.path { paths.append(path); continue }
                uploading = n + 1
                let put = try await api.putRoomFile(id, name: item.name, data: item.data)
                if let i = attachments.firstIndex(where: { $0.id == item.id }) { attachments[i].path = put.path }
                paths.append(put.path)
            }
            uploading = nil
            try await api.say(text, in: id, replyTo: replyTo, files: paths)
            draft = ""
            attachments = []
            replyTo = nil
            etag = nil
            await refresh(api)
        } catch {
            sendError = Self.sendSentence(error)
        }
    }

    private static func sendSentence(_ error: Error) -> String {
        if case APIError.http(let status, _) = error, status == 413 { return "图片超过 25 MB，没有发出。" }
        return "没有发出：\(error.localizedDescription)"
    }

    /// Something done to the room or one of its seats, then the room read again; false and why when the Mac refuses.
    @discardableResult
    func run(_ api: AgentSwitchAPI?, _ work: (AgentSwitchAPI) async throws -> Void) async -> Bool {
        guard let api else { return false }
        do {
            try await work(api)
            etag = nil
            await refresh(api)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    func delete(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        do { try await api.deleteRoom(id); gone = true } catch { self.error = error.localizedDescription }
    }
}
