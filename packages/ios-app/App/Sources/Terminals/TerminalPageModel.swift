import AgentSwitchKit
import Foundation
import Observation
import SwiftUI

/// One terminal on the phone (docs/terminal-v0.md §1): its stream drawn into the screen, its status and name, the
/// permission requests waiting, and what the phone sends — a sealed reply, named keys, a decision. One terminal has one
/// size ("尺寸有主"): the phone takes it when the user acts here (taps the screen or the reply box, sends, presses a key,
/// [ take over ]); opening the page or coming back to the app takes it only when no other screen is in use. While it
/// has it, the text size and the space set the grid. Another screen's size shows the placeholder over the frame as it
/// was; taking it over draws the screen afresh.
@MainActor
@Observable
final class TerminalPageModel {
    let id: String
    private(set) var name: String
    private(set) var harness: String
    private(set) var status: TerminalStatus
    /// It writes a session of its own (not one it continues in place): closing may delete that record.
    let ownsRecord: Bool
    /// What `/` offers: the agent's slash commands in this folder.
    private(set) var commands: [SlashCommand] = []
    /// The Mac's AgentSwitch is too old to list them (said when `/` is typed).
    private(set) var commandsUnavailable = false
    private(set) var permissions: [TerminalPermission] = []
    /// The terminal was closed (here or elsewhere): the page leaves.
    private(set) var removed = false
    /// Drawn at least once (the placeholder goes).
    private(set) var drawn = false
    /// Screens drawn afresh from a snapshot (each comes in top down).
    private(set) var snapshots = 0
    /// The Mac takes the wheel (one that predates it says so once, and the drag stops sending).
    private(set) var wheelWorks = true
    var error: String?
    /// "1 secret sealed" after a reply the sealer changed; cleared by the next one.
    private(set) var sealedNote: String?
    private(set) var sending = false
    @ObservationIgnored let screen: TerminalScreenController
    @ObservationIgnored private var api: AgentSwitchAPI?
    @ObservationIgnored private var follow: Task<Void, Never>?
    @ObservationIgnored private var resizing: Task<Void, Never>?
    /// The grid the service last heard from this phone.
    @ObservationIgnored private var told: (cols: Int, rows: Int)?
    /// Wheel notches not sent yet (up positive), and the send under way.
    @ObservationIgnored private var wheelPending = 0
    @ObservationIgnored private var wheeling: Task<Void, Never>?
    @ObservationIgnored private var clickRefused = false
    /// This phone as a screen: the size it takes is its own until another takes it or this page's stream ends (the
    /// page closed, the app in the background).
    let screenId = TerminalPageModel.phoneScreen

    /// One id for this phone, kept across pages and launches (PhoneScreen; the browser's tabs know it by the same id).
    static var phoneScreen: String { PhoneScreen.id }
    /// Where the terminal is in use instead ("mac", "web", "iphone"): the placeholder over the frame as it was.
    private(set) var away: String?
    /// Who has the size, as the stream last said (nil: nobody, or not heard yet).
    @ObservationIgnored private var owner: String?
    /// Just opened or back in front: the size is taken when the stream says no other screen has it.
    @ObservationIgnored private var claimOnConnect = false
    /// While that is not known yet, what the stream draws is held (drawn for another screen's width it comes apart here).
    @ObservationIgnored private var held: [TerminalEvent] = []
    /// A claim on its way: the stream may still say the size is another screen's (what it replays on connecting).
    @ObservationIgnored private var claiming = false
    /// The claim's own request (a layout change's resize does not cancel it).
    @ObservationIgnored private var claimTask: Task<Void, Never>?
    /// The app is in front.
    @ObservationIgnored private var active = true
    private var mine: Bool { owner == screenId }

    /// The page draws the terminal's screen. False in the simple view (docs/simple-view-v0.md §1): the stream then
    /// carries no screen, this phone never takes the size, and the Mac says what the agent is doing and when the
    /// session's record changed.
    private(set) var showsScreen: Bool
    /// What the agent is doing now, as the record's stream says it (the list's reading until it has).
    private(set) var activity: TerminalActivity?
    private(set) var subagents: [TerminalSubagent] = []
    /// The stream has said what it is doing (so "nothing" is known, not unheard).
    private(set) var activityKnown = false
    /// When what it is doing now began (the tool, else the turn).
    private(set) var activitySince: Date?
    /// Changes when the session's record does: the page reads it again.
    private(set) var recordRev: String?
    /// The model the agent says it is on now (Claude Code), as the stream last said; nil until it has.
    private(set) var modelNow: String?
    /// Codex's Daybreak switch as the stream said last (nil: nothing said — the list's word stands).
    private(set) var daybreakNow: Bool?
    /// What Claude Code offers as your next message, while it shows one: said over the empty reply box, a tap takes it.
    private(set) var suggestion: String?
    /// A change of model is on its way to the agent.
    private(set) var changingModel = false
    /// The thinking level a screen here asked for, until a turn has run at it (the record then says).
    private(set) var effortAsked: String?

    init(terminal: TerminalInfo, fontSize: CGFloat, showsScreen: Bool = true) {
        id = terminal.id
        name = terminal.name
        harness = terminal.harness
        status = terminal.status
        permissions = terminal.permissions
        ownsRecord = terminal.resumedFrom == nil || terminal.forked
        self.showsScreen = showsScreen
        modelNow = terminal.modelNow
        suggestion = terminal.suggestion
        activity = terminal.activity
        subagents = terminal.subagents
        activitySince = terminal.statusSince.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
        screen = TerminalScreenController(fontSize: fontSize)
        screen.onSize = { [weak self] cols, rows in self?.sizeChanged(cols: cols, rows: rows) }
    }

    func start(_ api: AgentSwitchAPI?, style: TerminalStyle?) {
        if let style { screen.apply(style) }
        guard follow == nil else { return }
        self.api = api
        guard let api else {
            #if DEBUG
            screen.snapshot(DemoData.terminalScreen)
            drawn = true
            snapshots += 1
            commands = DemoData.slashCommands
            #endif
            return
        }
        let id = id
        Task { [weak self] in
            do {
                let listed = try await api.terminalCommands(id)
                self?.commands = listed ?? []
                self?.commandsUnavailable = listed == nil
            } catch {
                self?.commandsUnavailable = true
            }
        }
        claimOnConnect = showsScreen
        startStream(api)
    }

    private func startStream(_ api: AgentSwitchAPI) {
        let id = id, screen = showsScreen ? screenId : nil, record = !showsScreen
        follow = Task { [weak self] in
            do {
                for try await event in api.terminalEvents(id, screen: screen, record: record) {
                    guard let self, !Task.isCancelled else { return }
                    self.handle(event)
                }
            } catch {
                self?.error = error.localizedDescription
            }
        }
    }

    /// Again from a fresh snapshot (the service's screen at the size it has now).
    private func restartStream() {
        follow?.cancel()
        follow = nil
        if let api { startStream(api) }
    }

    /// The app went to the background: the stream ends, and a few seconds later this phone's hold on the size (the Mac
    /// takes it back).
    func suspend() {
        active = false
        follow?.cancel()
        follow = nil
        resizing?.cancel()
    }

    /// Back in front: the stream again, and the size (the user is looking here).
    func resume() {
        active = true
        guard follow == nil, let api, !removed else { return }
        claimOnConnect = showsScreen && status != .exited
        startStream(api)
    }

    /// To the terminal's screen, or to the record. The screen comes fresh from the Mac and the size becomes this
    /// phone's (the user chose to look at it here); leaving it gives the size back a moment later.
    func show(screen on: Bool) {
        guard on != showsScreen else { return }
        showsScreen = on
        follow?.cancel()
        follow = nil
        resizing?.cancel()
        claimTask?.cancel()
        claiming = false
        held = []
        owner = nil
        away = nil
        drawn = false
        guard active, let api, !removed else { return }
        claimOnConnect = on && status != .exited
        startStream(api)
    }

    /// The screen's own background (the Mac's terminal colours): what covers it before it is drawn.
    var ground: Color { Color(uiColor: screen.view.nativeBackgroundColor) }

    func stop() {
        follow?.cancel()
        follow = nil
        resizing?.cancel()
        wheeling?.cancel()
        wheeling = nil
        wheelPending = 0
    }

    func handle(_ event: TerminalEvent) {
        switch event {
        case .snapshot, .output, .resize:
            // The record's stream draws nothing and owns no size (a Mac from before it still sends these).
            if !showsScreen { return }
        default: break
        }
        switch event {
        case .snapshot(_, let cols, let rows, let data):
            if claimOnConnect { held = [event]; return }
            // Another screen has the size: the frame stays as it was under the placeholder (drawn for that screen's
            // width it would come apart here).
            if away != nil { return }
            screen.snapshot(data)
            drawn = true
            snapshots += 1
            // Drawn at the size it had; at this phone's when it takes or has the size, and the agent draws again (its
            // links and status line are not in a snapshot).
            told = (cols, rows)
            if mine {
                let grid = screen.grid
                tellSize(cols: grid.cols, rows: grid.rows, redraw: true)
            }
        case .output(_, let data):
            if claimOnConnect { held.append(event); return }
            if away != nil { return }
            screen.output(data)
            drawn = true
        case .status(let s):
            if s != status {
                // A turn begins or ends: the clock starts over, and at rest it is doing nothing.
                activitySince = Date()
                if s != .working { activity = nil; subagents = [] }
                // A turn has run since the level was asked for: its record says what it ran at.
                if status == .working, s == .idle { effortAsked = nil }
            }
            status = s
        case .activity(let now, let agents):
            activityKnown = true
            if now != activity { activity = now; activitySince = Date() }
            subagents = agents
        case .record(let rev):
            recordRev = rev
        case .model(let model):
            modelNow = model
        case .daybreak(let on):
            daybreakNow = on
        case .suggestion(let text):
            suggestion = text
        case .name(let n):
            name = n
        case .resize(_, _, let by):
            if claimOnConnect {
                // Opened or back in front: this phone's size unless another screen is in use (the placeholder says where).
                claimOnConnect = false
                let drawing = held
                held = []
                if by == nil || by == screenId {
                    owner = by
                    away = nil
                    // A screen drawn for another width comes apart at this one: then a fresh one once the size is ours.
                    let grid = screen.grid
                    if case .snapshot(_, let cols, let rows, _)? = drawing.first, (cols, rows) != (grid.cols, grid.rows) {
                        claim(fresh: true)
                    } else {
                        for e in drawing { handle(e) }
                        claim()
                    }
                } else {
                    owner = by
                    away = Self.place(of: by!)
                }
                break
            }
            if claiming, by != screenId { break }
            owner = by
            if let by, by != screenId {
                away = Self.place(of: by)
            } else if by == nil, active, drawn, !claimOnConnect, status != .exited {
                claim()   // its owner left: this phone, in front, takes it back
            }
        case .permission(let p):
            if !permissions.contains(where: { $0.id == p.id }) { permissions.append(p) }
        case .permissionResolved(let pid):
            permissions.removeAll { $0.id == pid }
            questionPicks[pid] = nil
        case .permissions(let all):
            permissions = all
            questionPicks = questionPicks.filter { pid, _ in all.contains { $0.id == pid } }
        case .exit(let code):
            status = .exited
            permissions = []
            activity = nil
            subagents = []
            if !showsScreen { return }
            if away != nil {
                // Nothing to take any more: the last screen, as the service has it.
                away = nil
                restartStream()
                return
            }
            screen.write("\r\n\u{1b}[2m[exited · code \(code.map(String.init) ?? "?")]\u{1b}[0m\r\n")
        case .removed:
            removed = true
        }
    }

    // MARK: size

    /// The text size or the space changed: the service hears it while the size is this phone's.
    private func sizeChanged(cols: Int, rows: Int) {
        guard drawn, mine else { return }
        tellSize(cols: cols, rows: rows, redraw: false)
    }

    /// Debounced: a pinch or the keyboard sliding in changes the grid many times.
    private func tellSize(cols: Int, rows: Int, redraw: Bool) {
        guard cols >= 20, rows >= 5, status != .exited, let api else { return }
        let id = id
        let same = told.map { $0.cols == cols && $0.rows == rows } ?? false
        resizing?.cancel()
        resizing = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            if !same { try? await api.resizeTerminal(id, cols: min(cols, 500), rows: min(rows, 300), screen: self?.screenId) }
            self?.told = (cols, rows)
            // The same size makes no redraw on its own: ask for one.
            if redraw && same { try? await api.redrawTerminal(id) }
        }
    }

    /// The user acts here: the size is this phone's (nothing is sent when it already is).
    func userActed() { if showsScreen, !mine { claim() } }

    /// Takes the size: this phone's grid, told with its id (also at the same size: the owner changes). After the
    /// placeholder the screen is drawn afresh at it — what came meanwhile was for another width, and was not drawn.
    func claim(fresh: Bool = false) {
        guard let api, status != .exited else { return }
        let wasAway = away != nil || fresh
        owner = screenId
        away = nil
        claiming = true
        let grid = screen.grid
        let cols = min(max(grid.cols, 20), 500), rows = min(max(grid.rows, 5), 300)
        let same = told.map { $0.cols == cols && $0.rows == rows } ?? false
        told = (cols, rows)
        let id = id, me = screenId
        claimTask?.cancel()
        claimTask = Task { [weak self] in
            try? await api.resizeTerminal(id, cols: cols, rows: rows, screen: me)
            guard let self else { return }
            self.claiming = false
            if wasAway { self.restartStream() }
            // The same size makes no redraw on its own: ask for one.
            else if same { try? await api.redrawTerminal(id) }
        }
    }

    static func place(of screen: String) -> String {
        screen.hasPrefix("phone") ? "iphone" : screen.hasPrefix("mac") ? "mac" : "web"
    }

    // MARK: sending

    /// A reply, pasted in and entered: as typed, or sealed on the Mac first (credentials become ciphertext). Its files go
    /// where their placeholders stand: sent to the Mac first, then the reply says where each goes.
    func send(_ text: String, sealed: Bool) async -> Bool {
        guard let api, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        sending = true
        defer { sending = false }
        userActed()
        let files = draftFiles.filter { text.contains($0.token) }
        do {
            var refs: [TerminalAttachmentRef] = []
            if !files.isEmpty {
                let staged = try await api.upload(files.map(\.file))
                refs = zip(files, staged).map { TerminalAttachmentRef(token: $0.token, upload: $1.id) }
            }
            let result = try await api.sendTerminalInput(id, text: text, sealed: sealed, attachments: refs)
            draftFiles = []
            var notes: [String] = []
            if result.sealed > 0 { notes.append(result.sealed == 1 ? "1 secret sealed" : "\(result.sealed) secrets sealed") }
            if let attached = result.attached, attached > 0 { notes.append(attached == 1 ? "1 file attached" : "\(attached) files attached") }
            sealedNote = notes.isEmpty ? nil : notes.joined(separator: " · ")
            error = refs.isEmpty || result.attached != nil ? nil : "此 Mac 上的 AgentSwitch 版本不支持在回复里带图片和文件（占位符按文字发出了），请先更新。"
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Another model for the agent (Claude Code: its `/model <id>`, typed by the Mac). Says how it went: nil when it
    /// was refused (the page shows why).
    func setModel(_ model: String) async -> AgentSwitchAPI.ModelChange? {
        guard let api, !changingModel else { return nil }
        changingModel = true
        defer { changingModel = false }
        do {
            let how = try await api.setTerminalModel(id, model: model)
            error = how == .typed ? "已输入 \(RecordDisplay.modelCommand(model))。Mac 上的 AgentSwitch 版本较旧：Claude Code 若要求确认，请切到终端查看。" : nil
            return how
        } catch APIError.http(status: 409, message: _) {
            error = "它正在工作或等待回答，结束后再切换模型。"
        } catch {
            self.error = error.localizedDescription
        }
        return nil
    }

    /// Codex's Daybreak switch turned (docs/simple-view-v0.md §5.8): the Mac types Codex's own command and waits
    /// until Codex says so, which takes a moment.
    func setDaybreak(_ on: Bool) async {
        guard let api, !changingModel else { return }
        changingModel = true
        defer { changingModel = false }
        do {
            daybreakNow = try await api.setTerminalDaybreak(id, on: on)
            error = nil
        } catch APIError.http(status: 409, message: _) {
            error = "Codex 没有切换：它正在等待回答，或它的屏幕上写着原因。"
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Another thinking level for the agent (Claude Code: its `/effort <level>`, typed by the Mac).
    func setEffort(_ level: String) async {
        guard let api, !changingModel else { return }
        changingModel = true
        defer { changingModel = false }
        do {
            let how = try await api.setTerminalEffort(id, effort: level)
            effortAsked = level
            error = how == .typed ? "已输入 \(EffortDisplay.command(level))。Mac 上的 AgentSwitch 版本较旧：Claude Code 若要求确认，请切到终端查看。" : nil
        } catch APIError.http(status: 409, message: _) {
            error = "它正在等待回答，回答后再调整。"
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: files in the reply

    /// A picture or file for the next reply (docs/terminal-v0.md §4): it stands in the reply box as its placeholder,
    /// where the user put it, and goes there when the reply is sent — as Claude Code shows `[Image #1]`.
    struct DraftFile: Identifiable, Equatable {
        let id = UUID()
        let token: String
        let number: Int
        let isImage: Bool
        let name: String
        let thumbnail: UIImage?
        let file: UploadFile
    }

    /// The files of the reply being written, in the order they were added.
    private(set) var draftFiles: [DraftFile] = []

    /// Pictures and files picked (made small and upright on the phone, no location leaves it): kept for the reply;
    /// their placeholders, to put in the box.
    func addDraftFiles(_ files: [UploadFile]) -> [String] {
        var tokens: [String] = []
        for file in files {
            guard let prepared = ImagePrep.prepare(file) else { continue }
            let image = ImagePrep.isImage(prepared)
            let number = (draftFiles.map(\.number).max() ?? 0) + 1
            let token = TerminalDraft.token(image: image, number: number)
            let thumbnail = image ? UIImage(data: prepared.data)?.preparingThumbnail(of: CGSize(width: 96, height: 96)) : nil
            draftFiles.append(DraftFile(token: token, number: number, isImage: image, name: prepared.name, thumbnail: thumbnail, file: prepared))
            tokens.append(token)
        }
        return tokens
    }

    func removeDraftFile(_ file: DraftFile) { draftFiles.removeAll { $0.id == file.id } }

    /// A placeholder deleted from the box: its file goes too.
    func keepDraftFiles(in text: String) { draftFiles.removeAll { !text.contains($0.token) } }

    /// Notches from a drag, sent together every 50 ms (at most 20 at a time) instead of one request each.
    func wheel(up: Bool, count: Int) {
        guard api != nil, status != .exited else { return }
        wheelPending += up ? count : -count
        guard wheeling == nil else { return }
        wheeling = Task { [weak self] in
            while let self, self.wheelPending != 0, !Task.isCancelled {
                let n = max(-20, min(20, self.wheelPending))
                self.wheelPending -= n
                do {
                    try await self.api?.sendTerminalKeys(self.id, Array(repeating: n > 0 ? .wheelUp : .wheelDown, count: abs(n)))
                } catch {
                    // Said once, and this drag stops: a Mac that predates the wheel answers 400.
                    if case APIError.http(status: 400, message: _) = error {
                        self.wheelWorks = false
                        self.error = "此 Mac 上的 AgentSwitch 版本不支持滑动翻页，请先更新。"
                    } else {
                        self.error = error.localizedDescription
                    }
                    self.wheelPending = 0
                    break
                }
                try? await Task.sleep(for: .milliseconds(50))
            }
            self?.wheeling = nil
        }
    }

    /// A left click on a cell, for a program that tracks the mouse. A Mac that predates it says so once.
    func click(col: Int, row: Int) async {
        guard let api, status != .exited else { return }
        do {
            try await api.clickTerminal(id, col: col, row: row)
        } catch APIError.http(status: 400, message: _) {
            if !clickRefused { error = "此 Mac 上的 AgentSwitch 版本不支持在手机上点击，请先更新。" }
            clickRefused = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    func press(_ key: TerminalKey) async {
        guard let api else { return }
        userActed()
        do { try await api.sendTerminalKeys(id, [key]) } catch { self.error = error.localizedDescription }
    }

    func decide(_ permission: TerminalPermission, allow: Bool) async {
        guard let api else { permissions.removeAll { $0.id == permission.id }; return }
        do {
            // Answered or already answered elsewhere: either way the card goes.
            try await api.decideTerminalPermission(id, permissionId: permission.id, allow: allow)
            permissions.removeAll { $0.id == permission.id }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// What is picked on each question card (docs/terminal-v0.md §3 "选择题"), by its request.
    private(set) var questionPicks: [String: QuestionPicks] = [:]
    /// The question cards being sent (Other's words go through the Mac's sealer first, which may take a while).
    private(set) var answering: Set<String> = []

    func picks(_ question: TerminalPermission) -> QuestionPicks { questionPicks[question.id] ?? QuestionPicks(question.questions) }

    func updatePicks(_ question: TerminalPermission, _ change: (inout QuestionPicks) -> Void) {
        var picks = picks(question)
        change(&picks)
        questionPicks[question.id] = picks
    }

    /// A question card's answers, once every question has one: the card goes when they are in, or when it was answered
    /// already (in the terminal, on the Mac).
    func answer(_ question: TerminalPermission) async {
        let picks = picks(question)
        guard picks.isComplete, !answering.contains(question.id) else { return }
        guard let api else { permissions.removeAll { $0.id == question.id }; return }
        answering.insert(question.id)
        defer { answering.remove(question.id) }
        userActed()
        do {
            let sealed = try await api.answerTerminalQuestion(id, permissionId: question.id, answers: picks.answers)
            if let sealed, sealed > 0 { sealedNote = sealed == 1 ? "1 secret sealed" : "\(sealed) secrets sealed" }
            permissions.removeAll { $0.id == question.id }
            questionPicks[question.id] = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func rename(_ newName: String) async {
        guard let api else { return }
        do { name = try await api.renameTerminal(id, name: newName.isEmpty ? nil : newName).name } catch { self.error = error.localizedDescription }
    }

    func close(deleteRecord: Bool = false) async -> Bool {
        guard let api else { return true }
        do {
            try await api.closeTerminal(id, deleteRecord: deleteRecord)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
