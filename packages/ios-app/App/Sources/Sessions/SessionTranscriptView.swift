import AgentSwitchKit
import SwiftUI

/// One coding session, read only (control-v0 §3; terminal-v0 §1 second round): the latest messages, oldest first —
/// what you wrote on the right under its time, the agent's answers laid out as Markdown, a run of tool calls folded
/// into one line that opens (the Mac clips each message at 2000 characters). A running session is fetched again every
/// 10 s. From the terminals tab it ends with `resume` (docs/terminal-v0.md §5: go on with it in a terminal here).
struct SessionTranscriptView: View {
    let session: SessionSummary
    var resume: (() -> Void)?
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
                            Text("无记录。").font(.footnote).foregroundStyle(.tertiary)
                        }
                        ForEach(Array(SessionItem.items(detail.messages).enumerated()), id: \.offset) { _, item in
                            SessionItemRow(item: item)
                        }
                    } else if error == nil {
                        BrailleSpinner(color: .secondary).frame(maxWidth: .infinity).padding(.top, Theme.Space.xl)
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
        .background(Theme.base)
        .safeAreaInset(edge: .bottom) {
            if let resume, TerminalsTab.resumable.contains(session.harness) {
                Button("[ resume ]", action: resume)
                    .buttonStyle(SquareButtonStyle(prominent: true))
                    .padding(.horizontal, Theme.Space.l)
                    .padding(.vertical, Theme.Space.s)
                    .background(Theme.base)
            }
        }
        .navigationTitle(MessageDisplay.readable((detail?.session ?? session).displayTitle))
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
                    BrailleSpinner()
                    Text("busy").foregroundStyle(Theme.busy).fontWeight(.medium)
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

/// What the transcript shows: a message of yours, an answer, or a run of tool calls between them.
enum SessionItem {
    case user(SessionMessage)
    case answer(SessionMessage)
    case tools([SessionMessage])

    static func items(_ messages: [SessionMessage]) -> [SessionItem] {
        var out: [SessionItem] = []
        for m in messages {
            switch m.role {
            case .user: out.append(.user(m))
            case .assistant: out.append(.answer(m))
            case .tool, .other:
                if case .tools(let run)? = out.last { out[out.count - 1] = .tools(run + [m]) } else { out.append(.tools([m])) }
            }
        }
        return out
    }
}

private struct SessionItemRow: View {
    let item: SessionItem
    @State private var open = false

    var body: some View {
        switch item {
        case .user(let m):
            VStack(alignment: .trailing, spacing: 4) {
                Text(m.date.relative).mono(11).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .trailing)
                UserBubble(text: m.text)
            }
            .padding(.top, Theme.Space.s)
        case .answer(let m):
            MarkdownView(text: m.text).textSelection(.enabled)
        case .tools(let run):
            VStack(alignment: .leading, spacing: 4) {
                Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 6) {
                        Text(open ? "▾" : "▸").mono(12).foregroundStyle(.tertiary)
                        Text(Self.summary(run)).mono(12).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if open {
                    ForEach(Array(run.enumerated()), id: \.offset) { _, m in
                        Text(Self.line(m))
                            .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(4)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 18)
                    }
                }
            }
        }
    }

    /// "Read ×2 · Bash · Edit": the tools of a run, in order, repeats counted.
    static func summary(_ run: [SessionMessage]) -> String {
        var names: [(String, Int)] = []
        for m in run {
            let name = m.tool.map(ToolDisplay.label) ?? "tool"
            if let i = names.firstIndex(where: { $0.0 == name }) { names[i].1 += 1 } else { names.append((name, 1)) }
        }
        return names.map { $0.1 > 1 ? "\($0.0) ×\($0.1)" : $0.0 }.joined(separator: " · ")
    }

    static func line(_ m: SessionMessage) -> String {
        let text = MessageDisplay.readable(m.text)
        guard let tool = m.tool, !tool.isEmpty else { return text }
        return "\(ToolDisplay.label(tool)) \(text)"
    }
}
