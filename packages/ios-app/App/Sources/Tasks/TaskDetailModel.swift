import AgentSwitchKit
import SwiftUI

/// One task's detail and live event stream. The stream resumes from the last seq it showed, so leaving and coming
/// back (or a dropped connection) never duplicates or loses events.
@MainActor
@Observable
final class TaskDetailModel {
    let taskId: String
    private(set) var detail: TaskDetail?
    private(set) var events: [TaskEvent] = []
    private(set) var live = false
    private(set) var handedOffTo: AgentTask?
    /// True while waiting for the summarizer's spoken script after the task ended.
    private(set) var awaitingSummary = false
    var error: String?

    private var stream: Task<Void, Never>?

    init(taskId: String) {
        self.taskId = taskId
    }

    var task: AgentTask? { detail?.task }
    var pending: [Approval] { detail?.approvals.filter { $0.status == .pending } ?? [] }

    func start(_ model: AppModel) {
        guard stream == nil, let api = model.api else { return }
        let after = events.last?.seq ?? 0
        let id = taskId
        stream = Task { [weak self] in
            await self?.reload(api, model)
            self?.live = true
            do {
                for try await event in api.events(taskId: id, after: after) {
                    guard let self else { return }
                    self.events.append(event)
                    if event.touchesApprovals || event.endsStream { await self.reload(api, model) }
                }
            } catch {
                model.handle(error)
                self?.error = error.localizedDescription
            }
            // A cancelled stream was stopped by the view; a newer one may already be running.
            guard !Task.isCancelled else { return }
            self?.live = false
            await model.refreshApprovals()
            await self?.awaitSummary(api, model)
            self?.stream = nil
        }
    }

    /// The summarizer writes `spoken` / `speech` a few seconds after the stream's last event: look again until they
    /// are there (or a minute has passed) so 朗读 reads the script, not the fallback.
    private func awaitSummary(_ api: AgentSwitchAPI, _ model: AppModel) async {
        awaitingSummary = true
        defer { awaitingSummary = false }
        for _ in 0..<Self.summaryPolls {
            guard let task, task.status.isTerminal, task.speech == nil, task.spoken == nil, !Task.isCancelled else { return }
            try? await Task.sleep(for: .seconds(3))
            await reload(api, model)
        }
    }

    static let summaryPolls = 20

    func stop() {
        stream?.cancel()
        stream = nil
        live = false
    }

    func reload(_ api: AgentSwitchAPI, _ model: AppModel) async {
        do { detail = try await api.task(taskId) } catch { model.handle(error); self.error = error.localizedDescription }
    }

    func decide(_ approval: Approval, _ decision: ApprovalDecision, _ model: AppModel) async {
        await act(model) { api in try await api.approve(taskId: approval.taskId, approvalId: approval.id, decision: decision) }
    }

    func answer(_ approval: Approval, _ answers: [String: [String]], _ model: AppModel) async {
        await act(model) { api in try await api.answer(taskId: approval.taskId, approvalId: approval.id, answers: answers) }
    }

    func cancel(_ model: AppModel) async {
        await act(model) { api in _ = try await api.cancel(taskId: self.taskId) }
    }

    func handoff(to target: TargetRef?, _ model: AppModel) async {
        await act(model) { api in
            let next = try await api.handoff(taskId: self.taskId, to: target)
            self.handedOffTo = next
            model.taskCreated(next)
        }
    }

    private func act(_ model: AppModel, _ body: (AgentSwitchAPI) async throws -> Void) async {
        guard let api = model.api else { return }
        do {
            try await body(api)
            error = nil
            await reload(api, model)
            await model.refreshApprovals()
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}
