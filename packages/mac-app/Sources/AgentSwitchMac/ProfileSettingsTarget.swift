import AgentSwitchMacCore
import SwiftUI

private struct ProfileNodeKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    var profileNodeID: String? {
        get { self[ProfileNodeKey.self] }
        set { self[ProfileNodeKey.self] = newValue }
    }
}

struct ProfilesSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var node = ""
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("Node", selection: $node) {
                    Text("This Mac").tag("")
                    ForEach(model.nodes.nodes) { peer in
                        Text(peer.name + (peer.state == .online ? "" : " · Offline")).tag(peer.id)
                    }
                }
                Spacer()
            }.padding()
            if !node.isEmpty {
                Text("正在管理所选节点的配置；旧节点需先升级，才能使用远程账号设置与健康检查。")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            AgentsView(profilesOnly: true)
                .environment(\.profileNodeID, node.isEmpty ? nil : node)
                .id(node)
        }
        .task { await model.nodes.refresh(model) }
    }
}

/// 设置 › Agents with the node whose installs are shown (agents-v0 §12): this Mac's, or another node's through its app.
struct AgentsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var node = ""
    var body: some View {
        VStack(spacing: 0) {
            if !model.nodes.nodes.isEmpty {
                HStack {
                    Picker("Node", selection: $node) {
                        Text("This Mac").tag("")
                        ForEach(model.nodes.nodes) { peer in
                            Text(peer.name + (peer.state == .online ? "" : " · Offline")).tag(peer.id)
                        }
                    }
                    Spacer()
                }.padding()
            }
            AgentsView()
                .environment(\.profileNodeID, node.isEmpty ? nil : node)
                .id(node)
        }
        .task { await model.nodes.refresh(model) }
    }
}

extension AppModel {
    /// Sealed by the node that keeps it, under its own vault key (2026-11-25, user #369: secret-gate 弃用); the
    /// gate's keypair is no part of it.
    func sealProfile(_ request: GateSealRequest, on node: String?) async throws -> String {
        if let problem = request.problem { throw CommandError(problem) }
        return try await client(on: node).vaultSeal(request.value)
    }
}

