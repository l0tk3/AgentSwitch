import AgentSwitchMacCore
import Foundation
import Observation

/// The Dispatch page's state (docs/dispatch-v0.md §2; the phone's AppModel and FeedModel for its home screen): the
/// conversation, the tasks, their approvals and topics as the Mac last said them; live tails of the active tasks; the
/// input; the banner. It talks to `any DispatchService` only (this Mac's DaemonClient, or the demo's), so the page can
/// be drawn from made-up work. Lists are polled while the window is seen (DispatchPage); the newest active tasks are
/// followed by their event streams in between. The actions are in DispatchModel+Actions.swift.
@MainActor
@Observable
final class DispatchModel {
    // MARK: what the Mac says

    var log = DispatchConversationLog()
    var tasks: [DispatchTask] = []
    var approvals: [DispatchApproval] = []
    private(set) var threads: [DispatchThread] = []
    private(set) var targets: DispatchTargets?
    /// The first full load came back: until then the page shows neither the record nor its empty line.
    private(set) var loaded = false
    /// A Mac without the assistant (404 on `/assistant`): the record shows tasks only.
    private(set) var hasAssistant = true
    /// A Mac that keeps no read marks (404 on `/ack`): nothing is unread.
    private(set) var readMarks = true

    // MARK: live

    /// The last few events of each followed task (its card's `└─` line).
    private(set) var tails: [String: [DispatchTaskEvent]] = [:]
    /// Each followed task's step, folded from its whole stream.
    private(set) var progress: [String: DispatchProgress] = [:]
    /// When each followed task last said anything (shown or not): `Quiet 14m`.
    private(set) var lastEventAt: [String: Int64] = [:]
    /// The files ended tasks handed back, asked once per task (again as one is opened).
    private(set) var taskFiles: [String: [DispatchTaskFile]] = [:]
    /// Files on their way here, by `task/path`.
    var downloading: Set<String> = []
    /// The copies here, by `task/path`: which version of the file each is (DispatchTaskFile.version). A copy of
    /// another version than the Mac lists is not the file any more.
    var copies: [String: String] = [:]
    /// A web-type file shown as its source (never rendered).
    var sourceFile: SourceFile?

    // MARK: requests on their way

    /// Tasks with a Cancel, Retry, Continue or Hand to on its way: their buttons wait, so a double click makes one
    /// follow-up, not two.
    var busyTasks: Set<String> = []
    /// Approvals and questions being decided or answered (from the record or the task's page alike).
    var busyApprovals: Set<String> = []

    // MARK: the input

    var text = ""
    var attachments: [PendingFile] = []
    var pin: DispatchTarget?
    var outgoing: OutgoingMessage?
    var sending = false
    /// Files being read from disk before they join the attachments.
    var preparing = 0
    /// Put the keyboard in the input (⌘N, after a send from the menu).
    private(set) var focusRequests = 0
    /// A ciphertext to put in at the cursor.
    var insertRequest: InsertRequest?
    /// The input has the keyboard: the boxes' ⌘↩ / ⌘⌫ are left to it.
    var inputFocused = false
    /// Any field takes the typing (a question's answer, a sheet's field; MainWindowState.editingText): the same.
    var editingText = false
    var sealing = false

    // MARK: the page

    /// One line of what went wrong, at the top of the record (formal Chinese).
    var banner: String?
    /// The page on screen over the record (nil: the record itself).
    var route: DispatchRoute?
    let speaker = DispatchSpeaker()
    /// The page is shown in the key, visible window (not under Terminals): an open task page is being read (only a task
    /// page marks its task read, as on the phone; a card on the record does not).
    var windowKey = false

    @ObservationIgnored private(set) var service: (any DispatchService)?
    /// The Mac's gate, for `New Ciphertext`; nil in the demo.
    @ObservationIgnored private(set) var gate: GateCLI?
    @ObservationIgnored private(set) var isDemo = false
    @ObservationIgnored var lastSeq: [String: Int64] = [:]
    @ObservationIgnored private var streams: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var filesAsked: Set<String> = []
    @ObservationIgnored var readLocally: [String: Int64] = [:]
    /// Approvals known since the first load; one that arrives later glitches its box once as it shows.
    @ObservationIgnored private var knownApprovals: Set<String>?
    @ObservationIgnored private var freshApprovals: Set<String> = []
    /// Bumped when the page takes lines or tasks away (a delete, a reload of the conversation): a list asked for before
    /// that comes back with them still in it, and is dropped rather than bringing them back.
    @ObservationIgnored private var logGeneration = 0
    @ObservationIgnored private var taskGeneration = 0
    /// The `New Ciphertext` being sealed; nil once its sheet is cancelled (the token is then not put in).
    @ObservationIgnored var sealAttempt: UUID?

    /// The service to ask, once; `demo` keeps the sample data as it is (no read marks are sent).
    func attach(_ service: any DispatchService, gate: GateCLI?, demo: Bool) {
        guard self.service == nil else { return }
        self.service = service
        self.gate = gate
        isDemo = demo
        DispatchFileCache.clear()
    }

    // MARK: derived

    /// The record as the page draws it (DispatchFeed: every rule of the phone's home applied).
    var record: [DispatchConversation.Item] {
        DispatchFeed.record(messages: log.messages, tasks: tasks, approvals: approvals)
    }

    func task(_ id: String) -> DispatchTask? { tasks.first { $0.id == id } }
    func thread(_ id: String?) -> DispatchThread? { id.flatMap { id in threads.first { $0.id == id } } }
    func title(of task: DispatchTask) -> String { DispatchTaskTitle.of(task, threads: threads, tasks: tasks) }
    func isUnread(_ task: DispatchTask) -> Bool { readMarks && task.isUnread }
    func pending(_ taskId: String) -> [DispatchApproval] { DispatchFeed.pending(approvals, for: taskId) }

    func card(_ task: DispatchTask, now: Date = Date()) -> DispatchTaskCard {
        DispatchTaskCard(task: task, tasks: tasks, threads: threads, approvals: approvals, tail: tails[task.id] ?? [],
                         progress: progress[task.id], files: taskFiles[task.id] ?? [], lastEventAt: lastEventAt[task.id],
                         readMarks: readMarks, now: now)
    }

    /// Whether this approval's box takes ⌘↩ / ⌘⌫: the newest allow / deny request on the page on screen, never while
    /// text is typed anywhere in the window (the field's ⌘⌫ deletes the line).
    func takesKeys(_ approvalId: String, onRecord: Bool, typing: Bool? = nil) -> Bool {
        guard !(typing ?? (inputFocused || editingText)) else { return false }
        let candidates: [DispatchApproval]
        switch route {
        case .task(let id)?:
            guard !onRecord else { return false }
            candidates = pending(id)
        case .topic?:
            return false
        case nil:
            guard onRecord else { return false }
            let shown = DispatchFeed.shownTaskIds(record)
            candidates = approvals.filter { $0.status == .pending && shown.contains($0.taskId) }
        }
        return candidates.filter { $0.kind == .approval }.max { $0.createdAt < $1.createdAt }?.id == approvalId
    }

    /// True once for an approval that arrived after the page loaded: its box glitches as it first shows.
    func takeFresh(_ approvalId: String) -> Bool {
        freshApprovals.remove(approvalId) != nil
    }

    // MARK: loading

    func refreshAll() async {
        guard service != nil else { return }
        await refreshTasks()
        await refreshApprovals()
        await refreshThreads()
        await refreshConversation()
        if targets == nil { await refreshTargets() }
        loaded = true
    }

    func refreshTasks() async {
        guard let service else { return }
        let generation = taskGeneration
        do {
            let fresh = try await service.tasks()
            guard generation == taskGeneration else { return }
            let deleted = DispatchTask.deleted(from: tasks, in: fresh, limit: DispatchDefaults.taskListLimit)
            tasks = withLocalReads(fresh)
            if !deleted.isEmpty { reloadConversation() }
        } catch { report(error, quiet: true) }
    }

    func refreshApprovals() async {
        guard let service else { return }
        let generation = taskGeneration
        do {
            let fresh = try await service.approvals()
            guard generation == taskGeneration else { return }
            let pending = Set(fresh.filter { $0.status == .pending }.map(\.id))
            if let known = knownApprovals {
                freshApprovals.formUnion(pending.subtracting(known))
                knownApprovals = known.union(pending)
            } else {
                knownApprovals = pending
            }
            approvals = fresh
        } catch { report(error, quiet: true) }
    }

    func refreshThreads() async {
        guard let service, let fresh = try? await service.threads() else { return }
        threads = fresh
    }

    func refreshTargets() async {
        guard let service, let fresh = try? await service.targets() else { return }
        targets = fresh
    }

    /// The newest messages first, then what came after the last one held; a send whose answer was lost is confirmed by
    /// the stored message.
    func refreshConversation() async {
        guard let service, hasAssistant else { return }
        let generation = logGeneration
        do {
            if !conversationLoaded {
                let newest = try await service.messages(last: DispatchDefaults.firstMessages)
                guard generation == logGeneration else { return }
                log = DispatchConversationLog(newest)
                conversationLoaded = true
            } else {
                // The log as it is once the answer is here (not as it was when asked): a delete meanwhile stays done.
                let after = try await service.messages(after: log.lastSeq)
                guard generation == logGeneration else { return }
                log = log.merging(after)
            }
            if let waiting = outgoing, log.contains(clientId: waiting.id) { outgoing = nil }
        } catch DaemonError.notSupported {
            hasAssistant = false
        } catch { report(error, quiet: true) }
    }

    @ObservationIgnored private var conversationLoaded = false

    /// From its newest lines again, not only what came after: lines about a deleted task went with it.
    func reloadConversation() {
        guard hasAssistant else { return }
        conversationLoaded = false
        logGeneration += 1
        log = DispatchConversationLog()
        Task { await refreshConversation() }
    }

    /// Lines taken out here at once (a delete), before the Mac's list is read again.
    func removeLines(_ seqs: [Int]) {
        logGeneration += 1
        log = log.removing(seqs)
    }

    /// Tasks taken out here at once (a delete), with their approvals: a list asked for before does not bring them back.
    func removeTasks(_ ids: Set<String>) {
        taskGeneration += 1
        tasks = tasks.filter { !ids.contains($0.id) }
        approvals = approvals.filter { !ids.contains($0.taskId) }
    }

    /// The Mac's list with this page's newer read marks laid over it; a mark the Mac has caught up with is dropped.
    func withLocalReads(_ fresh: [DispatchTask]) -> [DispatchTask] {
        guard !readLocally.isEmpty else { return fresh }
        readLocally = readLocally.filter { id, at in fresh.first { $0.id == id }.map { ($0.acknowledgedAt ?? 0) < at } ?? true }
        return fresh.map { task in
            guard let at = readLocally[task.id], (task.acknowledgedAt ?? 0) < at else { return task }
            return task.acknowledged(at: at)
        }
    }

    func replace(_ task: DispatchTask) {
        tasks = withLocalReads([task] + tasks.filter { $0.id != task.id })
    }

    // MARK: live streams

    /// Streams for the newest active tasks (DispatchFeed.liveTaskIds), the others stopped; `live` false stops all (the
    /// window is not seen). Ended tasks' files are asked here too.
    func syncStreams(live: Bool) {
        guard live, let service else { return stopStreams() }
        let wanted = Set(DispatchFeed.liveTaskIds(tasks))
        for (id, stream) in streams where !wanted.contains(id) {
            stream.cancel()
            streams[id] = nil
        }
        for id in wanted where streams[id] == nil { startStream(id, service) }
        loadFiles(DispatchFeed.timeline(tasks).filter { $0.status.isTerminal && !filesAsked.contains($0.id) }.map(\.id), service)
    }

    func stopStreams() {
        streams.values.forEach { $0.cancel() }
        streams = [:]
    }

    /// Resumes after the last event received (shown or not), so nothing is replayed twice.
    private func startStream(_ id: String, _ service: any DispatchService) {
        let after = lastSeq[id] ?? 0
        streams[id] = Task { [weak self] in
            do {
                for try await event in service.taskEvents(taskId: id, after: after) {
                    guard let self, !Task.isCancelled else { return }
                    self.received(event, for: id)
                    if event.touchesApprovals { await self.refreshApprovals() }
                    if event.endsStream || event.type == "dispatched" { await self.refreshTasks() }
                }
            } catch {
                // A dropped stream is not shown: the next poll starts it again from the last event kept.
            }
            guard !Task.isCancelled else { return }
            self?.streams[id] = nil
            await self?.refreshTasks()
        }
    }

    private func received(_ event: DispatchTaskEvent, for id: String) {
        lastSeq[id] = max(lastSeq[id] ?? 0, event.seq)
        lastEventAt[id] = max(lastEventAt[id] ?? 0, event.ts)
        let tail = DispatchEventTail.appending(event, to: tails[id] ?? [])
        if tail != tails[id] ?? [] { tails[id] = tail }
        let step = DispatchProgress.updated(progress[id], with: event)
        if step != progress[id] { progress[id] = step }
    }

    private func loadFiles(_ ids: [String], _ service: any DispatchService) {
        guard !ids.isEmpty else { return }
        filesAsked.formUnion(ids)
        Task { [weak self] in
            for id in ids {
                // Asked once: a failure is not retried every poll (the task page lists the files anyway).
                guard let files = try? await service.taskFiles(taskId: id) else { continue }
                self?.taskFiles[id] = files
            }
        }
    }

    /// A task page's fresh file list, for its card too.
    func filesChanged(_ files: [DispatchTaskFile], for taskId: String) {
        if taskFiles[taskId] != files { taskFiles[taskId] = files }
    }

    // MARK: read marks

    /// Marked here at once, then on the Mac; a Mac without read marks (404) turns them off.
    func acknowledge(_ task: DispatchTask) async {
        guard !isDemo, readMarks, task.isUnread, (readLocally[task.id] ?? 0) < task.updatedAt, let service else { return }
        let at = max(Int64(Date().timeIntervalSince1970 * 1000), task.updatedAt)
        readLocally[task.id] = at
        tasks = withLocalReads(tasks)
        do {
            try await service.acknowledge(taskId: task.id)
        } catch DaemonError.notSupported {
            readMarks = false
        } catch {}
    }

    // MARK: errors

    /// A failed call: said in the banner; a poll that finds the service gone says nothing (the bar says Service Down).
    func report(_ error: Error, quiet: Bool = false) {
        if error is CancellationError { return }
        if quiet && DispatchErrors.isUnreachable(error) { return }
        banner = DispatchErrors.text(error)
    }

    func focusInput() { focusRequests += 1 }
}
