import AgentSwitchMacCore
import AppKit
import SwiftUI

/// A pane's simple view (docs/simple-view-v0.md §1, §5.2): the record of the terminal's session — the latest page, the
/// earlier ones asked for, the agent's task list, how full its context is — what the agent is doing now, and the reply
/// being written. While a pane shows it, the pane's screen has no stream of its own and holds no size: the terminal's
/// events (its status, the requests it waits on) come with this one's, which also says when the record changed.
@MainActor
@Observable
final class PaneRecord {
    private(set) var items: [RecordItem] = []
    private(set) var plan: [PlanEntry] = []
    private(set) var usage: RecordUsage?
    private(set) var mode: String?
    /// There is more before what is shown.
    private(set) var more = false
    /// Read at least once (an empty record is then really empty).
    private(set) var loaded = false
    private(set) var loadingEarlier = false
    private(set) var activity: TerminalActivity?
    private(set) var subagents: [TerminalSubagent] = []
    /// When what it is doing now began.
    private(set) var activitySince: Date?
    /// How far the turn has come, as the agent's own screen counts it (nil: it says nothing).
    private(set) var progress: TurnProgress?
    /// Replies sent that the record does not hold yet: shown at its end meanwhile (`shown`).
    private(set) var sent: [SentReply] = []
    /// The model the agent says it is on now (Claude Code), once it has said.
    private(set) var modelNow: String?
    /// Codex's Daybreak switch as its stream said last (nil: nothing said yet — the terminal's own word stands).
    private(set) var daybreakNow: Bool?
    /// How it asks now, as the terminal's stream said or as a change asked for here left it.
    private(set) var modeNow: String?
    /// What Claude Code offers as your next message (its prompt suggestion), while it shows one; said in the empty
    /// reply box, taken with tab.
    private(set) var suggestion: String?
    /// The thinking level just asked for here, until the record says one of its own.
    private(set) var effortAsked: String?
    /// A change of model or level is on its way to the agent.
    private(set) var changing = false
    private(set) var error: String?

    // The reply being written.
    var draft = ""
    var draftHeight = ComposeField.minHeight
    private(set) var sending = false
    /// Each change puts the keyboard in the reply box.
    private(set) var focusRequests = 0
    /// The reply's files (docs/terminal-v0.md §4): each stands in the text as its placeholder, where it was dropped.
    private(set) var draftFiles: [DraftFile] = []
    /// Placeholders to type at the box's caret, once.
    private(set) var insert: InsertRequest?

    // What the box offers for what is being typed (docs/simple-view-v0.md §5.5): rows to take, or a line on what a
    // first character does.
    private(set) var hints: [ReplyHintRow] = []
    private(set) var hintPick = 0
    private(set) var hintMark: ReplyHints.Mark?
    /// A row taken: typed in place of what asked for it, once.
    private(set) var replace: ReplaceRequest?
    var hintsOpen: Bool { !hints.isEmpty || hintMark != nil }
    /// The agent's commands, asked for once per terminal (a list is narrowed here as the name is typed).
    @ObservationIgnored private var commands: (terminal: String, all: [SlashCommand])?
    @ObservationIgnored private var hinting: Task<Void, Never>?
    /// The text at which esc put the list away: it stays away until the text is another.
    @ObservationIgnored private var hintsPutAway: String?

    /// One file of the reply being written.
    struct DraftFile: Identifiable, Equatable {
        let id = UUID()
        let token: String
        let number: Int
        let isImage: Bool
        let name: String
        let thumbnail: NSImage?
        /// Where it is on this Mac: its path is typed, nothing is copied. Nil for a picture off the clipboard, which has
        /// no file behind it: `pasted` goes to the service first.
        let path: String?
        let pasted: DispatchUploadFile?

        static func == (a: DraftFile, b: DraftFile) -> Bool { a.id == b.id }
    }
    /// The transcript in full: every run of work open, thinking shown.
    var verbose = false
    /// The side's files shown with their diff.
    var openFiles: Set<String> = []
    /// What a run of work changed, by its item's id, once asked for.
    private(set) var diffs: [String: [FileDiff]] = [:]

    /// The design preview's: the step (`<run's id>/<its place>`) drawn opened.
    static var previewOpenStep: String?

    @ObservationIgnored private var terminal: String?
    @ObservationIgnored private var harness = ""
    @ObservationIgnored private var session: String?
    @ObservationIgnored private var cursor: Int64 = 0
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var following: Task<Void, Never>?
    @ObservationIgnored private var client: () -> DaemonClient = { DaemonClient(port: 1) }
    /// The design preview put a record here: nothing is asked of a service.
    @ObservationIgnored private var staged = false

    var hasSession: Bool { session != nil }
    var sessionId: String? { session }
    var agent: String { harness }

    /// Follows `terminal` (already following it: only what the list now knows of it is taken). `frame`: each of the
    /// stream's frames, for the terminal's own model (status, requests, exit).
    func follow(_ info: TerminalInfo, client: @escaping () -> DaemonClient, frame: @escaping (_ event: String, _ data: String) -> Void) {
        if staged { return }
        self.client = client
        if terminal != info.id {
            stop()
            terminal = info.id
            harness = info.harness
            let id = info.id
            following = Task { [weak self] in
                for await message in client().recordEvents(id: id) {
                    guard let self, !Task.isCancelled else { return }
                    frame(message.event, message.data)
                    self.took(message.event, message.data)
                }
            }
        }
        if info.status != "working" { stillNow() }
        // The agent says which session it writes a moment after it starts; a `/clear` or a fork changes it.
        guard info.agentSessionId != session || info.harness != harness else { return }
        harness = info.harness
        session = info.agentSessionId
        items = []; plan = []; usage = nil; mode = nil; more = false; cursor = 0; error = nil; effortAsked = nil
        openFiles = []; diffs = [:]
        loaded = session == nil
        refresh()
    }

    func stop() {
        following?.cancel()
        following = nil
        terminal = nil
        session = nil
        items = []; plan = []; usage = nil; mode = nil; more = false; cursor = 0; loaded = false; error = nil
        activity = nil; subagents = []; activitySince = nil; modelNow = nil; effortAsked = nil; modeNow = nil; suggestion = nil; daybreakNow = nil
        progress = nil; sent = []
        draft = ""
        draftFiles = []
        insert = nil
        openFiles = []; diffs = [:]
    }

    /// What the run of work `work` changed, read again (it may still be going).
    func loadChanges(work: String) async {
        guard !staged, let id = session else { return }
        let files = (try? await client().sessionChanges(harness: harness, id: id, work: work)) ?? []
        guard id == session else { return }
        if diffs[work] != files { diffs[work] = files }
    }

    private func took(_ event: String, _ data: String) {
        switch TerminalRecordEvent.decode(event: event, data: data) {
        case .activity(let now, let agents):
            if now != activity { activity = now; activitySince = Date() }
            if subagents != agents { subagents = agents }
        case .progress(let now):
            if progress != now { progress = now }
        case .sent(let replies):
            if sent != replies { sent = replies }
        case .record:
            refresh()
        case .model(let model):
            modelNow = model
        case .mode(let mode):
            modeNow = mode
        case .suggestion(let text):
            suggestion = text
        case .daybreak(let on):
            daybreakNow = on
        case nil:
            // A turn began or ended: its clock starts over, and what the record holds may have moved on.
            if event == "status" { activitySince = Date(); refresh() }
        }
    }

    /// What the record shows: its items, and at their end what was sent and is not in them yet.
    func shown(working: Bool) -> [RecordItem] { SessionRecord.withSent(items: items, sent: sent, working: working) }

    private func stillNow() {
        if progress != nil { progress = nil }
        if activity != nil { activity = nil }
        if !subagents.isEmpty { subagents = [] }
    }

    /// The latest page. Asked for again while one is on its way, it is read once more after that one.
    func refresh() {
        guard let id = session else { return }
        if reading { again = true; return }
        reading = true
        let harness = harness, client = client
        Task { [weak self] in
            defer { self?.reading = false }
            repeat {
                self?.again = false
                do {
                    let page = try await client().sessionRecord(harness: harness, id: id)
                    guard let self, id == self.session else { return }
                    self.take(page)
                } catch {
                    guard let self, id == self.session else { return }
                    // Not listed yet (a session seconds old) reads as an empty record, not as an error.
                    if !self.loaded { self.loaded = true }
                }
            } while self?.again == true
        }
    }

    private func take(_ page: SessionRecord) {
        if plan != page.plan { plan = page.plan }
        // The record names a level of its own again (changed on the agent's own screen): that is the one in force.
        if usage?.effort != page.usage?.effort, usage != nil { effortAsked = nil }
        if usage != page.usage { usage = page.usage }
        if mode != page.mode { mode = page.mode }
        let (next, replaced) = SessionRecord.merged(held: items, page: page.items)
        if items != next { items = next }
        if replaced { cursor = page.cursor; more = page.more }
        loaded = true
        error = nil
    }

    /// The page before the earliest shown.
    func earlier() {
        guard let id = session, more, !loadingEarlier else { return }
        loadingEarlier = true
        let harness = harness, client = client, before = cursor
        Task { [weak self] in
            defer { self?.loadingEarlier = false }
            guard let page = try? await client().sessionRecord(harness: harness, id: id, limit: 80, before: before), let self, id == self.session else { return }
            let known = Set(self.items.map(\.id))
            self.items = page.items.filter { !known.contains($0.id) } + self.items
            self.cursor = page.cursor
            self.more = page.more
        }
    }

    // MARK: replying

    func focusReply() { focusRequests += 1 }

    var canSend: Bool { !sending && terminal != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The reply typed into the terminal as it is and entered, as the keyboard would; each file's path where its
    /// placeholder stands, as a terminal types a file dragged onto it (a picture's path is a picture to the agent).
    func send() {
        guard canSend, let terminal else { return }
        let text = draft
        let files = draftFiles.filter { text.contains($0.token) }
        sending = true
        let client = client
        Task { [weak self] in
            defer { self?.sending = false }
            do {
                var refs = files.compactMap { file in file.path.map { TerminalReplyFile(token: file.token, path: $0) } }
                // A picture off the clipboard has no path yet: the service keeps it with the terminal's files.
                let pasted = files.filter { $0.path == nil }
                if !pasted.isEmpty {
                    let staged = try await client().upload(pasted.compactMap(\.pasted))
                    guard staged.count == pasted.count else { throw DaemonError.unreachable("图片未能送达") }
                    refs += zip(pasted, staged).map { TerminalReplyFile(token: $0.token, upload: $1.id) }
                }
                try await client().typeIntoTerminal(id: terminal, text: text, files: refs)
                guard let self else { return }
                if self.draft == text { self.draft = ""; self.draftFiles = []; self.hinting?.cancel(); self.closeHints() }
                self.suggestion = nil   // it was for the message before this one
                self.error = nil
            } catch {
                self?.error = (error as? DaemonError)?.reason ?? error.localizedDescription
            }
        }
    }

    // MARK: what the box offers

    /// The reply's text or its caret changed: what it asks for now.
    func typing(_ text: String, caret: Int) {
        hinting?.cancel()
        guard let terminal, !staged else { return }
        if text == hintsPutAway { return closeHints() }
        hintsPutAway = nil
        switch ReplyHints.ask(text: text, caret: caret, harness: harness) {
        case nil:
            closeHints()
        case .mark(let mark):
            hints = []; hintPick = 0
            hintMark = mark
        case .commands(let typed):
            hintMark = nil
            let range = NSRange(location: 0, length: caret)
            let rows = { (all: [SlashCommand]) in
                ReplyHints.matching(typed, in: all).map { c in
                    ReplyHintRow(kind: .command, title: c.name, detail: c.description, tag: c.source == "builtin" ? nil : c.source, range: range, typed: ReplyHints.typed(command: c))
                }
            }
            if let commands, commands.terminal == terminal { return offer(rows(commands.all)) }
            let client = client
            hinting = Task { [weak self] in
                guard let all = try? await client().terminalCommands(id: terminal), !Task.isCancelled, let self else { return }
                self.commands = (terminal, all)
                self.offer(rows(all))
            }
        case .files(let query, let at):
            hintMark = nil
            let range = NSRange(location: at, length: caret - at)
            let harness = harness, client = client
            hinting = Task { [weak self] in
                // Not a request per key: the list is asked for once the typing has paused a moment.
                try? await Task.sleep(for: .milliseconds(90))
                guard !Task.isCancelled, let files = try? await client().terminalFiles(id: terminal, query: query), !Task.isCancelled else { return }
                self?.offer(files.prefix(ReplyHints.shown).map { path in
                    let parts = ReplyHints.parts(of: path)
                    return ReplyHintRow(kind: .file, title: parts.name, detail: parts.folder, range: range, typed: ReplyHints.typed(file: path, harness: harness))
                })
            }
        }
    }

    private func offer(_ rows: [ReplyHintRow]) {
        if rows != hints { hints = rows }
        hintPick = min(hintPick, max(0, rows.count - 1))
    }

    private func closeHints() {
        if !hints.isEmpty { hints = [] }
        if hintMark != nil { hintMark = nil }
        hintPick = 0
    }

    /// A key while the list is open: ↑ ↓ move, tab or return takes the row picked, esc puts the list away. False: the
    /// key is the field's own.
    func hintKey(_ key: ComposeKey) -> Bool {
        guard !hints.isEmpty else {
            if key == .escape, hintMark != nil { hintsPutAway = draft; closeHints(); return true }
            // What it offers as your next message, in the empty box: tab writes it in, yours to change or send.
            if key == .tab, draft.isEmpty, let suggestion {
                replace = ReplaceRequest(range: NSRange(location: 0, length: 0), text: suggestion)
                return true
            }
            return false
        }
        switch key {
        case .up: hintPick = (hintPick + hints.count - 1) % hints.count
        case .down: hintPick = (hintPick + 1) % hints.count
        case .tab, .enter: take(hints[min(hintPick, hints.count - 1)])
        case .escape: hintsPutAway = draft; closeHints()
        }
        return true
    }

    func take(_ row: ReplyHintRow) {
        hinting?.cancel()
        replace = ReplaceRequest(range: row.range, text: row.typed)
        closeHints()
        focusRequests += 1
    }

    // MARK: the reply's files

    /// Files from the disk (dragged in, `Files…`, copied in Finder): kept for the reply, their placeholders typed where
    /// the caret is. A folder too: its path is typed, as a terminal types it.
    func attach(urls: [URL]) {
        guard terminal != nil else { return }
        var tokens: [String] = []
        for url in urls where url.isFileURL {
            let path = url.standardizedFileURL.path
            var folder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &folder) else { error = "\(url.lastPathComponent) 无法读取"; continue }
            if draftFiles.contains(where: { $0.path == path }) { continue }
            let image = !folder.boolValue && TerminalDraft.isImage(name: url.lastPathComponent)
            let name = url.lastPathComponent + (folder.boolValue ? "/" : "")
            guard let token = add(name: name, image: image, thumbnail: image ? RecordPictureStore.image(url: url, side: 104) : nil, path: path, pasted: nil) else { break }
            tokens.append(token)
        }
        type(tokens)
    }

    /// `Paste Image` (⌘V with files or a picture on the clipboard).
    func pasteFromClipboard() {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return attach(urls: urls)
        }
        guard terminal != nil else { return }
        guard let picture = DispatchModel.pastedImage(board) else { error = "剪贴板中无图片"; return }
        guard picture.data.count <= DispatchUploadFile.maxFileBytes else { error = "图片超过 50 MB"; return }
        guard let token = add(name: picture.name, image: true, thumbnail: RecordPictureStore.image(picture.data, side: 104), path: nil, pasted: picture) else { return }
        type([token])
    }

    /// `Files…`: the system's open panel, several files or folders.
    func chooseFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        guard panel.runModal() == .OK else { return }
        attach(urls: panel.urls)
    }

    /// Takes a file out, its placeholder with it.
    func remove(_ file: DraftFile) {
        draftFiles.removeAll { $0.id == file.id }
        draft = TerminalDraft.remove(file.token, from: draft)
    }

    /// A placeholder deleted from the box: its file goes too.
    func keepDraftFiles() {
        // What was just added is typed into the box a moment later: it is not gone.
        let waiting = Set(insert?.tokens ?? [])
        let kept = draftFiles.filter { draft.contains($0.token) || waiting.contains($0.token) }
        if kept.count != draftFiles.count { draftFiles = kept }
        if !waiting.isEmpty, waiting.allSatisfy({ draft.contains($0) }) { insert = nil }
    }

    private func add(name: String, image: Bool, thumbnail: NSImage?, path: String?, pasted: DispatchUploadFile?) -> String? {
        guard draftFiles.count < TerminalDraft.maxFiles else { error = "每次最多 \(TerminalDraft.maxFiles) 个附件"; return nil }
        let number = (draftFiles.map(\.number).max() ?? 0) + 1
        let token = TerminalDraft.token(image: image, number: number)
        draftFiles.append(DraftFile(token: token, number: number, isImage: image, name: name, thumbnail: thumbnail, path: path, pasted: pasted))
        return token
    }

    private func type(_ tokens: [String]) {
        guard !tokens.isEmpty else { return }
        error = nil
        insert = InsertRequest(text: "", tokens: tokens)
        focusReply()
    }

    // MARK: its model, how hard it thinks

    /// Another model for the Claude Code in the terminal, while it rests (it keeps it as the default for new sessions).
    func setModel(_ id: String) {
        guard let terminal, !changing else { return }
        changing = true
        let client = client
        Task { [weak self] in
            defer { self?.changing = false }
            do {
                try await client().setTerminalModel(id: terminal, model: id)
                self?.error = nil
            } catch {
                self?.error = Self.refused(error, busy: "它正在工作或等待回答，结束后再切换模型。")
            }
        }
    }

    /// Another way of asking for the Claude Code in the terminal, while it rests: the service presses its ⇧Tab until its
    /// screen names the mode. A mode this session does not offer (skipping permissions in one started without it) is
    /// said as such.
    func setMode(_ raw: String, name: String) {
        guard let terminal, !changing else { return }
        changing = true
        let client = client
        Task { [weak self] in
            defer { self?.changing = false }
            do {
                let reached = try await client().setTerminalMode(id: terminal, mode: raw)
                self?.modeNow = reached
                self?.error = nil
            } catch {
                if case .http(status: 400, message: _)? = error as? DaemonError {
                    self?.error = "这个会话不能切到 \(name)：它启动时没有开放这种方式。"
                } else {
                    self?.error = Self.refused(error, busy: "它正在工作或等待回答，结束后再切换。")
                }
            }
        }
    }

    /// Codex's Daybreak switch turned (docs/simple-view-v0.md §5.8): the service types Codex's own command and waits
    /// until Codex says so, which takes a moment.
    func setDaybreak(_ on: Bool) {
        guard let terminal, !changing else { return }
        changing = true
        let client = client
        Task { [weak self] in
            defer { self?.changing = false }
            do {
                self?.daybreakNow = try await client().setTerminalDaybreak(id: terminal, on: on)
                self?.error = nil
            } catch {
                self?.error = Self.refused(error, busy: "Codex 没有切换：它正在等待回答，或它的屏幕上写着原因。")
            }
        }
    }

    /// Another thinking level for it (it takes one while it works too: the next request of the turn runs at it).
    func setEffort(_ level: String) {
        guard let terminal, !changing else { return }
        changing = true
        let was = effortAsked
        effortAsked = level
        let client = client
        Task { [weak self] in
            defer { self?.changing = false }
            do {
                try await client().setTerminalEffort(id: terminal, effort: level)
                self?.error = nil
            } catch {
                self?.effortAsked = was
                self?.error = Self.refused(error, busy: "它正在等待回答，回答后再调整。")
            }
        }
    }

    /// Why a change was not made, as the page says it: the service's 409 (the agent is busy — the menu and the slider
    /// say so beforehand, this is for the moment in between) in the page's own words, anything else as the service put it.
    private static func refused(_ error: Error, busy: String) -> String {
        if case .http(status: 409, message: _)? = error as? DaemonError { return busy }
        let reason = (error as? DaemonError)?.reason ?? error.localizedDescription
        return RecordDisplay.refusal(reason) ?? reason
    }

    /// Types a command of the agent's own (`/model`): its picker opens on its screen.
    func type(command: String) {
        guard let terminal else { return }
        let client = client
        Task { [weak self] in
            do { try await client().typeIntoTerminal(id: terminal, text: command) } catch { self?.error = (error as? DaemonError)?.reason ?? error.localizedDescription }
        }
    }

    /// While it works: stop it (esc, as in the terminal).
    func interrupt() {
        guard let terminal else { return }
        let client = client
        Task { try? await client().terminalKeys(id: terminal, ["esc"]) }
    }

    #if DEBUG
    /// The design preview's: a record from made-up work, without a service.
    func stage(terminal: TerminalInfo, items: [RecordItem], plan: [PlanEntry], usage: RecordUsage?, mode: String?, activity: TerminalActivity?, since: Date?,
               progress: TurnProgress? = nil, sent: [SentReply] = []) {
        following?.cancel()
        following = nil
        staged = true
        self.terminal = terminal.id
        harness = terminal.harness
        session = terminal.agentSessionId ?? "preview"
        self.items = items
        self.plan = plan
        self.usage = usage
        self.mode = mode
        self.activity = activity
        activitySince = since
        self.progress = progress
        self.sent = sent
        more = true
        loaded = true
    }

    /// The design preview's: what it offers as the next message.
    func stageSuggestion(_ text: String?) { suggestion = text }

    /// The design preview's: the box offering rows for what is typed.
    func stageHints(_ rows: [ReplyHintRow], pick: Int = 0, mark: ReplyHints.Mark? = nil) {
        hints = rows
        hintPick = pick
        hintMark = mark
    }

    /// The design preview's: the side with a file open on its diff.
    func stageChanges(_ diffs: [String: [FileDiff]], open: Set<String>) {
        self.diffs = diffs
        openFiles = open
    }

    /// The design preview's: a reply being written, with files.
    func stageDraft(_ text: String, files: [(name: String, thumbnail: NSImage?)]) {
        draftFiles = files.enumerated().map { n, file in
            let image = TerminalDraft.isImage(name: file.name)
            return DraftFile(token: TerminalDraft.token(image: image, number: n + 1), number: n + 1, isImage: image, name: file.name, thumbnail: file.thumbnail, path: "/tmp/\(file.name)", pasted: nil)
        }
        draft = text
    }
    #endif
}
