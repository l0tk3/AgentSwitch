import AgentSwitchMacCore
import SwiftUI

/// 密钥: the gate's one keypair through the bundled CLI (`keys --json`, gate-simple-v0 §1). The private key is never
/// read or shown. `Rotate Key…` replaces it: with the service through the administrator path (`system rotate-key`),
/// without it by `keygen --force`, both after the same warning.
struct KeysView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingRotate = false

    private var key: Keypair? { model.keys.first(where: \.current) ?? model.keys.first }

    var body: some View {
        Form {
            Section {
                if let key {
                    HStack(alignment: .center, spacing: 12) {
                        Text(key.public)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Copy") { Clipboard.copy(key.public) }
                            .help("Copy Public Key")
                    }
                    LabeledContent("Name") { Text(key.name).font(.body.monospaced()) }
                    if let created = key.createdText {
                        LabeledContent("Created") { Text(created).font(.body.monospaced()).monospacedDigit() }
                    }
                } else {
                    Text("No Key").foregroundStyle(.secondary)
                }
            } header: {
                SectionLabel("Public Key")
            } footer: {
                if model.gateMode.isService {
                    Footer("iPhone 与调度模型使用此公钥在本地加密密码，公钥可公开。私钥由凭据网关服务保管，当前用户无法读取。")
                } else {
                    Footer("iPhone 与调度模型使用此公钥在本地加密密码，公钥可公开。私钥不在界面中显示。")
                        .help("私钥位于 \(model.shortPath(model.paths.gateHome))")
                }
            }
            Section {
                HStack {
                    Text("轮换后需要重新封装所有密文。").foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    Button("Rotate Key…") { rotate() }
                        .disabled(model.gateServiceOperation != nil || (key == nil && model.gateMode.isService))
                }
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { model.refreshKeys() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .help("Refresh")
            }
        }
        .onAppear { model.refreshKeys() }
        .confirmationDialog("轮换网关密钥？", isPresented: $confirmingRotate) {
            Button("Rotate Key", role: .destructive) { model.rotateKeyLocally() }
        } message: {
            Text(GateKeyRotation.warning)
        }
    }

    /// With the service the confirmation is the service sheet (it then runs the administrator prompt); without it a
    /// dialog with the same words.
    private func rotate() {
        if model.gateMode.isService {
            model.requestGateService(.rotateKey)
        } else {
            confirmingRotate = true
        }
    }
}
