import AgentSwitchMacCore
import AppKit
import SwiftUI

/// 项目: the folders a phone task may run in (assistant-v0 §5). The assistant picks one by name when the user means it;
/// everything else gets a throw-away folder. Only the Mac changes this list; the daemon checks every folder.
struct ProjectsView: View {
    @Environment(AppModel.self) private var model
    @State private var pendingRemove: ProjectEntry?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("手机可以用的项目文件夹").font(.title3.weight(.semibold))
                Spacer()
                Button { Task { await model.refreshProjects() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新")
                Button("添加文件夹…") { pick() }.disabled(!model.daemonReady)
            }
            if model.projects.isEmpty {
                ContentUnavailableView("还没有项目", systemImage: "folder.badge.questionmark",
                                       description: Text(model.daemonReady ? "添加后，在手机上说“在 <项目名> 里…”，任务就会在那个文件夹里做。" : model.daemonLine.text))
            } else {
                Table(model.projects) {
                    TableColumn("名称") { p in Text(p.name) }.width(140)
                    TableColumn("文件夹") { p in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.path).lineLimit(1).truncationMode(.middle).help(p.path)
                            if let problem = p.problem { Text(problem).font(.caption).foregroundStyle(.red) }
                        }
                    }
                    TableColumn("") { p in Button("移除", role: .destructive) { pendingRemove = p } }.width(60)
                }
            }
            Text("手机上的任务只能进这里列出的文件夹（按名字选）；其余任务用用完即删的临时文件夹。凭据与 AgentSwitch 自己的数据所在的目录、整个主目录都不能加。在“桌面”“文稿”“下载”里的文件夹，要在「系统设置 › 隐私与安全性 › 文件和文件夹」里给 AgentSwitch 授权。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .task { await model.refreshProjects() }
        .confirmationDialog("移除「\(pendingRemove?.name ?? "")」？", isPresented: Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } })) {
            Button("移除", role: .destructive) {
                if let project = pendingRemove { Task { await model.removeProject(project) } }
            }
        } message: {
            Text("只是不再让手机的任务进这个文件夹，文件夹本身不动。")
        }
    }

    private func pick() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "添加"
        panel.message = "选择允许手机任务使用的项目文件夹"
        guard panel.runModal() == .OK else { return }
        let folders = panel.urls
        Task { await model.addProjects(folders) }
    }
}
