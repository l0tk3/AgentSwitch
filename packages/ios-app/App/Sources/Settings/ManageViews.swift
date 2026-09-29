import AgentSwitchKit
import SwiftUI

/// The visible trash button of a list row (tappable on its own inside a row that also opens something).
private struct DeleteButton: View {
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { Text("delete").mono(12) }
            .buttonStyle(.borderless)
            .foregroundStyle(disabled ? Color.secondary : Theme.failed)
            .disabled(disabled)
            .accessibilityLabel("删除")
    }
}

/// manage › history: every recent task, the ones that need you first (control-v0 §5: 等你处理 → 已完成未读 → 进行中 →
/// the rest, each newest first); a trash button (or a swipe) deletes a finished one, active tasks are cancelled from
/// their page first. The search field looks through the Mac's task history (`GET /search`), not only this list.
struct TasksManageView: View {
    @Environment(AppModel.self) private var model
    @State private var error: String?
    @State private var deleting: DeleteRequest?
    @State private var query = TasksManageView.initialQuery
    @State private var search = TaskSearch()

    private static var initialQuery: String {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "uiDemoScreen") == "search" ? DemoData.searchQuery : ""
        #else
        return ""
        #endif
    }

    var body: some View {
        List {
            if error != nil {
                Section { ErrorText(message: $error) }
            }
            if search.isActive(query) {
                TaskSearchResults(search: search)
            } else {
                if model.tasks.isEmpty {
                    ContentUnavailableView("无任务", systemImage: "tray")
                }
                ForEach(Attention.sorted(model.tasks, pending: model.pendingTaskIds, readMarks: model.readMarksSupported)) { task in
                    HStack {
                        NavigationLink { TaskDetailView(taskId: task.id) } label: { TaskRow(task: task) }
                        DeleteButton(disabled: task.status.isActive) { deleting = .task(task) }
                    }
                    .swipeActions(allowsFullSwipe: false) {
                        Button("delete") { deleting = .task(task) }
                            .tint(.red)
                            .disabled(task.status.isActive)
                    }
                }
            }
        }
        .navigationTitle("history")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索任务和结果")
        .task(id: query) { await search.run(query, model) }
        .deleteConfirmation($deleting, error: $error)
        .task { await model.refreshTasks() }
        .refreshable { await model.refreshTasks() }
    }
}

struct TaskRow: View {
    let task: AgentTask
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                StatusLabel(task: task, waiting: waiting)
                if let name = task.modelName {
                    Text(name).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(task.updated.relative).font(.caption).foregroundStyle(.secondary)
                if model.isUnread(task) { UnreadDot() }
            }
            Text(MessageDisplay.readable(task.task)).font(.subheadline).lineLimit(2)
            StaleNote(task: task, waiting: waiting).font(.footnote)
            if let line = task.spoken ?? task.error {
                Text(line).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var waiting: Bool { model.pendingTaskIds.contains(task.id) }
}
