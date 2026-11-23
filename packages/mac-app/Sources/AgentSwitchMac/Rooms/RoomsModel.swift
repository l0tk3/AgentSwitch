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
    enum Sheet: Equatable { case new, add, edit, notes, tasks, files }

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
    var selected: String? {
        didSet {
            guard selected != oldValue else { return }
            room = nil
            rows = []
            roomVersion = nil
            replyTo = nil
            files = []
            card = nil
            if let selected { UserDefaults.standard.set(selected, forKey: "roomsSelected") }
        }
    }

    // writing
    var draft = "" { didSet { if draft != oldValue { typed() } } }
    var draftHeight: CGFloat = 0
    var replyTo: Int?
    /// Files the next message comes with, by their paths on this Mac (§3 附件).
    private(set) var files: [String] = []
    private(set) var focusRequests = 0
    private(set) var sending = false
    /// The names offered for the `@…` being typed, and the one the keys are on.
    private(set) var offered: [String] = []
    private(set) var offeredIndex = 0

    // what floats
    var card: String?
    var sheet: Sheet?
    /// What is in the room's shared folder, read when its sheet opens; nil: not read yet.
    private(set) var shared: RoomFiles?
    /// The sessions running on the node, for a sheet's list.
    private(set) var terminals: [TerminalInfo] = []
    var deleting = false

    @ObservationIgnored private var listVersion: String?
    @ObservationIgnored private var roomVersion: String?

    var canSend: Bool { !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && room != nil }
    var summary: RoomSummary? { rooms.first { $0.id == selected } }

    // MARK: reading

    /// The node changed: nothing of the one before stays.
    func reset() {
        rooms = []
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
        rows = RoomRow.rows(room)
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
            if selected == nil || !rooms.contains(where: { $0.id == selected }) {
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
        await loadList()
        guard let id = selected else { return }
        do {
            if let answer = try await client().room(id, version: roomVersion) {
                guard id == selected else { return }
                roomVersion = answer.version
                room = answer.value
                rows = RoomRow.rows(answer.value)
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

    private func typed() {
        guard let room, let query = RoomText.mentionQuery(draft) else {
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
        draft = RoomText.completing(draft, with: handle)
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
        guard onThisMac else { return }
        for path in urls.filter(\.isFileURL).map(\.path) where !files.contains(path) && files.count < 10 { files.append(path) }
        focusRequests += 1
    }

    func detach(_ path: String) { files.removeAll { $0 == path } }

    /// ⌘V with files or a picture on the clipboard: files come along by their paths; a picture (a screenshot, a copy
    /// from Preview) has no path, so it is written into the room's shared folder and comes along from there.
    func pasteFromClipboard() {
        guard onThisMac else { return }
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            attach(urls: urls)
            return
        }
        guard let image = DispatchModel.pastedImage(board) else { return }
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
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.prompt = "Attach"
        if panel.runModal() == .OK { attach(urls: panel.urls) }
    }

    func reveal(_ path: String) {
        guard onThisMac else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func send() {
        guard canSend, let id = selected else { return }
        let text = draft, reply = replyTo, sent = files
        sending = true
        Task {
            do {
                try await client().say(text, replyTo: reply, files: sent, in: id)
                if draft == text { draft = "" }
                if files == sent { files = [] }
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

    func remove(seat: String) {
        guard let id = selected else { return }
        card = nil
        act { try await $0.unseat(seat, in: id) }
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
                case .notes, .tasks, .files: break
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
