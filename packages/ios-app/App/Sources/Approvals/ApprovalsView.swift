import AgentSwitchKit
import SwiftUI

/// Every pending approval and question across tasks (`GET /approvals`), answerable in place. Opened from the home
/// screen's "还有 N 项待处理" when some belong to tasks that are no longer in the log.
struct ApprovalsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section { ConnectionBanner() }.listRowBackground(Color.clear)
                if let error { Section { ErrorText(message: $error).id(error) } }
                if model.approvals.isEmpty {
                    ContentUnavailableView("没有待处理的审批", systemImage: "checkmark.shield")
                }
                ForEach(model.approvals) { approval in
                    Section {
                        ApprovalCard(approval: approval,
                                     onDecide: { d in await act { try await $0.approve(taskId: approval.taskId, approvalId: approval.id, decision: d) } },
                                     onAnswer: { a in await act { try await $0.answer(taskId: approval.taskId, approvalId: approval.id, answers: a) } })
                        NavigationLink(value: approval.taskId) {
                            Text(taskTitle(approval.taskId)).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            .navigationTitle("待处理")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .refreshable { await model.refreshApprovals() }
            .task {
                while !Task.isCancelled {
                    await model.refreshApprovals()
                    try? await Task.sleep(for: .seconds(10))
                }
            }
        }
    }

    private func taskTitle(_ id: String) -> String {
        model.tasks.first { $0.id == id }.map { "任务：\(MessageDisplay.readable($0.task))" } ?? "打开任务 \(id)"
    }

    private func act(_ body: (AgentSwitchAPI) async throws -> Void) async {
        guard let api = model.api else { return }
        do {
            try await body(api)
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
        await model.refreshApprovals()
    }
}
