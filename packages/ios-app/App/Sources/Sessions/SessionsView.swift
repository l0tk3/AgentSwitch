import AgentSwitchKit
import SwiftUI

/// 设置 › 编码会话 (control-v0 §3): Claude Code, Codex and OpenCode sessions on the Mac, one group per folder, the latest
/// first; read only. Loaded on appear and on a pull; while one of them is running the list is fetched again every
/// 10 s. The Mac reads the executors' own records; nothing here changes them.
struct SessionsView: View {
    @Environment(AppModel.self) private var model
    @State private var sessions: [SessionSummary] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var unsupported = false

    static let activePoll: Duration = .seconds(10)

    var body: some View {
        List {
            if let error { Section { ErrorText(message: $error).id(error) } }
            if unsupported {
                ContentUnavailableView("此 Mac 不支持查看编码会话", systemImage: "terminal",
                                       description: Text("在 Mac 上更新 AgentSwitch 后重试。"))
            } else if loaded && sessions.isEmpty {
                ContentUnavailableView("无编码会话", systemImage: "terminal",
                                       description: Text("在 Mac 上使用 Claude Code、Codex 或 OpenCode 时，会话将显示在此处。"))
            }
            ForEach(SessionGroups.grouped(sessions)) { group in
                Section {
                    ForEach(group.sessions) { session in
                        NavigationLink(value: SettingsRoute.session(session)) { SessionRow(session: session) }
                    }
                } header: {
                    SectionLabel(group.folder.isEmpty ? "unknown folder" : PathDisplay.short(group.folder))
                        .textCase(nil)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .overlay { if !loaded { BrailleSpinner(color: .secondary) } }
        .navigationTitle("coding sessions")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            await load()
            // Only a running session changes by itself; a quiet list is fetched again on a pull.
            while !Task.isCancelled, sessions.contains(where: \.active) {
                try? await Task.sleep(for: Self.activePoll)
                guard !Task.isCancelled else { break }
                await load()
            }
        }
    }

    private func load() async {
        guard let api = model.api else {
            #if DEBUG
            sessions = DemoData.sessions
            #endif
            loaded = true
            return
        }
        do {
            sessions = try await api.sessions()
            error = nil
            unsupported = false
        } catch APIError.http(status: 404, message: _) {
            unsupported = true
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

/// One session: what it is about, then the executor, branch and when; 进行中 with its dot while it runs.
private struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(MessageDisplay.readable(session.displayTitle)).font(.subheadline).lineLimit(2)
            HStack(spacing: 6) {
                if session.active {
                    BrailleSpinner()
                    Text("busy").foregroundStyle(Theme.busy).fontWeight(.medium)
                    Text("·").foregroundStyle(.tertiary)
                }
                Text(meta).foregroundStyle(.secondary).lineLimit(1)
            }
            .font(.caption)
        }
        .padding(.vertical, 2)
    }

    private var meta: String {
        [session.harnessName, session.branch, session.updated.relative].compactMap { $0 }.joined(separator: " · ")
    }
}
