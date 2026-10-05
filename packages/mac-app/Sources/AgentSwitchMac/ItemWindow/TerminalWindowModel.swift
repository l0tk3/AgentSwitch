import AgentSwitchMacCore
import AppKit
import OSLog
import SwiftUI

/// `log show --predicate 'subsystem == "com.agentswitch.mac" && category == "item-window"'`
let itemWindowLog = Logger(subsystem: "com.agentswitch.mac", category: "item-window")

/// One terminal in a window of its own (docs/dispatch-v0.md §1 单独的窗口; docs/terminal-v0.md §1, 2026-10-05): what
/// the window's bars, cards and boxes show, and what they do. The terminal itself comes from `GET /terminals/:id` (again
/// every few seconds: where the agent works, its model and mode), its folder's git from `GET /folders/git`; its status,
/// its name and the requests it waits on come at once from its stream, which the window's screen reads and hands on.
@MainActor
@Observable
final class TerminalWindowModel {
    let id: String
    @ObservationIgnored private let client: () -> DaemonClient
    private(set) var info: TerminalInfo?
    private(set) var git: FolderGit?
    /// What the agent waits for, the oldest first: the first one has the keys (⌘↩, ⌘⌫).
    private(set) var requests: [TerminalRequest] = []
    /// The answers picked so far, by request.
    private(set) var forms: [String: TerminalAnswers] = [:]
    /// The question the number keys pick in, by request.
    private(set) var questionInFocus: [String: Int] = [:]
    /// Requests whose answer is on its way.
    private(set) var busy: Set<String> = []
    /// The question card has the keyboard: numbers pick, ↩ submits, esc gives it back to the screen.
    private(set) var cardHasKeys = false
    /// Where the terminal is in use when not here (`iphone`, `web`, `mac`), and its grid, as the screen hears them.
    private(set) var away: String?
    private(set) var grid: [Int]?
    /// The sealed reply's box is open; what is written in it (maybe a secret: it never outlives the box).
    private(set) var composing = false
    var draft = ""
    /// The box's field has the keyboard: ↩ sends, esc closes it.
    var sealFocused = false
    private(set) var sending = false
    /// A sentence at the screen's foot for a few seconds (a refusal, the service away).
    private(set) var notice: String?
    /// The terminal's own ground, the window's with it.
    var ground = NSColor.black
    var windowKey = true
    /// Asks the sealed reply's field, or the Other of the question in focus, for the keyboard (a new value each time).
    private(set) var sealFocus = 0
    private(set) var otherFocus = 0

    /// The terminal was deleted: its window closes.
    @ObservationIgnored var onGone: () -> Void = {}
    /// A line of the window's own under the program's output.
    @ObservationIgnored var onNote: (String) -> Void = { _ in }
    /// The keyboard back to the screen.
    @ObservationIgnored var onFocusScreen: () -> Void = {}
    /// The size is this window's again (the placeholder clicked).
    @ObservationIgnored var onClaim: () -> Void = {}
    /// The terminal changed: the window's name with it (Mission Control, the Window menu), where its agent works.
    @ObservationIgnored var onInfo: () -> Void = {}
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    static let pollEvery: Duration = .seconds(4)
    static let noticeFor: Duration = .seconds(6)

    init(id: String, client: @escaping () -> DaemonClient, info: TerminalInfo? = nil) {
        self.id = id
        self.client = client
        self.info = info
        requests = info?.permissions ?? []
    }

    // MARK: what the bars say

    /// The folder the agent works in now: the bar's title.
    var folder: String { info.map { TerminalWindowText.folder($0.workdir) } ?? "" }
    var gitWords: String { git.map(TerminalWindowText.git) ?? "" }
    var title: String { info.map { TerminalWindowText.title(folder: folder, name: $0.name) } ?? "AgentSwitch" }
    var help: String {
        guard let info else { return "" }
        return [info.name, DisplayPath.short(info.workdir, home: NSHomeDirectory())].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The status bar's terminal: the list's word of it, with the grid and the holder the screen heard last.
    var context: TerminalContext? {
        info.map { $0.context.seen(cols: grid?.first, rows: grid?.last, away: away) }
    }

    /// The first request waiting: the keys are its.
    var first: TerminalRequest? { requests.first }

    func form(for request: TerminalRequest) -> TerminalAnswers { forms[request.id] ?? TerminalAnswers(request.questions) }
    func focus(in request: TerminalRequest) -> Int { questionInFocus[request.id] ?? form(for: request).firstUnanswered }

    // MARK: following the terminal

    func start() {
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: Self.pollEvery)
            }
        }
    }

    func stop() {
        polling?.cancel()
        polling = nil
        noticeTask?.cancel()
        draft = ""
    }

    private func refresh() async {
        let c = client()
        do {
            let next = try await c.terminal(id: id)
            if info != next {
                info = next
                onInfo()
            }
            let all = (try? await c.folderGit()) ?? [:]
            let now = all[next.workdir]
            if git != now { git = now }
        } catch let error as DaemonError where error.isGone {
            onGone()
        } catch {
            // The service is away (restarting): the screen's stream comes back by itself, and so does this.
            itemWindowLog.debug("terminal \(self.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The terminal and its folder's git as the page's own list has them (a pane of the main window: the page asks the
    /// service for all its terminals at once, so this one is not asked for alone).
    func update(info next: TerminalInfo, git now: FolderGit?) {
        if info != next {
            info = next
            onInfo()
        }
        if git != now { git = now }
    }

    /// A message of the terminal's stream, as the screen hands it on.
    func received(event: String, data: String) {
        guard let event = TerminalWindowEvent.decode(event: event, data: data) else { return }
        let next = TerminalRequests.applying(event, to: requests)
        if next != requests { setRequests(next) }
        let before = info
        switch event {
        case .status(let status): info = info?.with(status: status)
        case .name(let name): info = info?.with(name: name)
        case .exit(let code):
            info = info?.with(status: "exited", exitCode: code)
            closeSeal()
        case .removed: onGone()
        case .permission, .resolved, .permissions: break
        }
        if info != before { onInfo() }
    }

    private func setRequests(_ next: [TerminalRequest]) {
        let ids = Set(next.map(\.id))
        requests = next
        forms = forms.filter { ids.contains($0.key) }
        questionInFocus = questionInFocus.filter { ids.contains($0.key) }
        busy = busy.intersection(ids)
        if cardHasKeys, next.first?.isQuestion != true { giveKeysBack() }
    }

    /// The screen's word on the terminal's grid and its holder.
    func screenSaid(grid: [Int]?, away: String?) {
        if self.grid != grid { self.grid = grid }
        if self.away != away { self.away = away }
    }

    // MARK: answering

    /// Allow or deny. Answered already (on the phone, in the terminal itself) is no error: the card just goes.
    func decide(_ request: TerminalRequest, allow: Bool) {
        guard !busy.contains(request.id) else { return }
        busy = busy.union([request.id])
        let c = client(), id = id
        Task {
            do {
                try await c.decideTerminal(id: id, request: request.id, allow: allow)
                drop(request.id)
            } catch let error as DaemonError where error.isGone {
                drop(request.id)
            } catch {
                busy = busy.subtracting([request.id])
                say((error as? DaemonError)?.reason ?? error.localizedDescription)
            }
            onFocusScreen()
        }
    }

    func pick(_ request: TerminalRequest, question index: Int, _ label: String) {
        let next = form(for: request).picking(index, label)
        forms = forms.merging([request.id: next]) { _, new in new }
        // One of several: on to the next question without an answer; several stay where they are.
        let advance = !request.questions[index].multiSelect && !next.complete
        questionInFocus = questionInFocus.merging([request.id: advance ? next.firstUnanswered : index]) { _, new in new }
    }

    func write(_ request: TerminalRequest, question index: Int, _ text: String) {
        forms = forms.merging([request.id: form(for: request).writing(index, text)]) { _, new in new }
        questionInFocus = questionInFocus.merging([request.id: index]) { _, new in new }
    }

    /// The answers go to the agent as its own dialog would give them; what was written in Other through the sealer.
    func submit(_ request: TerminalRequest) {
        let form = form(for: request)
        guard form.complete, !busy.contains(request.id) else { return }
        busy = busy.union([request.id])
        let c = client(), id = id
        Task {
            do {
                let sealed = try await c.answerTerminal(id: id, request: request.id, answers: form.body)
                drop(request.id)
                if sealed > 0 { onNote(TerminalWindowText.sealed(sealed)) }
                giveKeysBack()
            } catch let error as DaemonError where error.isGone {
                drop(request.id)
                giveKeysBack()
            } catch {
                busy = busy.subtracting([request.id])
                say((error as? DaemonError)?.reason ?? error.localizedDescription)
            }
        }
    }

    private func drop(_ request: String) { setRequests(requests.filter { $0.id != request }) }

    // MARK: the keys

    /// ⌘↩: the first request allowed; a question submitted, or handed the keyboard while an answer is missing.
    func primaryKey() -> Bool {
        guard let first else { return false }
        if !first.isQuestion { decide(first, allow: true) } else if form(for: first).complete { submit(first) } else { takeKeys() }
        return true
    }

    /// ⌘⌫: the first request denied. A question is answered, not denied.
    func denyKey() -> Bool {
        guard let first, !first.isQuestion else { return false }
        decide(first, allow: false)
        return true
    }

    /// The question card takes the keyboard (a click into it, ⌘↩ while an answer is missing).
    func takeKeys() {
        guard first?.isQuestion == true else { return }
        cardHasKeys = true
    }

    func giveKeysBack() {
        cardHasKeys = false
        onFocusScreen()
    }

    /// The screen was clicked: the card's keys are the screen's again.
    func screenClicked() { if cardHasKeys { cardHasKeys = false } }

    /// A number key while the card has the keyboard: the option of the question in focus, or its Other.
    func numberKey(_ number: Int) -> Bool {
        guard cardHasKeys, let first, first.isQuestion else { return false }
        let index = focus(in: first)
        switch form(for: first).key(number, in: index) {
        case .pick(let label): pick(first, question: index, label)
        case .other:
            questionInFocus = questionInFocus.merging([first.id: index]) { _, new in new }
            otherFocus += 1
        case nil: break
        }
        return true
    }

    /// ⇥ / ⇧⇥ while the card has the keyboard: the next question, or the one before.
    func moveQuestion(by step: Int) -> Bool {
        guard cardHasKeys, let first, first.isQuestion else { return false }
        let count = first.questions.count
        let next = ((focus(in: first) + step) % count + count) % count
        questionInFocus = questionInFocus.merging([first.id: next]) { _, new in new }
        return true
    }

    // MARK: the sealed reply

    /// The lock, ⌘⇧V: the box opens over the screen's foot, or closes. Nothing for a terminal that has ended.
    func toggleSeal() {
        if composing { return closeSeal() }
        guard info?.running == true else { return }
        composing = true
        sealFocus += 1
    }

    func closeSeal() {
        guard composing else { return }
        composing = false
        sealFocused = false
        draft = ""
        onFocusScreen()
    }

    func send() {
        let text = draft
        guard composing, !sending, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sending = true
        let c = client(), id = id
        Task {
            do {
                let sealed = try await c.replyToTerminal(id: id, text: text)
                sending = false
                if sealed > 0 { onNote(TerminalWindowText.sealed(sealed)) }
                closeSeal()
            } catch {
                sending = false
                say((error as? DaemonError)?.reason ?? error.localizedDescription)
            }
        }
    }

    /// The placeholder clicked: the size is this window's again.
    func useHere() {
        onClaim()
        onFocusScreen()
    }

    // MARK: a sentence at the foot

    func say(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: Self.noticeFor)
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    #if DEBUG
    /// The design preview's and the probe's: a window in a state, without a service.
    func stage(requests: [TerminalRequest] = [], away: String? = nil, grid: [Int]? = nil, composing: Bool = false, draft: String = "",
               git: FolderGit? = nil, notice: String? = nil, cardHasKeys: Bool = false, forms: [String: TerminalAnswers] = [:]) {
        self.requests = requests
        self.away = away
        self.grid = grid
        self.composing = composing
        self.draft = draft
        self.git = git
        self.notice = notice
        self.cardHasKeys = cardHasKeys
        self.forms = forms
    }
    #endif
}
