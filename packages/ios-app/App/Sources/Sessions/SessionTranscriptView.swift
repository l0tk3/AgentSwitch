import AgentSwitchKit
import SwiftUI

/// One coding session, read only (control-v0 §3): the latest messages, oldest first — what you wrote on the right,
/// the model's answers as text, tool calls as small grey lines. Plain text throughout (the Mac clips each message at
/// 2000 characters), all of it selectable. A running session is fetched again every 10 s.
struct SessionTranscriptView: View {
    let session: SessionSummary
    @Environment(AppModel.self) private var model
    @State private var detail: SessionDetail?
    @State private var error: String?

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Space.l) {
                    header(detail?.session ?? session)
                    if let error { ErrorText(message: $error).id(error) }
                    if let detail {
                        if detail.messages.isEmpty {
                            Text("无记录").font(.footnote).foregroundStyle(.tertiary)
                        }
                        ForEach(Array(detail.messages.enumerated()), id: \.offset) { _, message in
                            SessionMessageRow(message: message)
                        }
                    } else if error == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
                    }
                    Color.clear.frame(height: 1).id(Self.end)
                }
                .padding(.horizontal, Theme.Space.l)
                .padding(.vertical, Theme.Space.m)
            }
            // The latest messages are what matter: opened at the end, and following it as it grows. (Not
            // defaultScrollAnchor(.bottom), which also pushes a short transcript down to the bottom of the screen.)
            .onChange(of: detail?.messages.last) { scroller.scrollTo(Self.end, anchor: .bottom) }
        }
        .background(Color(.systemBackground))
        .navigationTitle(session.harnessName)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            await load()
            while !Task.isCancelled, (detail?.session ?? session).active {
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
                    Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                    Text("进行中").foregroundStyle(Color.accentColor).fontWeight(.medium)
                    Text("·").foregroundStyle(.tertiary)
                }
                Text(meta(s)).foregroundStyle(.secondary).lineLimit(1)
            }
            .font(.footnote)
            if !s.cwd.isEmpty {
                Label(PathDisplay.short(s.cwd), systemImage: "folder")
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func meta(_ s: SessionSummary) -> String {
        [s.harnessName, s.model.map(ModelName.display), s.branch, s.updated.relative].compactMap { $0 }.joined(separator: " · ")
    }

    private func load() async {
        guard let api = model.api else {
            #if DEBUG
            detail = SessionDetail(session: session, messages: DemoData.sessionMessages(session))
            #endif
            return
        }
        do {
            detail = try await api.session(harness: session.harness, id: session.sessionId)
            error = nil
        } catch APIError.http(status: 404, message: _) {
            // The session is gone from the Mac's records, or the Mac's AgentSwitch predates this route.
            self.error = "未找到该会话。会话可能已被删除，或 Mac 上的 AgentSwitch 需要更新。"
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}

/// One message: yours in a bubble on the right, the model's as text, a tool call as one grey line (up to three).
private struct SessionMessageRow: View {
    let message: SessionMessage

    var body: some View {
        switch message.role {
        case .user:
            UserBubble(text: message.text)
        case .assistant:
            Text(MessageDisplay.readable(message.text))
                .font(.subheadline)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .tool, .other:
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
                Image(systemName: "terminal").font(.caption2).foregroundStyle(.tertiary)
                Text(toolLine)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var toolLine: String {
        let text = MessageDisplay.readable(message.text)
        guard let tool = message.tool, !tool.isEmpty else { return text }
        return "\(ToolDisplay.label(tool)) \(text)"
    }
}
