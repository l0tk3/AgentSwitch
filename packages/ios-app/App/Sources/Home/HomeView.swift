import AgentSwitchKit
import SwiftUI

/// The one screen (app-v0 §5, assistant-v0 §1.1): the conversation with the assistant, oldest first — your messages,
/// its answers, each task under the answer that created it, tasks made elsewhere on their own — and the input box.
/// Threads are never chosen here; the router files every task. Settings, ciphertexts and the loose approvals open as
/// sheets.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var feed = FeedModel()
    @State private var path = NavigationPath()
    @State private var deleting: DeleteRequest?

    static let pollInterval: Duration = .seconds(6)

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            // The strip sits above the scroll view, not in its top inset: iOS 26 fades whatever is under the bar there.
            VStack(spacing: 0) {
                ActiveThreadsStrip(lastEventAt: feed.lastEventAt, openThread: { openThread($0) }, openTask: { open($0) })
                // Above the conversation, not in it: the conversation opens at its end, where a line at its top is out
                // of sight exactly when the Mac cannot be reached.
                if model.connection.endpoint == nil {
                    ConnectionBanner()
                        .padding(.horizontal, Theme.Space.l)
                        .padding(.vertical, Theme.Space.s)
                        .background(Color(.systemBackground))
                }
                LooseApprovalsButton(count: looseCount)
                conversation
            }
            .background(Color(.systemBackground))
            .navigationTitle(model.profile?.name ?? "AgentSwitch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.macs.servers.count > 1 {
                    ToolbarItem(placement: .principal) { MacSwitcher() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { Keyboard.dismiss(); model.sheet = .settings } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("设置")
                }
            }
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .navigationDestination(for: ThreadRoute.self) { route in ThreadView(threadId: route.id) { path.append($0) } }
            .task {
                // No push in v0: poll while the log is on screen; the live streams cover the active tasks in between.
                while !Task.isCancelled {
                    await model.refreshAll()
                    guard !Task.isCancelled else { break }
                    feed.sync(model)
                    try? await Task.sleep(for: Self.pollInterval)
                }
            }
            .onChange(of: model.tasks) { feed.sync(model) }
            .onChange(of: feed.tails) { model.liveTails = feed.tails }
            .onChange(of: model.openTaskRequest) { openRequestedTask() }
            // A cold start from a Live Activity: the request is there before this screen is.
            .onAppear { openRequestedTask() }
            .onChange(of: path) { if !path.isEmpty { Keyboard.dismiss() } }
            .onAppear { feed.visible = true }
            .onDisappear {
                feed.visible = false
                feed.stopAll()
            }
            .sheet(item: $model.sheet) { sheet in sheetContent(sheet) }
            .deleteConfirmation($deleting, error: $model.banner)
        }
    }

    /// The conversation, oldest first, following new items down; the input bar under it.
    private var conversation: some View {
        @Bindable var model = model
        return ScrollViewReader { scroller in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Space.item) {
                    if let banner = model.banner {
                        ErrorText(message: $model.banner).id(banner)
                    }
                    if timeline.isEmpty && model.outgoing == nil {
                        EmptyLog()
                    }
                    ForEach(timeline) { item in row(item) }
                    if let outgoing = model.outgoing {
                        OutgoingBubble(message: outgoing)
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refreshAll() }
            // A new message, answer or task: follow it down.
            .onChange(of: timeline.last?.id) { withAnimation { scroller.scrollTo(Self.bottom, anchor: .bottom) } }
            .onChange(of: model.outgoing?.id) { withAnimation { scroller.scrollTo(Self.bottom, anchor: .bottom) } }
            .safeAreaInset(edge: .bottom) { InputBar() }
        }
    }

    private static let bottom = "bottom"

    /// The conversation; a "waits for you" line is left out while its question is open in the task's card (it would
    /// say the same thing twice), and shows as history once answered.
    private var timeline: [Conversation.Item] {
        let open = Set(model.approvals.filter { $0.status == .pending }.map(\.taskId))
        let messages = model.conversation.messages.filter { m in !(m.kind == .waiting && m.taskIds.contains(where: open.contains)) }
        return Conversation.timeline(messages: messages, tasks: ActivityFeed.timeline(model.tasks))
    }

    @ViewBuilder
    private func row(_ item: Conversation.Item) -> some View {
        switch item {
        case .user(let message):
            UserBubble(text: message.text)
        case .assistant(let message, let created):
            AssistantBubble(message: message, created: created, entry: { entry($0, showsRequest: false) }, open: open)
        case .task(let task):
            entry(task, showsRequest: true)
        }
    }

    private func entry(_ task: AgentTask, showsRequest: Bool) -> FeedEntry {
        FeedEntry(task: task, showsRequest: showsRequest, tail: feed.tails[task.id] ?? [],
                  pending: ActivityFeed.pending(model.approvals, for: task.id), deliverables: feed.deliverables[task.id] ?? 0,
                  lastEventAt: feed.lastEventAt[task.id],
                  open: { open(task.id) },
                  delete: { deleting = $0 },
                  openThread: { openThread($0) })
    }

    /// Tasks with a card in the conversation (their approvals are answered there, not behind the top button).
    private var shownTaskIds: Set<String> {
        Set(timeline.flatMap { item -> [String] in
            switch item {
            case .user: return []
            case .assistant(_, let created): return created.map(\.id)
            case .task(let task): return [task.id]
            }
        })
    }

    private func openRequestedTask() {
        guard let id = model.openTaskRequest else { return }
        model.openTaskRequest = nil
        path = NavigationPath()
        path.append(id)
    }

    private func open(_ id: String) {
        Keyboard.dismiss()
        path.append(id)
    }

    private func openThread(_ id: String) {
        Keyboard.dismiss()
        path.append(ThreadRoute(id: id))
    }

    private var looseCount: Int {
        ActivityFeed.looseApprovals(model.approvals, shown: shownTaskIds).count
    }

    @ViewBuilder
    private func sheetContent(_ sheet: HomeSheet) -> some View {
        switch sheet {
        case .settings:
            SettingsView()
        case .pickCiphertext:
            CiphertextPicker { token in model.insertIntoCompose(token) }
        case .makeCiphertext:
            NavigationStack {
                CiphertextsView()
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { model.sheet = nil } } }
            }
        case .approvals:
            ApprovalsView()
        case .addMac:
            AddMacSheet()
        }
    }
}

/// Pending approvals of tasks that are no longer in the log, behind one button at the top.
private struct LooseApprovalsButton: View {
    let count: Int
    @Environment(AppModel.self) private var model

    var body: some View {
        if count > 0 {
            Button { Keyboard.dismiss(); model.sheet = .approvals } label: {
                HStack(spacing: 6) {
                    Circle().fill(Theme.waiting).frame(width: 7, height: 7)
                    Text("另有 \(count) 项等你处理")
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.waiting)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(Color(.systemBackground))
            }
        }
    }
}

private struct EmptyLog: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.l) {
            Text("向 Mac 发送任务或问题").font(.title3.weight(.semibold))
            VStack(alignment: .leading, spacing: Theme.Space.s) {
                ForEach(["整理下载目录", "登录财务平台，汇总首页的待办", "刚才的任务进展如何"], id: \.self) { example in
                    Text(example).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Text("账号和密码可直接填写，由 Mac 加密后存储。").font(.footnote).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 60)
    }
}
