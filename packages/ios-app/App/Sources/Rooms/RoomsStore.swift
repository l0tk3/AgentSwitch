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

    /// The dispatch desk (调度台) first, then the rest as the Mac lists them.
    var rooms: [RoomSummary] { list?.ordered ?? [] }
    /// Messages not seen yet: the tab's badge.
    var unread: Int { list?.unread ?? 0 }
    /// What waits on the user's hand in every room (等你处理), newest first; read when the list's count of them
    /// changes and while its page is on screen.
    private(set) var attention: [RoomAttentionItem] = []
    /// The list's count of them, at the last read of the items.
    @ObservationIgnored private var attentionAt: Int?
    /// How many things wait, as the list says.
    var attentionCount: Int { list?.attention ?? 0 }
    /// The items there were at the last read, by identity (room, kind, member, task, message); nil before the first
    /// read, whose items are not new to anyone (they were there when the app started).
    @ObservationIgnored private var attentionSeen: Set<String>?
    /// Items not there at the last read: the app tells of them (a notification while it is not in front).
    @ObservationIgnored var newAttention: ((@MainActor ([RoomAttentionItem]) -> Void))?

    /// The items read again; `always`: even when the list's count has not changed (their page is open).
    func refreshAttention(_ api: AgentSwitchAPI?, always: Bool = false) async {
        guard let api, !unsupported else { return }
        guard always || attentionAt != attentionCount else { return }
        let count = attentionCount
        do {
            let items = try await api.roomAttention().items
            attention = items
            attentionAt = count
            let ids = Set(items.map(\.id))
            if let seen = attentionSeen {
                let fresh = items.filter { !seen.contains($0.id) }
                if !fresh.isEmpty { newAttention?(fresh) }
            }
            // What went away and comes back later is new again.
            attentionSeen = ids
        } catch {
            // A Mac from before 等你处理: nothing to show.
            if case APIError.http(let status, _) = error, status == 404 || status == 403 { attention = []; attentionAt = count }
        }
    }

    func refresh(_ api: AgentSwitchAPI?) async {
        guard let api else { return }
        let asked = generation
        do {
            let fresh = try await api.rooms(etag: etag)
            guard asked == generation else { return }
            if let fresh { list = fresh.list; etag = fresh.etag }
            unsupported = false
            error = nil
            // Read again when the count changed — and when the list did while something waits: one item can take
            // another's place with the count the same.
            if attentionAt != attentionCount || (fresh != nil && attentionCount > 0) { await refreshAttention(api) }
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
        attention = []
        attentionAt = nil
        attentionSeen = nil
        unsupported = false
        error = nil
    }

    #if DEBUG
    /// The sample screens' rooms.
    func show(_ list: RoomList, attention: [RoomAttentionItem] = []) { self.list = list; self.attention = attention; attentionAt = list.attention }
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
    var draft = "" { didSet { if draft != oldValue { tokensChanged() } } }
    /// The `[Image #1]` tokens standing in the box for the pictures (RoomAttachTokens), by each one's id.
    @ObservationIgnored private var attachTokens = RoomAttachTokens()
    /// The message being answered; the Mac makes the reply about the task of what it answers.
    var replyTo: Int?
    /// The timeline narrowed to one task's messages (the task drawer, a task's tag); nil: `# 全部`. What is written
    /// while it is narrowed is about that task.
    var taskFilter: Int? {
        didSet {
            guard taskFilter != oldValue else { return }
            taskMessages = nil
            if let taskFilter { taskSeen[taskFilter] = byTask[taskFilter] ?? 0 }
        }
    }
    /// The task's own last messages, as the Mac gave them (`GET /rooms/:id/messages?task=`); nil until read — the
    /// ones the page has are shown meanwhile.
    private(set) var taskMessages: [RoomMessage]?
    /// Messages above the room's last page, read to reach one further up (a search's hit, a quote's original).
    private(set) var older: [RoomMessage] = []
    /// How many messages since the user last saw the room are about each task (`byTask`), and of those how many there
    /// were when the user last looked at that task: the drawer's counts are the difference.
    private(set) var byTask: [Int: Int] = [:]
    @ObservationIgnored private var taskSeen: [Int: Int] = [:]
    /// A message to bring into view and mark for a moment (a search's hit, a quote tapped, 等你处理).
    var focus: Int?
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
        // Each stands in the box as its token, at the end of what is written.
        draft = RoomAttachTokens.appended(taken.map { attachTokens.add($0.id.uuidString, name: $0.name) }, to: draft)
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
        if let token = attachTokens.forget(id.uuidString) { draft = RoomAttachTokens.removing(token, from: draft) }
    }

    /// A token deleted from the box takes its picture off (not while they are going).
    private func tokensChanged() {
        guard !sending else { return }
        if draft.isEmpty && attachments.isEmpty { attachTokens.clear(); return }
        let gone = Set(attachTokens.gone(in: draft))
        if !gone.isEmpty { attachments.removeAll { gone.contains($0.id.uuidString) } }
    }

    /// The words a message of pictures alone is written with: the service takes no message without words.
    static func wordsForPictures(_ n: Int) -> String { n == 1 ? "[图片]" : "[图片 × \(n)]" }

    func refresh(_ api: AgentSwitchAPI?) async {
        guard let api, !gone else {
            #if DEBUG
            if api == nil, let detail { byTask = RoomMessagePage.byTask(detail.messages, since: seenAtOpen ?? detail.room.readSeq) }
            #endif
            return
        }
        do {
            let before = detail?.room.lastSeq
            if let fresh = try await api.room(id, etag: etag) { take(fresh.room); etag = fresh.etag }
            error = nil
            if before != detail?.room.lastSeq || (taskFilter != nil && taskMessages == nil) || byTaskRead == nil { await readTasks(api) }
            await markRead(api)
        } catch APIError.http(let status, _) where status == 404 {
            gone = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The last page `byTask` was read at.
    @ObservationIgnored private var byTaskRead: Int?

    /// The narrowed task's own messages and the counts per task since the user last saw the room.
    private func readTasks(_ api: AgentSwitchAPI) async {
        let since = seenAtOpen ?? detail?.room.readSeq ?? 0
        let task = taskFilter
        do {
            let page = try await api.roomMessages(id, task: task, since: since, limit: task == nil ? 1 : 200)
            byTask = page.byTask
            byTaskRead = detail?.room.lastSeq
            if let task, task == taskFilter { taskMessages = page.messages; taskSeen[task] = byTask[task] ?? 0 }
        } catch {
            // A Mac from before the route: what the page has.
            if let detail {
                byTask = RoomMessagePage.byTask(detail.messages, since: since)
                byTaskRead = detail.room.lastSeq
                if let task, task == taskFilter { taskMessages = detail.messages.filter { $0.task == task } }
            }
        }
    }

    /// New messages about a task since the user last looked at it.
    func unread(task n: Int) -> Int { max(0, (byTask[n] ?? 0) - (taskSeen[n] ?? 0)) }

    /// The messages the timeline shows: the narrowed task's, or the room's with what was read above them.
    var shown: [RoomMessage] {
        guard let detail else { return [] }
        if let task = taskFilter {
            let have = taskMessages ?? (older + detail.messages).filter { $0.task == task }
            // What came since its page was read is added from the room's own.
            let last = have.last?.seq ?? 0
            return have + detail.messages.filter { $0.task == task && $0.seq > last }
        }
        guard let first = detail.messages.first?.seq else { return older }
        return older.filter { $0.seq < first } + detail.messages
    }

    /// The message by number, wherever the page has it.
    func message(_ seq: Int) -> RoomMessage? {
        detail?.message(seq) ?? older.first { $0.seq == seq } ?? taskMessages?.first { $0.seq == seq }
    }

    /// Bring a message into view: the task narrowed away when it is not about it, and the pages above read until it
    /// is there (a few at most).
    func reveal(_ seq: Int, api: AgentSwitchAPI?) async {
        if let task = taskFilter, message(seq)?.task != task { taskFilter = nil }
        if taskFilter == nil, !(shown.contains { $0.seq == seq }), let api {
            var tries = 0
            while tries < 10, let top = shown.first?.seq, top > seq {
                tries += 1
                guard let page = try? await api.roomMessages(id, before: top, limit: 200), !page.messages.isEmpty else { break }
                older = (page.messages + older).sorted { $0.seq < $1.seq }
            }
        }
        focus = seq
    }

    /// The words found, newest first: in the task the timeline is narrowed to, or in the whole room.
    func search(_ query: String, api: AgentSwitchAPI?) async throws -> [RoomMessage] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        guard let api else {
            // The sample screens: what the page has.
            return shown.filter { $0.text.range(of: q, options: [.caseInsensitive]) != nil }.reversed()
        }
        return try await api.roomMessages(id, task: taskFilter, query: q, limit: 100).messages
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
            // In a task, about it; in `# 全部`, about the task its first word names (`T3 …`), else none — a reply is
            // about what it answers, which the Mac knows.
            let task = taskFilter ?? (replyTo == nil ? RoomMessage.taskNamed(at: text, tasks: detail?.tasks ?? []) : nil)
            try await api.say(text, in: id, replyTo: replyTo, files: paths, task: task)
            draft = ""
            attachments = []
            attachTokens.clear()
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
