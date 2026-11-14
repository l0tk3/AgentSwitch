import AgentSwitchMacCore
import SwiftUI

struct NodeUpdateSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let node: NodeStatus
    @State private var state: NodeReleaseUpdate?
    @State private var problem: String?
    @State private var busy = false
    @State private var confirm = false
    @State private var installing = false
    @State private var expected: String?
    @State private var completed = false
    @State private var installStarted: Date?
    private var client: DaemonClient { model.client(on: node.id) }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Update · \(node.name)").font(.headline)
            if let state {
                LabeledContent("Current", value: state.current)
                if let available = state.available { LabeledContent("Available", value: available) }
                if let reason = state.reason { Text(reason).foregroundStyle(.secondary) }
                if let error = state.error { Text(error).foregroundStyle(.red) }
                if state.phase == "downloading" { Text("正在节点上下载并校验安装包…") }
                if state.phase == "ready" { Text("安装包校验完成，等待确认安装。") }
                if let last = state.last, !last.ok { Text(last.reverted ? "上次更新失败，已回滚。" : "上次更新失败，请检查节点服务。").foregroundStyle(.red) }
            }
            if installing { Text("节点正在更新，连接可能暂时中断，正在等待恢复…") }
            if completed { Text("节点已恢复连接，新版本已生效。").foregroundStyle(.green) }
            if let problem { Text(problem).foregroundStyle(.red).font(.callout) }
            Text("仅更新 \(node.name)。确认安装后将重启该节点服务，正在执行的任务可能中断。").font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Check for Updates") { run("check") }.disabled(busy || installing || state?.phase == "downloading")
                if let version = state?.available, state?.supported == true, state?.phase != "ready" {
                    Button("Download") { run("prepare", version: version) }.disabled(busy || installing || state?.phase == "downloading")
                }
                if state?.phase == "ready" { Button("Install…") { confirm = true }.disabled(busy || installing) }
            }
        }.padding(20).frame(width: 580)
        .confirmationDialog("更新 \(node.name)？", isPresented: $confirm) {
            Button("Install & Restart") { expected = state?.staged; run("install", version: expected) }
        } message: { Text("仅在此确认后替换远程节点版本并重启服务。") }
        .task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { break }
                if installing || state?.phase == "downloading" { await refresh() }
            }
        }
    }
    private func refresh() async {
        if installing, let installStarted, Date().timeIntervalSince(installStarted) > 300 {
            installing = false
            problem = "尚未确认节点已更新。请重新检查版本或查看节点服务日志，暂不要重复安装。"
            return
        }
        do {
            let next = try await client.nodeReleaseUpdate()
            state = next
            problem = nil
            if installing, next.current == expected { installing = false; completed = true }
            else if installing, next.last?.version == expected, next.last?.ok == false { installing = false }
        } catch {
            if !installing { problem = "无法读取节点更新状态。请确认节点在线且支持远程更新：\(error.localizedDescription)" }
        }
    }
    private func run(_ action: String, version: String? = nil) {
        busy = true; problem = nil; completed = false
        if action == "install" { installing = true; installStarted = Date() }
        Task {
            defer { busy = false }
            do { state = try await client.nodeReleaseUpdate(action, version: version) }
            catch {
                if action == "install", case DaemonError.unreachable = error {
                    problem = "连接已中断，正在等待节点恢复以确认更新结果。"
                    return
                }
                installing = false
                problem = error.localizedDescription
            }
        }
    }
}
