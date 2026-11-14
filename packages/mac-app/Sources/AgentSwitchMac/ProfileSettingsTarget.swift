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

extension AppModel {
    /// Ciphertext must belong to the selected node's gate, not this Mac's keypair.
    func sealProfile(_ request: GateSealRequest, on node: String?) async throws -> String {
        var key: String?
        if let node { key = try await client(on: node).profileGateKey().publicKey }
        return try await gateCLI.seal(request, publicKey: key)
    }
}

