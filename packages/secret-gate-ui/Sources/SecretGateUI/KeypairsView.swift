import AppKit
import SecretGateCore
import SwiftUI

/// The gate's one keypair (gate-simple-v0 §1): its public key, and rotation by `keygen --force` after a warning. This
/// app drives a gate without the system service; with the service installed, the AgentSwitch app rotates the key.
struct KeypairsView: View {
    @EnvironmentObject private var state: AppState
    @State private var confirmingRotate = false

    var body: some View {
        List {
            Section("密钥") {
                if let key = state.current {
                    KeypairRow(key: key)
                    Button("轮换密钥…") { confirmingRotate = true }
                        .disabled(state.busy)
                } else {
                    Text("还没有密钥。").foregroundStyle(.secondary)
                    Button("生成密钥") { state.generateKey() }
                        .disabled(state.busy)
                }
            }
        }
        .navigationTitle("密钥")
        .toolbar {
            ToolbarItem { Button { state.refreshKeys() } label: { Image(systemName: "arrow.clockwise") }.help("刷新") }
        }
        .confirmationDialog("轮换网关密钥？", isPresented: $confirmingRotate) {
            Button("轮换", role: .destructive) { state.rotateKey() }
        } message: {
            Text(GateCLI.rotationWarning)
        }
    }
}

private struct KeypairRow: View {
    let key: Keypair

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "key.fill").foregroundStyle(Color.accentColor)
                Text(key.name).font(.body.weight(.semibold))
            }
            HStack(spacing: 6) {
                Text(key.public).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(key.public, forType: .string)
                } label: { Image(systemName: "doc.on.doc") }
                .buttonStyle(.plain).help("复制公钥")
            }
        }
        .padding(.vertical, 2)
    }
}
