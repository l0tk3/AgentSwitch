import AgentSwitchKit
import SwiftUI

/// A thread in a navigation path (a task is its id, a String).
struct ThreadRoute: Hashable {
    let id: String
}

extension AgentThread {
    var displayTitle: String { title ?? "未命名会话" }
}

/// The thread's colour (ThreadStyle): one per thread, the same on the tag, the strip and the thread page.
func threadColor(_ id: String) -> Color {
    Color(hue: ThreadStyle.hue(for: id), saturation: 0.55, brightness: 0.85)
}

/// The small tag above a log entry naming its thread; a tap opens the thread page.
struct ThreadTag: View {
    let threadId: String
    let title: String?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 5) {
                Circle().fill(threadColor(threadId)).frame(width: 7, height: 7)
                Text(title ?? "会话 \(threadId)").lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(threadColor(threadId).opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("会话：\(title ?? threadId)")
    }
}

/// "进行中" above the log (assistant-v0 §2): one chip per thread with running work — its title, the current state,
/// highlighted when something in it needs you.
struct ActiveThreadsStrip: View {
    let open: (String) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let active = activeThreads
        if !active.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(active, id: \.id) { item in
                        Button { open(item.id) } label: { chip(item) }.buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
            }
            .padding(.vertical, 4)
        }
    }

    private struct Item { let id: String; let title: String; let state: String; let waiting: Bool }

    private var activeThreads: [Item] {
        let running = model.tasks.filter { $0.status.isActive && $0.threadId != nil }
        let waitingTasks = Set(model.approvals.filter { $0.status == .pending }.map(\.taskId))
        var seen: Set<String> = []
        return running.compactMap { task in
            guard let id = task.threadId, seen.insert(id).inserted else { return nil }
            let inThread = running.filter { $0.threadId == id }
            let waiting = inThread.contains { waitingTasks.contains($0.id) || $0.status == .waitingApproval }
            let title = model.thread(id)?.displayTitle ?? String(MessageDisplay.readable(task.task).prefix(18))
            return Item(id: id, title: title, state: waiting ? "等你" : (task.targetLabel.map { "\(task.statusLabel) · \($0.split(separator: "/").last ?? "")" } ?? task.statusLabel), waiting: waiting)
        }
    }

    private func chip(_ item: Item) -> some View {
        HStack(spacing: 6) {
            Circle().fill(threadColor(item.id)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.caption.weight(.semibold)).lineLimit(1)
                Text(item.state).font(.caption2).foregroundStyle(item.waiting ? .purple : .secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: 200, alignment: .leading)
        .background(item.waiting ? Color.purple.opacity(0.14) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// The thread page: its goal and progress from the summarizer, then its tasks in order (the log's entries), live while
/// shown; delete the whole thread from the menu.
struct ThreadView: View {
    let threadId: String
    let openTask: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var detail: ThreadDetail?
    @State private var error: String?
    @State private var deleting: DeleteRequest?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let detail { header(detail) }
                if error != nil { ErrorText(message: $error) }
                ForEach(detail?.tasks.sorted { $0.createdAt < $1.createdAt } ?? []) { task in
                    FeedEntry(task: task, tail: [], pending: ActivityFeed.pending(model.approvals, for: task.id), open: { openTask(task.id) },
                              delete: { deleting = $0 })
                }
                if detail == nil && error == nil { ProgressView().frame(maxWidth: .infinity) }
            }
            .padding()
        }
        .navigationTitle(detail?.thread.displayTitle ?? "会话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("删除整个会话", systemImage: "trash.slash", role: .destructive) {
                        deleting = .thread(id: threadId, title: detail?.thread.title)
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .deleteConfirmation($deleting, error: $error) { deleted in
            if case .thread = deleted { dismiss() } else { Task { await load() } }
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: HomeView.pollInterval)
            }
        }
    }

    private func header(_ detail: ThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(threadColor(threadId)).frame(width: 10, height: 10)
                Text(detail.thread.displayTitle).font(.headline)
            }
            if let goal = detail.summary?.goal, !goal.isEmpty { Text("目标：\(goal)").font(.subheadline) }
            if let progress = detail.summary?.progress, !progress.isEmpty { Text("进展：\(progress)").font(.subheadline).foregroundStyle(.secondary) }
            Text(meta(detail.thread)).font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(threadColor(threadId).opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
    }

    private func meta(_ thread: AgentThread) -> String {
        let when = Date(timeIntervalSince1970: TimeInterval(thread.lastActivity ?? thread.updatedAt) / 1000).relative
        return ["\(thread.taskCount ?? 0) 条任务", thread.lastTarget?.label, thread.status == "archived" ? "已归档" : nil, when].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            detail = try await api.thread(threadId)
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}
