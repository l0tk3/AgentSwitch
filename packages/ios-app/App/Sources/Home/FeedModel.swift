import AgentSwitchKit
import SwiftUI

/// Live tails for the home screen's log: one event stream per active task, at most `ActivityFeed.maxLiveStreams`
/// (the newest); the others show up through the poll. Streams run only while the log is on screen, and a restarted
/// stream resumes after the last event received (shown or not), so nothing is replayed twice.
@MainActor
@Observable
final class FeedModel {
    private(set) var tails: [String: [TaskEvent]] = [:]
    /// The time of each followed task's latest event, shown or not: a running task quiet for 10 minutes says so
    /// (control-v0 §5).
    private(set) var lastEventAt: [String: Int64] = [:]
    private var lastSeq: [String: Int64] = [:]
    private var streams: [String: Task<Void, Never>] = [:]
    /// Set by the home view on appear / disappear; a sync while hidden stops everything instead.
    var visible = false
    /// Deliverable counts of finished tasks, asked once per task (a finished task's files do not change).
    private(set) var deliverables: [String: Int] = [:]
    private var asked: Set<String> = []

    /// Start streams for the tasks that should have one, stop the rest.
    func sync(_ model: AppModel) {
        guard visible, let api = model.api else {
            stopAll()
            return
        }
        let wanted = Set(ActivityFeed.liveTaskIds(model.tasks))
        for (id, stream) in streams where !wanted.contains(id) {
            stream.cancel()
            streams[id] = nil
        }
        for id in wanted where streams[id] == nil {
            start(id, api, model)
        }
        countDeliverables(ActivityFeed.timeline(model.tasks).filter { $0.status.isTerminal && !asked.contains($0.id) }.map(\.id), api)
    }

    private func countDeliverables(_ ids: [String], _ api: AgentSwitchAPI) {
        guard !ids.isEmpty else { return }
        asked.formUnion(ids)
        Task { [weak self] in
            for id in ids {
                // Asked once: a failure is not retried every poll (the task page lists the files anyway).
                guard let files = try? await api.taskFiles(id) else { continue }
                self?.deliverables[id] = files.filter(\.isDeliverable).count
            }
        }
    }

    func stopAll() {
        streams.values.forEach { $0.cancel() }
        streams = [:]
    }

    private func start(_ id: String, _ api: AgentSwitchAPI, _ model: AppModel) {
        let after = lastSeq[id] ?? 0
        streams[id] = Task { [weak self] in
            do {
                for try await event in api.events(taskId: id, after: after) {
                    guard let self, !Task.isCancelled else { return }
                    lastSeq[id] = max(lastSeq[id] ?? 0, event.seq)
                    lastEventAt[id] = max(lastEventAt[id] ?? 0, event.ts)
                    tails[id] = EventTail.appending(event, to: tails[id] ?? [])
                    if event.touchesApprovals { await model.refreshApprovals() }
                    if event.endsStream || event.type == "dispatched" { await model.refreshTasks() }
                }
            } catch {
                // A dropped stream is not an error to show: the next poll starts it again from the last kept event.
                if case APIError.unauthorized = error { model.handle(error) }
            }
            guard !Task.isCancelled else { return }
            self?.streams[id] = nil
            await model.refreshTasks()
        }
    }
}
