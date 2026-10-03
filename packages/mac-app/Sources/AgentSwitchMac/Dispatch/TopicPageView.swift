import AgentSwitchMacCore
import SwiftUI

/// A topic's page, pushed in the record's column (the phone's ThreadView): its title, what the summarizer says of its
/// goal and progress, `[ Rename ]` `[ Archive ]` `[ Delete ]`, then its tasks in order, each its request and card.
/// Reloaded every poll while shown.
struct TopicPageView: View {
    let threadId: String
    let model: DispatchModel
    let open: (DispatchRoute) -> Void
    let close: () -> Void
    let visible: Bool
    @Environment(MainWindowState.self) private var window
    @State private var detail: DispatchThreadDetail?
    @State private var deleting: DeleteRequest?
    @State private var renaming = false
    @State private var newTitle = ""

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if let banner = model.banner { BannerLine(text: banner) { model.banner = nil } }
                if let detail {
                    header(detail)
                    ForEach(detail.tasks) { task in
                        VStack(alignment: .leading, spacing: 10) {
                            UserBox(text: DispatchMessageDisplay.readable(task.task), attached: task.attachments.count)
                            TaskCardView(card: model.card(model.task(task.id) ?? task), model: model, open: open,
                                         delete: { deleting = $0 }, onRecord: false)
                        }
                    }
                } else {
                    BrailleSpinner().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.top, 18)
            .padding(.bottom, 28)
            .dispatchColumn()
        }
        .onChange(of: detail?.thread.displayTitle ?? model.thread(threadId)?.displayTitle, initial: true) { _, title in
            window.dispatchTitle = BarTitle(title ?? "Topic")
        }
        .task(id: visible) {
            // Not read while it is not seen (under Terminals, in a covered window).
            guard visible else { return }
            await load()
            while visible && !Task.isCancelled {
                try? await Task.sleep(for: DispatchDefaults.pollInterval)
                guard !Task.isCancelled else { break }
                await load()
            }
        }
        .deleteConfirmation($deleting, model: model) { deleted in
            if case .topic = deleted { close() } else { Task { await load() } }
        }
        .alert("Rename Topic", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Rename") { Task { await model.renameThread(threadId, to: newTitle); await load() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("留空则恢复自动生成的标题。")
        }
    }

    private func header(_ detail: DispatchThreadDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(detail.thread.displayTitle)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Look.ink)
                .textSelection(.enabled)
            Text(detail.thread.meta()).mono(11.5).foregroundStyle(Look.ink2)
            if let goal = detail.summary?.goal, !goal.isEmpty { labelled("目标", goal) }
            if let progress = detail.summary?.progress, !progress.isEmpty { labelled("进展", progress) }
            HStack(spacing: 14) {
                Button { newTitle = detail.thread.title ?? ""; renaming = true } label: { BracketLabel(word: "Rename") }
                    .buttonStyle(BracketButtonStyle())
                if detail.thread.isArchived {
                    Button { Task { await model.reopenThread(threadId); await load() } } label: { BracketLabel(word: "Reopen") }
                        .buttonStyle(BracketButtonStyle())
                } else {
                    Button { archive() } label: { BracketLabel(word: "Archive") }
                        .buttonStyle(BracketButtonStyle())
                }
                Button { deleting = .topic(id: threadId, title: detail.thread.title) } label: { BracketLabel(word: "Delete") }
                    .buttonStyle(BracketButtonStyle(role: .destructive))
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func labelled(_ label: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).font(.system(size: 12)).foregroundStyle(Look.ink2)
            // The topic's summary is model output: Markdown, its code on the code wash.
            Text(DispatchMarkdown.inline(text).codeWashed()).font(.system(size: 13.5)).foregroundStyle(Look.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func archive() {
        Task {
            if let problem = await model.archiveThread(threadId) { model.banner = problem }
            await load()
        }
    }

    private func load() async {
        guard let service = model.service else { return }
        do {
            detail = try await service.thread(id: threadId)
        } catch {
            model.report(error, quiet: true)
        }
    }
}
