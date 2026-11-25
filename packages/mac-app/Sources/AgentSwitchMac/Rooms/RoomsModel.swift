import AgentSwitchMacCore
import AppKit
import Observation
import SwiftUI

/// The Chat Room page's state (docs/chatroom-v0.md §10): the rooms of the node the window is on, the room on screen,
/// what is being written, and what floats over the page. Everything it shows is the service's; each thing the user
/// does is one call, after which the room is read again.
@MainActor
@Observable
final class RoomsModel {
    /// What floats over the page: a room being made, sessions being added to the one on screen, or its name and topic
    /// being changed.
    enum Sheet: Equatable { case new, add, edit, notes, tasks, files, models, avatar, words }

    @ObservationIgnored var client: () -> DaemonClient = { fatalError("no client") }
    /// A made-up page for the design preview: shown as it is, the service never asked.
    @ObservationIgnored var demo = false
    /// The rooms are this Mac's own: a file's path is one this Mac has, so files can be picked and shown in Finder.
    var onThisMac = true

    private(set) var rooms: [RoomSummary] = []
    private(set) var room: Room?
    private(set) var rows: [RoomRow] = []
    /// The rooms were read at least once (an empty list is then "no rooms", not "not yet").
    private(set) var loaded = false
    /// The service could not be read.
    private(set) var error: String?
    /// What the last thing the user did came to, when it failed; gone with the next that works.
    private(set) var problem: String?
    /// The one room this page shows (the Dispatch page: the 调度台 room); nil: any of the list.
    var pinned: String? { didSet { if let pinned, selected != pinned { selected = pinned } } }
    var selected: String? {
        didSet {
            guard selected != oldValue else { return }
            room = nil
            rows = []
            roomVersion = nil
            replyTo = nil
            files = []
            card = nil
            taskFilter = nil
            draftTask = nil
            drawer = false
            closeSearch()
            taskSeen = [:]
            taskBase = nil
            if let selected, pinned == nil { UserDefaults.standard.set(selected, forKey: "roomsSelected") }
        }
    }

    // writing
    var draft = "" { didSet { if draft != oldValue { typed(); tokensChanged() } } }
    /// The `[Image #1]` / `[File …]` tokens standing in the box for the files (RoomAttachTokens).
    private var attachTokens = RoomAttachTokens()
    /// Put in at the cursor once: a file's token.
    private(set) var insert: InsertRequest?
    /// Put in place of the `@…` being typed once: a name taken from the list.
    private(set) var replace: ReplaceRequest?
    /// Where the caret is in the box (UTF-16); nil: not told yet, the end.
    private var caret: Int?
    var draftHeight: CGFloat = 0
    var replyTo: Int? { didSet { if let replyTo, let task = room?.messages.first(where: { $0.seq == replyTo })?.task { draftTask = task } } }
    /// The task the next message is about (its label, 2026-11-24): taken from the message answered, or the one the
    /// timeline is narrowed to; the user can change it beside the box. nil: about no one task.
    var draftTask: Int?
    /// The timeline narrowed to one task's messages (a label clicked); nil: all of them.
    var taskFilter: Int? {
        didSet {
            guard taskFilter != oldValue else { return }
            if let taskFilter { draftTask = taskFilter } else { draftTask = nil }
            if let room { rows = RoomRow.rows(room, task: taskFilter); seen(room) }
            if searching { Task { await runSearch() } }
        }
    }

    // the task drawer (2026-11-24, user #191: 任务栏收进抽屉)
    /// The drawer of the room's tasks is out.
    var drawer = false
    /// The last message the user has seen in each task's view, and below which all counted as seen when the room
    /// was opened: a task's count is what came for it since (Discord's channel counts).
    @ObservationIgnored private var taskSeen: [Int: Int] = [:]
    @ObservationIgnored private var taskBase: Int?

    /// What the user has not seen of one task.
    func unseen(task n: Int) -> Int {
        guard let room else { return 0 }
        let from = max(taskSeen[n] ?? 0, taskBase ?? room.room.readSeq)
        return room.messages.reduce(0) { $0 + ($1.task == n && $1.seq > from && $1.from != Room.you ? 1 : 0) }
    }

    /// The view shown now is seen: one task's, or all of them.
    private func seen(_ room: Room) {
        if taskBase == nil { taskBase = room.room.readSeq }
        let last = room.messages.last?.seq ?? 0
        if let taskFilter { taskSeen[taskFilter] = last } else { for t in room.tasks { taskSeen[t.n] = last } }
    }

    // searching (⌕)
    var searching = false
    var query = ""
    private(set) var found: [RoomMessage] = []
    private(set) var finding = false
    /// A result opened that the timeline has not loaded (an older one): shown whole in the results.
    var opened: Int?

    /// The design preview: what a search found and what waits on the user, as they are, the service never asked.
    func show(demoFound: [RoomMessage], attention items: [RoomAttention]) { found = demoFound; attention = items }

    func closeSearch() { searching = false; query = ""; found = []; opened = nil }

    func runSearch() async {
        guard let id = selected else { return }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { found = []; return }
        finding = true
        defer { finding = false }
        do {
            let answer = try await client().searchRoom(id, query: q, task: taskFilter)
            if q == query.trimmingCharacters(in: .whitespacesAndNewlines) { found = answer }
        } catch { problem = Self.say(error) }
    }

    /// A message to bring into view and light for a moment (a quote, a search result, an item of 等你处理).
    var jump: Int?

    /// Go to a message: in the timeline when it is loaded (the task narrowing let go when it hides it), else opened
    /// in the results.
    func go(to seq: Int) {
        guard let room else { return }
        guard let message = room.messages.first(where: { $0.seq == seq }) else { opened = seq; return }
        if let taskFilter, message.task != taskFilter { self.taskFilter = nil }
        searching = false
        jump = seq
    }

    // MARK: the room's replacement words (docs/model-gate-v0.md; user #343: in each room, only while the switch is on)

    /// The global switch of Settings › Redaction: off, a room has no words to set. This Mac's rooms only.
    private(set) var redactOn = false
    private(set) var roomWords: [RedactWord]?
    var wordsSaid: String?
    @ObservationIgnored private var redactLooked = Date.distantPast

    func lookRedact() async {
        guard onThisMac, !demo else { redactOn = demo; return }
        guard Date().timeIntervalSince(redactLooked) > 10 else { return }
        redactLooked = Date()
        redactOn = (try? await client().redaction().settings.enabled) ?? false
    }

    func loadRoomWords() {
        guard let id = selected else { return }
        Task { roomWords = (try? await client().roomRedactWords(id)) ?? [] }
    }

    func addRoomWord(_ value: String, replace: String) async -> Bool {
        guard let id = selected else { return false }
        do {
            let (_, warning) = try await client().addRedactWord(value.trimmingCharacters(in: .whitespaces), replace: replace.trimmingCharacters(in: .whitespaces), room: id)
            wordsSaid = warning
            roomWords = try await client().roomRedactWords(id)
            return true
        } catch {
            wordsSaid = (error as? CommandError)?.message ?? error.localizedDescription
            return false
        }
    }

    func removeRoomWord(_ w: RedactWord) {
        guard let id = selected else { return }
        Task {
            do { try await client().removeRedactWord(w.id, room: id); roomWords = try await client().roomRedactWords(id) }
            catch { wordsSaid = (error as? CommandError)?.message ?? error.localizedDescription }
        }
    }

    func show(demoWords: [RedactWord], said: String?) { roomWords = demoWords; wordsSaid = said }

    // avatars (2026-11-24, user #203)
    /// The member whose avatar the sheet chooses.
    private(set) var avatarSeat: String?
    private(set) var avatarLibrary: RoomAvatarLibrary?

    func chooseAvatar(_ handle: String) {
        avatarSeat = handle
        card = nil
        open(.avatar)
        if avatarLibrary == nil, !demo { Task { avatarLibrary = try? await client().avatarLibrary() } }
    }

    /// The design preview: the library as it is.
    func show(demoLibrary: RoomAvatarLibrary) { avatarLibrary = demoLibrary }

    func setAvatar(_ change: [String: Any]) {
        guard let id = selected, let handle = avatarSeat, let body = try? JSONSerialization.data(withJSONObject: change) else { return }
        Task {
            do { try await client().setAvatar(body, seat: handle, in: id); roomVersion = nil; await load() }
            catch { problem = Self.say(error) }
        }
    }

    // 等你处理 (2026-11-24, user #191: 顶部单独一个入口)
    private(set) var attention: [RoomAttention] = []
    var attentionShown = false
    var attentionCount: Int { rooms.reduce(0) { $0 + $1.attention } }

    func loadAttention() async {
        guard !demo else { return }
        if let items = try? await client().roomAttention() { attention = items }
    }

    /// An item of 等你处理 taken: its room, then its task, its message, or its member's card.
    func open(attention item: RoomAttention) {
        attentionShown = false
        selected = item.room
        Task {
            await load()
            switch item.kind {
            case .blocked: if let n = item.task { taskFilter = n }
            case .question: if let seq = item.seq { go(to: seq) }
            case .trust, .asks, .permission: card = item.handle
            default: break
            }
        }
    }
    /// Files the next message comes with, by their paths on this Mac (§3 附件).
    private(set) var files: [String] = []
    private(set) var focusRequests = 0
    private(set) var sending = false
    /// The names offered for the `@…` being typed, and the one the keys are on.
    private(set) var offered: [String] = []
    private(set) var offeredIndex = 0

    // what floats
    /// The file shown in a preview (Quick Look) now.
    var previewing: URL?
    var card: String?
    var sheet: Sheet?
    /// Which models admins may use under which profile, read when its sheet opens.
    private(set) var adminModels: RoomModels?
    /// What is in the room's shared folder, read when its sheet opens; nil: not read yet.
    private(set) var shared: RoomFiles?
    /// The sessions running on the node, for a sheet's list.
    private(set) var terminals: [TerminalInfo] = []
    var deleting = false

    @ObservationIgnored private var listVersion: String?
    @ObservationIgnored private var roomVersion: String?

    /// Words, or files alone: a picture says enough.
    var canSend: Bool { !sending && uploading == 0 && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty) && room != nil }
    var summary: RoomSummary? { rooms.first { $0.id == selected } }

    // MARK: reading

    /// The node changed: nothing of the one before stays.
    func reset() {
        rooms = []
        pictures = [:]
        asked = []
        loaded = false
        listVersion = nil
        selected = nil
        error = nil
        problem = nil
        draft = ""
        sheet = nil
    }

    func show(demo list: [RoomSummary], room: Room) {
        demo = true
        rooms = list
        loaded = true
        selected = room.room.id
        self.room = room
        rows = RoomRow.rows(room, task: taskFilter)
        seen(room)
    }

    /// The list alone: the rail's mark while another page is shown.
    func loadList() async {
        guard !demo else { return }
        do {
            if let answer = try await client().rooms(version: listVersion) {
                listVersion = answer.version
                if answer.value != rooms { rooms = answer.value }
            }
            loaded = true
            if error != nil { error = nil }
            if let pinned {
                if selected != pinned { selected = pinned }
            } else if selected == nil || !rooms.contains(where: { $0.id == selected }) {
                let kept = UserDefaults.standard.string(forKey: "roomsSelected")
                selected = rooms.first { $0.id == kept }?.id ?? rooms.first?.id
            }
        } catch {
            self.error = Self.say(error)
        }
    }

    /// The list and the room on screen; what the user had not seen of it is seen now.
    func load() async {
        guard !demo else { return }
        await lookRedact()
        await loadList()
        if attentionCount > 0 || !attention.isEmpty { await loadAttention() }
        guard let id = selected else { return }
        do {
            if let answer = try await client().room(id, version: roomVersion) {
                guard id == selected else { return }
                roomVersion = answer.version
                room = answer.value
                rows = RoomRow.rows(answer.value, task: taskFilter)
                seen(answer.value)
                typed()
            }
            if let room, room.room.id == id, room.room.lastSeq > room.room.readSeq {
                try? await client().markRead(room.room.lastSeq, in: id)
            }
        } catch {
            // A room deleted elsewhere: the list says so next time.
            self.error = Self.say(error)
        }
    }

    private static func say(_ error: Error) -> String { (error as? LocalizedError)?.errorDescription ?? String(describing: error) }

    // MARK: writing

    /// The box's text and caret as they change.
    func caretMoved(_ text: String, _ at: Int) {
        guard text == draft else { return }
        caret = at
        typed()
    }

    private func typed() {
        let at = min(caret ?? Int.max, (draft as NSString).length)
        guard let room, let query = RoomText.mention(in: draft, caret: at)?.query else {
            if !offered.isEmpty { offered = [] }
            return
        }
        let next = RoomText.offered(query, in: room)
        if next != offered { offered = next; offeredIndex = 0 }
    }

    /// The keys of the field while the names are offered: true when the list took the key.
    func key(_ key: ComposeKey) -> Bool {
        guard !offered.isEmpty else {
            if key == .escape, replyTo != nil { replyTo = nil; return true }
            return false
        }
        switch key {
        case .up: offeredIndex = (offeredIndex + offered.count - 1) % offered.count
        case .down: offeredIndex = (offeredIndex + 1) % offered.count
        case .tab, .enter: take(offered[offeredIndex])
        case .escape: offered = []
        }
        return true
    }

    func take(_ handle: String) {
        let at = min(caret ?? Int.max, (draft as NSString).length)
        if let range = RoomText.mention(in: draft, caret: at)?.range {
            replace = ReplaceRequest(range: range, text: "@\(handle) ")
        } else {
            draft = RoomText.completing(draft, with: handle)
        }
        offered = []
        focusRequests += 1
    }

    func mention(_ handle: String) {
        let lead = draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") ? "" : " "
        draft += "\(lead)@\(handle) "
        card = nil
        focusRequests += 1
    }

    func reply(to seq: Int) {
        replyTo = seq
        focusRequests += 1
    }

    /// Files dropped on the box or picked: added once each, ten at most (the service's limit).
    func attach(urls: [URL]) {
        guard onThisMac else { upload(urls: urls); return }
        attach(paths: urls.filter(\.isFileURL).map(\.path))
    }

    /// A room on another node: what is attached is put into its shared folder first, and comes along from there.
    private func upload(urls: [URL]) {
        let picked = urls.filter { url in url.isFileURL && !((try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false) }
        if picked.count < urls.count { problem = "文件夹不能发到别的机器上的房间，只能发文件。" }
        for url in picked {
            guard let data = try? Data(contentsOf: url) else { problem = "读不了 \(url.lastPathComponent)"; continue }
            upload(data, name: url.lastPathComponent)
        }
    }

    private func upload(_ data: Data, name: String) {
        guard let id = selected else { return }
        guard data.count <= 25 * 1024 * 1024 else { problem = "\(name) 太大（最多 25 MB）"; return }
        uploading += 1
        Task {
            do {
                let path = try await client().putRoomFile(data, name: name, in: id)
                if selected == id { attach(paths: [path]) }
            } catch {
                problem = "\(name) 没传上去：\(Self.say(error))"
            }
            uploading -= 1
        }
    }

    /// Files being put into a room on another node.
    private(set) var uploading = 0

    private func attach(paths: [String]) {
        var put: [String] = []
        for path in paths where !files.contains(path) && files.count < 10 {
            files.append(path)
            put.append(attachTokens.add(path))
        }
        if put.isEmpty { focusRequests += 1; return }
        let lead = draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") ? "" : " "
        insert = InsertRequest(text: lead + put.joined(separator: " ") + " ")
    }

    /// A file taken off with its `×`: its token goes from the box too.
    func detach(_ path: String) {
        files.removeAll { $0 == path }
        if let token = attachTokens.forget(path) {
            draft = draft.replacingOccurrences(of: token + " ", with: "").replacingOccurrences(of: token, with: "")
        }
    }

    /// A token deleted from the box takes its file off.
    private func tokensChanged() {
        if draft.isEmpty && files.isEmpty { attachTokens.clear(); return }
        for path in attachTokens.gone(in: draft) { files.removeAll { $0 == path } }
    }

    /// ⌘V with files or a picture on the clipboard: files come along by their paths; a picture (a screenshot, a copy
    /// from Preview) has no path, so it is written into the room's shared folder and comes along from there.
    func pasteFromClipboard() {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            attach(urls: urls)
            return
        }
        guard let image = DispatchModel.pastedImage(board) else { return }
        guard onThisMac else { upload(image.data, name: image.name); return }
        let folder = room?.folder.map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-attach")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var url = folder.appendingPathComponent(image.name)
            var n = 2
            while FileManager.default.fileExists(atPath: url.path) {
                url = folder.appendingPathComponent(image.name.replacingOccurrences(of: ".png", with: "-\(n).png"))
                n += 1
            }
            try image.data.write(to: url)
            attach(urls: [url])
        } catch {
            problem = "图片没能存下来：\(error.localizedDescription)"
        }
    }

    func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = onThisMac
        panel.canChooseFiles = true
        panel.prompt = "Attach"
        if panel.runModal() == .OK { attach(urls: panel.urls) }
    }

    /// A file a message came with, in a preview (Quick Look); one that is gone is said so.
    func preview(file path: String) {
        guard onThisMac else { return }
        guard FileManager.default.fileExists(atPath: path) else { problem = "文件不在了：\(path)"; return }
        previewing = URL(fileURLWithPath: path)
    }

    /// What a file of a room on another node is fetched for (user #255, #258: 点开就下载).
    enum Fetch { case open, preview, saveAs }

    /// A file of a room on another node: fetched from there (the folder's own by its place in it, any other a message
    /// came with by its whole path). `open`: into Downloads and opened in its app; `preview`: Quick Look; `saveAs`:
    /// where the user says.
    func fetch(file path: String, as how: Fetch) {
        guard let id = selected else { return }
        let name = (path as NSString).lastPathComponent
        let wanted: String
        if let folder = room?.folder, path.hasPrefix(folder + "/") { wanted = String(path.dropFirst(folder.count + 1)) } else { wanted = path }
        var target: URL?
        switch how {
        case .saveAs:
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            guard panel.runModal() == .OK, let url = panel.url else { return }
            target = url
        case .open:
            let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.homeDirectoryForCurrentUser
            target = Self.free(downloads.appendingPathComponent(name))
        case .preview:
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("agentswitch-room-files/\(id)", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            target = dir.appendingPathComponent(name)
        }
        guard let target else { return }
        Task {
            do {
                let data = try await client().roomFile(wanted, in: id)
                try data.write(to: target)
                switch how {
                case .open: NSWorkspace.shared.open(target)
                case .preview: previewing = target
                case .saveAs: NSWorkspace.shared.activateFileViewerSelecting([target])
                }
            } catch {
                problem = "\(name) 取不下来：\(Self.say(error))"
            }
        }
    }

    /// Pictures in a room on another node, made small once fetched (user #264: 其他节点发送的图片应该也可以看到),
    /// by room and path; a path being fetched or that could not be is in `asked`.
    private(set) var pictures: [String: NSImage] = [:]
    @ObservationIgnored private var asked: Set<String> = []

    /// A picture a message in a room on another node comes with: nil while it is fetched (asked for once).
    func picture(_ path: String) -> NSImage? {
        guard let id = selected, RoomPictures.isPicture(path) else { return nil }
        let key = "\(id)|\(path)"
        if let image = pictures[key] { return image }
        guard !asked.contains(key) else { return nil }
        asked.insert(key)
        let wanted: String
        if let folder = room?.folder, path.hasPrefix(folder + "/") { wanted = String(path.dropFirst(folder.count + 1)) } else { wanted = path }
        Task {
            guard let data = try? await client().roomFile(wanted, in: id), let image = RoomPictures.thumb(data: data) else { return }
            pictures[key] = image
        }
        return nil
    }

    /// `url`, or `name-2.ext`… when it is taken.
    private static func free(_ url: URL) -> URL {
        guard FileManager.default.fileExists(atPath: url.path) else { return url }
        let stem = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension, dir = url.deletingLastPathComponent()
        for n in 2... {
            let next = dir.appendingPathComponent(ext.isEmpty ? "\(stem)-\(n)" : "\(stem)-\(n).\(ext)")
            if !FileManager.default.fileExists(atPath: next.path) { return next }
        }
        return url
    }

    func reveal(_ path: String) {
        guard onThisMac else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func send() {
        guard canSend, let id = selected else { return }
        let text = draft, reply = replyTo, sent = files, task = draftTask
        sending = true
        Task {
            do {
                try await client().say(text, replyTo: reply, files: sent, task: task, in: id)
                if draft == text { draft = "" }
                if files == sent { files = []; attachTokens.clear() }
                replyTo = nil
                problem = nil
            } catch {
                self.problem = Self.say(error)
            }
            sending = false
            await load()
        }
    }

    // MARK: what the user does to a room

    /// 戳一下: what waits for the members is given now; who could not be reached is said as the problem.
    func poke(_ handles: [String]) {
        guard let id = selected else { return }
        act { client in
            var missed: [(handle: String, why: String)] = []
            for h in handles { missed += try await client.poke(room: id, handle: h) }
            if !missed.isEmpty { throw RoomsModel.Missed(text: missed.map { "@\($0.handle)：\($0.why)" }.joined(separator: "；")) }
        }
    }

    /// The message the user asked to delete, while its confirmation is open.
    var deletingMessage: RoomMessage?

    /// 删除消息 (user #278); `tell`: those who had it already are told to leave it aside.
    func delete(message seq: Int, tell: Bool) {
        guard let id = selected else { return }
        deletingMessage = nil
        act { client in try await client.deleteMessage(seq, in: id, tell: tell) }
    }

    /// 撤回 (user #288): deleted, and its sender and those who had it taken back to before it (Claude Code's). Who
    /// could not be is said (they were told to leave it aside instead).
    func recall(message seq: Int) {
        guard let id = selected else { return }
        deletingMessage = nil
        act { client in
            let missed = try await client.recallMessage(seq, in: id)
            if !missed.isEmpty { throw RoomsModel.NotRewound(text: missed.map { "@\($0.handle)：\($0.why)" }.joined(separator: "；")) }
        }
    }

    /// The mark on a seat's face is seen.
    func rewindSeen(_ handle: String) {
        guard let id = selected else { return }
        act { try await $0.rewindSeen(seat: handle, in: id) }
    }

    /// A seat whose files are being looked at before they are put back (退代码, user #290), and what that would do.
    var filesBack: (handle: String, files: [RewindFile])?

    func lookAtFilesBack(_ handle: String) {
        guard let id = selected, !demo else { return }
        Task {
            do { filesBack = (handle, try await client().rewindFiles(seat: handle, in: id)); problem = nil }
            catch { problem = Self.say(error) }
        }
    }

    func putFilesBack(_ handle: String, force: Bool) {
        guard let id = selected else { return }
        filesBack = nil
        act { _ = try await $0.putRewindFiles(seat: handle, in: id, force: force) }
    }

    private struct NotRewound: LocalizedError { let text: String; var errorDescription: String? { "这些成员没能退回，已发消息让它们忽略：\(text)" } }

    private struct Missed: LocalizedError { let text: String; var errorDescription: String? { "没戳到 \(text)" } }

    private func act(_ what: @escaping (DaemonClient) async throws -> Void) {
        guard !demo else { return }
        Task {
            do {
                try await what(client())
                problem = nil
            } catch {
                self.problem = Self.say(error)
            }
            await load()
        }
    }

    func setPaused(_ paused: Bool) {
        guard let id = selected else { return }
        act { try await $0.updateRoom(id, paused: paused) }
    }

    /// `OK` on the notice of many rounds: counted from here again; nothing was stopped.
    func roundsSeen() {
        guard let id = selected else { return }
        act { try await $0.roundsSeen(in: id) }
    }

    func saveNotes(_ text: String) {
        guard let id = selected else { return }
        sheet = nil
        act { try await $0.writeNotes(text, in: id) }
    }

    // MARK: the room's work (§9)

    func addTask(_ title: String, detail: String, owner: String?) {
        guard let id = selected else { return }
        act { try await $0.addTask(title, detail: detail, owner: owner, in: id) }
    }

    func setTask(_ n: Int, state: RoomTask.State) {
        guard let id = selected else { return }
        act { try await $0.setTask(n, state: state, in: id) }
    }

    /// Whose a task is; nil: nobody's.
    func setTask(_ n: Int, owner: String?) {
        guard let id = selected else { return }
        act { try await $0.setTask(n, owner: .some(owner), in: id) }
    }

    func deleteTask(_ n: Int) {
        guard let id = selected else { return }
        act { try await $0.deleteTask(n, in: id) }
    }

    func loadShared() {
        guard let id = selected, !demo else { return }
        Task {
            do { shared = try await client().roomFiles(id) } catch { problem = Self.say(error) }
        }
    }

    /// The room's shared folder, or a file in it, in Finder.
    func revealShared(_ path: String? = nil) {
        guard let folder = shared?.folder ?? room?.folder else { return }
        if let path { reveal(folder + "/" + path) } else if onThisMac { NSWorkspace.shared.open(URL(fileURLWithPath: folder)) }
    }

    func setCanAdd(_ on: Bool, seat: String) {
        guard let id = selected else { return }
        act { try await $0.setCanAdd(on, seat: seat, in: id) }
    }

    /// Muted or unmuted: it reads and works, but may not post in the room.
    func setMuted(_ on: Bool, seat: String) {
        guard let id = selected else { return }
        act { try await $0.setMuted(on, seat: seat, in: id) }
    }

    /// The same conversation behind an ended seat goes on in a new terminal; the card stays open to show it back.
    func resume(seat: String) {
        guard let id = selected else { return }
        act { try await $0.resumeSeat(seat, in: id) }
    }

    /// Out of the room (docs/chatroom-v0.md §6.2): the session itself keeps running.
    func kick(seat: String) {
        guard let id = selected else { return }
        card = nil
        act { try await $0.unseat(seat, in: id) }
    }

    /// Out of the room and its terminal closed; `delete`: its conversation's record deleted too.
    func end(seat: String, delete: Bool) {
        guard let id = selected else { return }
        card = nil
        act { try await $0.unseat(seat, close: delete ? "delete" : "end", in: id) }
    }

    /// A member's nickname in this room; its card closes (it is found under the new name).
    func rename(seat: String, to name: String) {
        guard let id = selected else { return }
        card = nil
        act { try await $0.renameSeat(seat, to: name, in: id) }
    }

    /// The sessions whose words matched (`harness:id` → the words around the match); nil when it could not be asked.
    func searchSaid(_ q: String) async -> [String: String]? {
        guard !demo, let hits = try? await client().searchSessions(q) else { return nil }
        return Dictionary(hits.map { ("\($0.harness):\($0.id)", $0.excerpt) }, uniquingKeysWith: { first, _ in first })
    }

    func loadAdminModels() {
        guard !demo else { return }
        Task { do { adminModels = try await client().roomModels() } catch { problem = Self.say(error) } }
    }

    /// One model on or off, for sessions a session starts under one profile.
    func setAdminModel(_ model: String, on: Bool, agent: String, profile: RoomModels.Profile) {
        guard !demo else { return }
        let off = on ? profile.off.filter { $0 != model } : profile.off + [model]
        Task {
            do { try await client().setRoomModels(off: off, agent: agent, profile: profile.id); adminModels = try await client().roomModels() } catch { problem = Self.say(error) }
        }
    }

    /// Every model of a profile on (`on`) or off at once.
    func setAllAdminModels(on: Bool, agent: String, profile: RoomModels.Profile, models: [RoomModels.Model]) {
        guard !demo else { return }
        let off = on ? [] : models.map(\.id)
        Task {
            do { try await client().setRoomModels(off: off, agent: agent, profile: profile.id); adminModels = try await client().roomModels() } catch { problem = Self.say(error) }
        }
    }

    /// What the last thing came to is put away (the banner's `×`).
    func dismissProblem() { problem = nil }

    /// A room a session already sits in, other than the one on screen (said beside it when sessions are offered).
    func roomHolding(_ terminal: String, besides room: String?) -> RoomSummary? {
        rooms.first { $0.id != room && $0.terminals.contains(terminal) }
    }

    func resumeAll() {
        guard let id = selected else { return }
        act { try await $0.resumeAll(in: id) }
    }

    func trustAll() {
        guard let id = selected else { return }
        act { try await $0.trustAll(in: id) }
    }

    /// `Always Trust`: the folders go on this Mac's list of trusted folders (agents started in them, or below them,
    /// no longer ask), then the members asking now are answered as by `Trust`. A folder the service refuses (the home
    /// folder, `/`) is said so, and nobody is answered.
    func trustAll(always folders: [String]) {
        guard let id = selected else { return }
        act { client in
            var list = try await client.trustedFolders()
            for folder in folders { list = list.adding(folder) }
            try await client.saveTrustedFolders(list)
            try await client.trustAll(in: id)
        }
    }

    func delete() {
        guard let id = selected else { return }
        sheet = nil
        act { client in
            try await client.deleteRoom(id)
            await MainActor.run { self.selected = nil }
        }
    }

    func open(_ sheet: Sheet) {
        self.sheet = sheet
        card = nil
        if sheet == .files { shared = demo ? RoomsDemo.files : nil; loadShared() }
        if sheet == .models { if demo { adminModels = RoomsDemo.models }; loadAdminModels() }
        if sheet == .words { wordsSaid = nil; roomWords = nil; loadRoomWords() }
        guard sheet == .new || sheet == .add, !demo else { return }
        Task {
            if let list = try? await client().terminals() { terminals = list.terminals.filter { $0.status != "exited" } }
        }
    }

    /// The sheet's primary button: a room made with the sessions picked, sessions added to the one on screen, or its
    /// name and topic changed.
    func finish(name: String, topic: String, picked: [String]) {
        guard let kind = sheet else { return }
        sheet = nil
        guard !demo else { return }
        let id = selected
        Task {
            do {
                switch kind {
                case .new:
                    let made = try await client().makeRoom(name: name, topic: topic, terminals: picked)
                    selected = made.room.id
                    problem = made.problems.isEmpty ? nil : made.problems.joined(separator: " ")
                case .add:
                    guard let id else { break }
                    var problems: [String] = []
                    for terminal in picked {
                        do { try await client().seat(terminal: terminal, in: id) } catch { problems.append(Self.say(error)) }
                    }
                    problem = problems.isEmpty ? nil : problems.joined(separator: " ")
                case .notes, .tasks, .files, .models, .avatar, .words: break
                case .edit:
                    guard let id else { break }
                    try await client().updateRoom(id, name: name, topic: topic)
                    problem = nil
                }
            } catch {
                self.problem = Self.say(error)
            }
            await load()
        }
    }
}
