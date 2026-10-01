import AgentSwitchKit
import SwiftUI

/// The Mac app, seen from the phone (assistant-v0 §5): a newer AgentSwitch.app waiting to be installed (installed only
/// on the user's go-ahead; the previous version comes back by itself if the new one does not start).
struct MacAppSection: View {
    @Environment(AppModel.self) private var model
    @State private var update: AppUpdateInfo?
    @State private var confirming = false
    @State private var requested = false
    @State private var error: String?

    var body: some View {
        Section {
            if let staged = update?.staged, !requested {
                Button { confirming = true } label: {
                    LabeledContent("Install New Version") { Text(staged).mono(13) }
                }
            } else if requested {
                Text("正在安装。Mac 上的 AgentSwitch 将重启，结果将显示在对话中。")
                    .foregroundStyle(.secondary)
            } else {
                LabeledContent("Version") { Text(update?.running ?? "—").mono(13) }
            }
            if let last = update?.last, !last.ok {
                Text(last.reverted ? "上次更新失败，已恢复至上一版本：\(last.reason)" : "上次更新未安装：\(last.reason)")
                    .font(.footnote).foregroundStyle(Theme.waiting)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
        } header: {
            SectionLabel("Mac App")
        } footer: {
            Text("安装时正在进行的任务将中断；新版本无法启动时将自动恢复至上一版本。")
        }
        .task { await load() }
        .confirmationDialog("安装新版本？", isPresented: $confirming, titleVisibility: .visible) {
            Button("Install and Restart") { Task { await install() } }
        } message: {
            Text("正在进行的任务将中断。")
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        update = try? await api.appUpdate()
    }

    private func install() async {
        guard let api = model.api else { return }
        do {
            try await api.installUpdate()
            requested = true
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
