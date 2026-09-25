import AgentSwitchKit
import SwiftUI

/// The Mac side, seen from the phone (assistant-v0 §5): a newer AgentSwitch.app waiting to be installed (installed only
/// on the user's go-ahead; the previous version comes back by itself if the new one does not start), and the project
/// folders a phone task may run in (managed on the Mac).
struct MacAppSection: View {
    @Environment(AppModel.self) private var model
    @State private var update: AppUpdateInfo?
    @State private var projects: [ProjectFolder] = []
    @State private var confirming = false
    @State private var requested = false
    @State private var error: String?

    var body: some View {
        Section {
            if let staged = update?.staged, !requested {
                Button { confirming = true } label: {
                    Label("安装新版本（构建于 \(staged)）", systemImage: "arrow.down.circle")
                }
            } else if requested {
                Label("已通知 Mac 安装，它会重启一次；结果助理会在对话里告诉你。", systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            } else {
                LabeledContent("版本", value: update?.running ?? "—")
            }
            if let last = update?.last, !last.ok {
                Text(last.reverted ? "上次换版没成功，已退回上一版：\(last.reason)" : "上次换版没有装上：\(last.reason)")
                    .font(.footnote).foregroundStyle(.orange)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        } header: {
            Text("新版本")
        } footer: {
            Text("在 Mac 上构建好的新版本会出现在这里。安装时 Mac 上的 AgentSwitch 会退出再启动，正在运行的任务会中断；新版本起不来会自动退回现在这一版。")
        }
        .task { await load() }
        .confirmationDialog("安装新版本？", isPresented: $confirming, titleVisibility: .visible) {
            Button("安装并重启 Mac 上的 AgentSwitch") { Task { await install() } }
        } message: {
            Text("正在运行的任务会被中断。")
        }
        Section {
            if projects.isEmpty {
                Text("还没有。在 Mac 的「设置 › 项目」里添加。").foregroundStyle(.secondary)
            }
            ForEach(projects) { project in
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                    Text(project.path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    if let problem = project.problem { Text(problem).font(.caption).foregroundStyle(.red) }
                }
            }
        } header: {
            Text("项目文件夹")
        } footer: {
            Text("说“在 <项目名> 里……”，任务就在 Mac 上那个文件夹里做；其余任务用用完即删的临时文件夹。只能在 Mac 上增删。")
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        update = try? await api.appUpdate()
        projects = (try? await api.projects()) ?? []
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
