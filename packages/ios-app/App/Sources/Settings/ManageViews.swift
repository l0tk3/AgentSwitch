import AgentSwitchKit
import SwiftUI

/// 高级 › 会话: the router's threads, for deleting only (filing stays automatic): a trash button on every row, or a
/// swipe. A delete takes the thread's tasks, logs, files and resume state with it; the Mac refuses (409) while one of
/// them still runs.
struct ThreadsManageView: View {
    @Environment(AppModel.self) private var model
    @State private var threads: [AgentThread] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var deleting: DeleteRequest?

    var body: some View {
        List {
            if error != nil {
                Section { ErrorText(message: $error) }
            }
            if loaded && threads.isEmpty {
                ContentUnavailableView("没有会话", systemImage: "bubble.left.and.bubble.right")
            }
            ForEach(threads) { thread in
                let request = DeleteRequest.thread(id: thread.id, title: thread.title)
                HStack {
                    ThreadRow(thread: thread)
                    Spacer()
                    DeleteButton { deleting = request }
                }
                .swipeActions(allowsFullSwipe: false) {
                    Button("删除", systemImage: "trash") { deleting = request }.tint(.red)
                }
            }
        }
        .navigationTitle("会话")
        .deleteConfirmation($deleting, error: $error) { _ in Task { await load() } }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            threads = try await api.threads()
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

/// The visible trash button of a list row (tappable on its own inside a row that also opens something).
private struct DeleteButton: View {
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { Image(systemName: "trash") }
            .buttonStyle(.borderless)
            .foregroundStyle(disabled ? Color.secondary : Color.red)
            .disabled(disabled)
            .accessibilityLabel("删除")
    }
}

private struct ThreadRow: View {
    let thread: AgentThread

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(thread.title ?? "未命名会话").lineLimit(1)
                if thread.status == "archived" {
                    Text("已归档").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Text(details).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private var details: String {
        let when = Date(timeIntervalSince1970: TimeInterval(thread.lastActivity ?? thread.updatedAt) / 1000).relative
        return ["\(thread.taskCount ?? 0) 条任务", thread.lastTarget?.label, when].compactMap { $0 }.joined(separator: " · ")
    }
}

/// 高级 › 任务日志: every recent task, newest first; a trash button (or a swipe) deletes a finished one. Active tasks are
/// cancelled from their detail page first.
struct TasksManageView: View {
    @Environment(AppModel.self) private var model
    @State private var error: String?
    @State private var deleting: DeleteRequest?

    var body: some View {
        List {
            if error != nil {
                Section { ErrorText(message: $error) }
            }
            if model.tasks.isEmpty {
                ContentUnavailableView("没有任务", systemImage: "tray")
            }
            ForEach(model.tasks) { task in
                HStack {
                    NavigationLink { TaskDetailView(taskId: task.id) } label: { TaskRow(task: task) }
                    DeleteButton(disabled: task.status.isActive) { deleting = .task(task) }
                }
                .swipeActions(allowsFullSwipe: false) {
                    Button("删除", systemImage: "trash") { deleting = .task(task) }
                        .tint(.red)
                        .disabled(task.status.isActive)
                }
            }
        }
        .navigationTitle("任务日志")
        .deleteConfirmation($deleting, error: $error)
        .task { await model.refreshTasks() }
        .refreshable { await model.refreshTasks() }
    }
}

struct TaskRow: View {
    let task: AgentTask

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                StatusBadge(task: task)
                if let target = task.targetLabel {
                    Text(target).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(task.updated.relative).font(.caption).foregroundStyle(.secondary)
            }
            Text(MessageDisplay.readable(task.task)).lineLimit(2)
            if let line = task.spoken ?? task.error {
                Text(line).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}
