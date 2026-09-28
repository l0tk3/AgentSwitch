import AgentSwitchMacCore
import SwiftUI

/// 密钥: the gate's keypairs through the bundled CLI (`keys --json`). The private key is never read or shown. In service
/// mode (docs/gate-service-v0.md §5) the keys migrated from ~/.secret-gate are decrypt-only and can be deleted.
struct KeysView: View {
    @Environment(AppModel.self) private var model
    @State private var showingNew = false
    @State private var retiring: Keypair?

    var body: some View {
        Form {
            if let current = model.keys.first(where: \.current) {
                Section {
                    HStack(alignment: .center, spacing: 12) {
                        Text(current.public)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("copy") { Clipboard.copy(current.public) }
                            .help("copy public key")
                    }
                } header: {
                    SectionLabel("current public key")
                } footer: {
                    Footer("iPhone 使用此公钥在本地加密密码。公钥可公开。")
                }
            }
            Section {
                if model.keys.isEmpty {
                    Text("no key pairs").foregroundStyle(.secondary)
                }
                ForEach(model.keys) { key in
                    HStack(spacing: 12) {
                        Image(systemName: "key").font(.title3).foregroundStyle(.secondary).frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(key.name)
                            Text(key.public).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: 12)
                        if key.current {
                            KeyTag(text: "current", color: .brand)
                        } else if key.legacy {
                            KeyTag(text: "retired · decrypt only", color: .secondary)
                            Button("delete") { retiring = key }
                        } else {
                            Button("make current") { model.useKey(key) }
                        }
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                SectionLabel("key pairs")
            } footer: {
                if model.gateMode.isService {
                    Footer("私钥由凭据网关服务保管，当前用户无法读取。已停用的密钥仅用于解密旧密文，删除后用其加密的密文无法解密。")
                } else {
                    Footer("切换仅影响之后生成的密文，已有密文仍可解密。私钥不在界面中显示。")
                        .help("私钥位于 \(model.shortPath(model.paths.gateHome))/keys/<名称>/")
                }
            }
        }
        .formStyle(.grouped)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { model.refreshKeys() } label: { Label("refresh", systemImage: "arrow.clockwise") }
                    .help("refresh")
                Button { showingNew = true } label: { Label("new key pair", systemImage: "plus") }
                    .help("new key pair")
            }
        }
        .onAppear { model.refreshKeys() }
        .confirmationDialog("删除密钥 \(retiring?.name ?? "")？", isPresented: Binding(get: { retiring != nil }, set: { if !$0 { retiring = nil } }),
                            presenting: retiring) { key in
            Button("delete", role: .destructive) { model.retireKey(key) }
        } message: { _ in
            Text("用此密钥加密的密文将无法再解密，此操作无法撤销。")
        }
        .sheet(isPresented: $showingNew) { NewKeySheet { name, makeCurrent in model.createKey(named: name, makeCurrent: makeCurrent) } }
    }
}

/// `当前` in the accent, `已停用（仅解密）` in grey: a capsule tag.
private struct KeyTag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule())
    }
}

/// 新建密钥对: a name and whether new ciphertext should use it.
private struct NewKeySheet: View {
    let create: (String, Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var makeCurrent = true

    var body: some View {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        VStack(alignment: .leading, spacing: 16) {
            Text("new key pair").font(.headline)
            Form {
                TextField("name", text: $name, prompt: Text("e.g. work"))
                Toggle("make current", isOn: $makeCurrent)
            }
            .formStyle(.columns)
            Text(!trimmed.isEmpty && !GateCLI.isValidName(trimmed) ? "仅可使用字母、数字和 . _ -，最多 32 个字符。" : "设为当前后，之后生成的密文均使用此密钥对加密。")
                .font(.callout)
                .foregroundStyle(!trimmed.isEmpty && !GateCLI.isValidName(trimmed) ? Color.attention : Color.secondary)
            HStack {
                Spacer()
                Button("cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("create") {
                    create(trimmed, makeCurrent)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!GateCLI.isValidName(trimmed))
            }
        }
        .padding(20)
        .frame(width: 400)
        .tint(.brand)
    }
}
