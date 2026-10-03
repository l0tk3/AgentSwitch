import AgentSwitchMacCore
import Foundation
import Observation

/// One task's page (the phone's TaskDetailModel): its detail, its whole event stream while the page is open and seen,
/// its files. The stream resumes after the last event it showed, so leaving and coming back (or a dropped
/// connection) never duplicates or loses events. Until the Mac answers, what the record already knows is shown.
@MainActor
@Observable
final class TaskPageModel {
    let taskId: String
    private(set) var detail: DispatchTaskDetail?
    private(set) var events: [DispatchTaskEvent] = []
    private(set) var files: [DispatchTaskFile] = []
    /// The stream is open (`⠙ Live` beside `// Process`).
    private(set) var live = false
    /// Waiting for the summarizer's spoken summary after the end.
    private(set) var awaitingSummary = false
    @ObservationIgnored private var stream: Task<Void, Never>?

    init(taskId: String) {
        self.taskId = taskId
    }

    func task(_ model: DispatchModel) -> DispatchTask? { detail?.task ?? model.task(taskId) }

    /// The page's open approvals: the record's list once it is loaded (refreshed after every answer), else the detail's.
    func pending(_ model: DispatchModel) -> [DispatchApproval] {
        model.loaded ? model.pending(taskId) : (detail?.pending ?? [])
    }

    /// The page shows: load it and follow its stream (an ended task's stream replays and closes).
    func start(_ model: DispatchModel) {
        guard stream == nil, let service = model.service else { return }
        let id = taskId, after = events.last?.seq ?? 0
        stream = Task { [weak self] in
            await self?.reload(model)
            // Stopped while it loaded: `stop` has said it is not live.
            guard !Task.isCancelled else { return }
            self?.live = true
            do {
                for try await event in service.taskEvents(taskId: id, after: after) {
                    guard let self, !Task.isCancelled else { return }
                    self.events.append(event)
                    if event.touchesTask { await self.reload(model) }
                    if event.touchesApprovals { await model.refreshApprovals() }
                }
            } catch {
                if !(error is CancellationError) { model.report(error, quiet: true) }
            }
            guard !Task.isCancelled else { return }
            self?.live = false
            await model.refreshTasks()
            await self?.awaitSummary(model)
            self?.stream = nil
        }
    }

    func stop() {
        stream?.cancel()
        stream = nil
        live = false
    }

    func reload(_ model: DispatchModel) async {
        guard let service = model.service else { return }
        do {
            let fresh = try await service.task(id: taskId)
            detail = fresh
            model.replace(fresh.task)
        } catch {
            model.report(error, quiet: true)
        }
        await loadFiles(model)
    }

    /// Deliverables appear as the task runs; deliverables first, then what was sent.
    func loadFiles(_ model: DispatchModel) async {
        guard let service = model.service, let listed = try? await service.taskFiles(taskId: taskId) else { return }
        files = DispatchTaskFile.pageOrder(listed)
        model.filesChanged(listed, for: taskId)
    }

    /// The summarizer writes the spoken summary a few seconds after the end: look again until it is there (every 3 s,
    /// 20 times; the phone's).
    private func awaitSummary(_ model: DispatchModel) async {
        awaitingSummary = true
        defer { awaitingSummary = false }
        for _ in 0..<20 {
            guard let task = task(model), DispatchTaskPage.awaitingSummary(task), !Task.isCancelled else { return }
            try? await Task.sleep(for: .seconds(3))
            await reload(model)
        }
    }

    // MARK: actions (then the page again)

    func cancel(_ model: DispatchModel) async {
        guard let task = task(model) else { return }
        await model.cancel(task)
        await reload(model)
    }

    func rate(_ rating: Int, _ model: DispatchModel) async {
        guard let task = task(model) else { return }
        await model.rate(task, rating)
        await reload(model)
    }
}
