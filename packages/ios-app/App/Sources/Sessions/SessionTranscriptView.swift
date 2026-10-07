import AgentSwitchKit
import SwiftUI

/// One coding session, read only (control-v0 §3; terminal-v0 §1 second round; simple-view-v0 §0): its record, oldest
/// first — what you wrote on the right under its time, the agent's answers laid out as Markdown, each run of work on
/// one line that opens into its steps, with what it changed beside it. The same rows as a running terminal's simple
/// view: `Resume` goes on with it in a terminal here, which opens as that view. A running session is read again every
/// 10 s.
struct SessionTranscriptView: View {
    let session: SessionSummary
    /// Opening it in a terminal is under way (the button turns).
    var resuming = false
    var resume: (() -> Void)?
    @Environment(AppModel.self) private var model
    @State private var record = SessionRecordModel()
    @State private var changes: Changes?

    private struct Changes: Identifiable {
        let id = UUID()
        let work: String
    }

    private var shown: SessionSummary { record.session ?? session }
    private var hasChanges: Bool { session.harness == "claude-code" || session.harness == "codex" }

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Space.l) {
                    header(shown)
                    if let error = record.error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                    if record.loaded {
                        if record.items.isEmpty && record.error == nil {
                            Text("无记录。会话可能已被删除。").font(.footnote).foregroundStyle(.tertiary)
                        }
                        if record.more {
                            Button { Task { await record.earlier(model.api) } } label: {
                                HStack(spacing: 6) {
                                    if record.loadingEarlier { BrailleSpinner(color: .secondary) }
                                    Text("Earlier").mono(13, weight: .medium)
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.plain).foregroundStyle(Theme.signal)
                            .disabled(record.loadingEarlier)
                        }
                        ForEach(record.items) { item in
                            RecordItemRow(item: item, changes: hasChanges ? { changes = Changes(work: item.id) } : nil)
                        }
                    } else if record.error == nil {
                        BrailleSpinner(color: .secondary).frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                    }
                    Color.clear.frame(height: 1).id(Self.end)
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            // The latest is what matters: opened at the end, and following it as it grows. (Not
            // defaultScrollAnchor(.bottom), which also pushes a short record down to the bottom of the screen.)
            .onChange(of: record.items.last) { scroller.scrollTo(Self.end, anchor: .bottom) }
        }
        .background(Theme.base)
        .safeAreaInset(edge: .bottom) {
            if let resume, TerminalsTab.resumable.contains(session.harness) {
                Button(action: resume) {
                    if resuming { BrailleSpinner(color: Theme.base) } else { ButtonWord("Resume") }
                }
                    .buttonStyle(SquareButtonStyle(prominent: true))
                    .disabled(resuming)
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.vertical, Theme.Space.s)
                    .background(Theme.base)
            }
        }
        .navigationTitle(MessageDisplay.readable(shown.displayTitle))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $changes) { ChangesSheet(harness: session.harness, session: session.sessionId, work: $0.work) }
        .refreshable { await load() }
        .task {
            await load()
            while !Task.isCancelled, shown.active {
                try? await Task.sleep(for: SessionsView.activePoll)
                guard !Task.isCancelled else { break }
                await load()
            }
        }
    }

    private static let end = "end"

    private func header(_ s: SessionSummary) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Text(MessageDisplay.readable(s.displayTitle)).font(.title3.weight(.semibold)).textSelection(.enabled)
            HStack(spacing: 6) {
                if s.active {
                    BrailleSpinner()
                    Text("Busy").foregroundStyle(Theme.busy).fontWeight(.medium)
                    Text("·").foregroundStyle(.tertiary)
                }
                Text(meta(s)).foregroundStyle(.secondary).lineLimit(1)
            }
            .mono(12)
            if !s.cwd.isEmpty {
                Text(PathDisplay.short(s.cwd))
                    .mono(12).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func meta(_ s: SessionSummary) -> String {
        [s.harnessName, s.model.map(ModelName.display), s.branch, s.updated.relative].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        record.follow(harness: session.harness, session: session.sessionId)
        await record.refresh(model.api)
    }
}
