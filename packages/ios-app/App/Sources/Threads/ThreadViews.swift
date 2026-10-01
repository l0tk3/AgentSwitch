import AgentSwitchKit
import SwiftUI

/// A thread in a navigation path (a task is its id, a String).
struct ThreadRoute: Hashable {
    let id: String
}

extension AgentThread {
    var displayTitle: String { title ?? "未命名话题" }
}

/// The strip above the conversation (assistant-v0 §2, control-v0 §5): one chip per thread that needs a look, in the
/// order of who needs you — waiting for you, then ended and not opened yet (the newest few), then in progress. Each
/// chip is the thread's title and its state; the waiting colour when something needs you, the unread dot when it
/// ended unseen. On a solid background with a hairline under it, so the conversation never shows through. An unread
/// chip opens the task itself (which reads it); the others open the thread.
struct ActiveThreadsStrip: View {
    var lastEventAt: [String: Int64] = [:]
    let openThread: (String) -> Void
    let openTask: (String) -> Void
    @Environment(AppModel.self) private var model

    /// Ended tasks stay in the strip while unread, for this long and at most this many.
    static let unreadWindow: TimeInterval = 12 * 3600
    static let maxUnread = 3

    var body: some View {
        let items = self.items
        if !items.isEmpty {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Space.s) {
                        ForEach(items, id: \.threadId) { item in
                            Button { item.unread ? openTask(item.task.id) : openThread(item.threadId) } label: { chip(item) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.vertical, Theme.Space.s)
                }
                Theme.line.frame(height: 1)
            }
            .background(Theme.base)
        }
    }

    private struct Item {
        let threadId: String
        let task: AgentTask
        let title: String
        let waiting: Bool
        let unread: Bool
    }

    private var items: [Item] {
        let pending = model.pendingTaskIds
        let recent = Date().addingTimeInterval(-Self.unreadWindow)
        let unread = model.tasks.filter { model.isUnread($0) && $0.threadId != nil && $0.updated > recent }
            .sorted { $0.updatedAt > $1.updatedAt }.prefix(Self.maxUnread)
        let candidates = model.tasks.filter { ($0.status.isActive || $0.waitsForYou) && $0.threadId != nil } + unread.filter { !$0.waitsForYou }
        var seen: Set<String> = []
        // The most pressing task of each thread stands for it.
        return Attention.sorted(candidates, pending: pending, readMarks: model.readMarksSupported).compactMap { task in
            guard let id = task.threadId, seen.insert(id).inserted else { return nil }
            let waiting = Attention.rank(task, pending: pending) == .needsYou
            let title = model.thread(id)?.displayTitle ?? String(MessageDisplay.readable(task.task).prefix(18))
            return Item(threadId: id, task: task, title: title, waiting: waiting, unread: !waiting && model.isUnread(task))
        }
    }

    private func state(_ item: Item) -> String {
        if item.waiting { return TaskStatus.waitingApproval.label }
        let stale = Staleness.minutes(item.task, lastEventAt: lastEventAt[item.task.id]).map(Staleness.text(minutes:))
        return [item.task.statusLabel, stale ?? item.task.modelName].compactMap { $0 }.joined(separator: " · ")
    }

    private func chip(_ item: Item) -> some View {
        HStack(spacing: Theme.Space.s) {
            StatusMark(status: item.waiting ? .waitingApproval : item.task.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.footnote.weight(.semibold)).lineLimit(1)
                Text(state(item)).mono(11).foregroundStyle(item.waiting ? Theme.waiting : .secondary).lineLimit(1)
            }
            if item.unread { UnreadDot() }
        }
        .padding(.horizontal, Theme.Space.m)
        .padding(.vertical, 7)
        .frame(maxWidth: 210, alignment: .leading)
        .overlay(Rectangle().strokeBorder(Theme.line, lineWidth: 1))
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
            LazyVStack(alignment: .leading, spacing: Theme.Space.item) {
                if let detail { header(detail) }
                if error != nil { ErrorText(message: $error) }
                ForEach(detail?.tasks.sorted { $0.createdAt < $1.createdAt } ?? []) { task in
                    FeedEntry(task: task, tail: [], pending: ActivityFeed.pending(model.approvals, for: task.id), open: { openTask(task.id) },
                              delete: { deleting = $0 })
                }
                if detail == nil && error == nil { BrailleSpinner(color: .secondary).frame(maxWidth: .infinity) }
            }
            .padding()
        }
        .navigationTitle(detail?.thread.displayTitle ?? "话题")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Delete Topic", systemImage: "trash", role: .destructive) {
                        deleting = .topic(id: threadId, title: detail?.thread.title)
                    }
                } label: { Text("⋯").mono(17) }
            }
        }
        .deleteConfirmation($deleting, error: $error) { deleted in
            if case .topic = deleted { dismiss() } else { Task { await load() } }
        }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: HomeView.pollInterval)
            }
        }
    }

    private func header(_ detail: ThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(detail.thread.displayTitle).font(.title3.weight(.semibold))
            Text(meta(detail.thread)).font(.footnote).foregroundStyle(.secondary)
            if let goal = detail.summary?.goal, !goal.isEmpty {
                LabeledLine(label: "目标", text: goal)
            }
            if let progress = detail.summary?.progress, !progress.isEmpty {
                LabeledLine(label: "进展", text: progress)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func meta(_ thread: AgentThread) -> String {
        let when = Date(timeIntervalSince1970: TimeInterval(thread.lastActivity ?? thread.updatedAt) / 1000).relative
        return ["\(thread.taskCount ?? 0) 个任务", thread.lastTarget.map { ModelName.display($0.model) }, thread.status == "archived" ? "已归档" : nil, when].compactMap { $0 }.joined(separator: " · ")
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

/// "目标  …" — a small grey label and its text.
struct LabeledLine: View {
    let label: String
    let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            Text(label).font(.footnote.weight(.medium)).foregroundStyle(.secondary).frame(width: 30, alignment: .leading)
            Text(text).font(.subheadline)
        }
    }
}
