import AgentSwitchKit
import SwiftUI

/// The one screen (app-v0 §5): the log of recent tasks, oldest first, and the input box. Threads are never chosen here;
/// the router files every task. Settings, ciphertexts and the loose approvals open as sheets.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var feed = FeedModel()
    @State private var path = NavigationPath()
    @State private var deleting: DeleteRequest?

    static let pollInterval: Duration = .seconds(6)

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ConnectionBanner()
                    if let banner = model.banner {
                        ErrorText(message: $model.banner).id(banner)
                    }
                    if timeline.isEmpty {
                        EmptyLog()
                    }
                    ForEach(timeline) { task in
                        FeedEntry(task: task, tail: feed.tails[task.id] ?? [],
                                  pending: ActivityFeed.pending(model.approvals, for: task.id), deliverables: feed.deliverables[task.id] ?? 0,
                                  open: { open(task.id) },
                                  delete: { deleting = $0 },
                                  openThread: { openThread($0) })
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .top) {
                VStack(spacing: 0) {
                    ActiveThreadsStrip { openThread($0) }
                    LooseApprovalsButton(count: looseCount)
                }
            }
            .safeAreaInset(edge: .bottom) { InputBar() }
            .navigationTitle(model.profile?.name ?? "AgentSwitch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { Keyboard.dismiss(); model.sheet = .settings } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("设置")
                }
            }
            .navigationDestination(for: String.self) { id in TaskDetailView(taskId: id) }
            .navigationDestination(for: ThreadRoute.self) { route in ThreadView(threadId: route.id) { path.append($0) } }
            .refreshable { await model.refreshAll() }
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

    private var timeline: [AgentTask] { ActivityFeed.timeline(model.tasks) }

    private func open(_ id: String) {
        Keyboard.dismiss()
        path.append(id)
    }

    private func openThread(_ id: String) {
        Keyboard.dismiss()
        path.append(ThreadRoute(id: id))
    }

    private var looseCount: Int {
        ActivityFeed.looseApprovals(model.approvals, shown: Set(timeline.map(\.id))).count
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
                Label("还有 \(count) 项待处理", systemImage: "exclamationmark.bubble")
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.purple.opacity(0.15), in: Capsule())
                    .foregroundStyle(.purple)
            }
            .padding(.top, 4)
        }
    }
}

private struct EmptyLog: View {
    var body: some View {
        ContentUnavailableView {
            Label("想让 Mac 上的 agent 做什么？", systemImage: "text.bubble")
        } description: {
            Text("在下面直接说。账号密码可以直接写，Mac 会先加密再交给 agent；相关的任务会自动归到同一个会话里续接。")
        }
        .padding(.top, 40)
    }
}
