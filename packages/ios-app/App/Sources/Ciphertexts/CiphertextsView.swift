import AgentSwitchKit
import SwiftUI

/// Mint `enc:v1:` tokens on the phone with the Mac's gate public key (app-v0 §3). The plaintext value is held only in
/// this view's state and cleared as soon as the token exists; the saved list keeps ciphertext and note only.
/// Shown pushed from Settings or in a sheet from the input box; the caller provides the navigation stack.
struct CiphertextsView: View {
    @Environment(AppModel.self) private var model
    @State private var draft = SecretDraft()
    @State private var minted: SavedCiphertext?
    @State private var error: String?

    var body: some View {
        Form {
            keySection
            if model.canMint { mintSection }
            if let minted { resultSection(minted) }
            savedSection
        }
        .navigationTitle("ciphertexts")
        .task { if !model.canMint { await model.refreshGateKey() } }
        .onDisappear { draft.value = "" }
    }

    @ViewBuilder
    private var keySection: some View {
        Section {
            if let gate = model.profile?.gate, model.canMint {
                LabeledContent("keypair") { Text(gate.keypair).mono(13) }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(unavailableText).font(.footnote)
                    Button("fetch key again") { Task { await model.refreshGateKey() } }.disabled(model.api == nil)
                }
            }
        } footer: {
            Text("密文在 iPhone 上生成，仅此 Mac 可解密，且仅用于所填站点。")
        }
    }

    private var unavailableText: String {
        if case .unavailable(let message) = model.gateKeyStatus { return "Mac 暂时无法读取公钥（\(message)），暂不可生成密文。" }
        return "尚未取得公钥，暂不可生成密文。"
    }

    private var mintSection: some View {
        Section(label: "new") {
            TextField("名称，例如 corp-vpn/pass", text: $draft.label)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            TextField("站点，例如 *.example.com；多个用逗号分隔", text: $draft.sites, axis: .vertical)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            Picker("类型", selection: $draft.kind) {
                ForEach(SecretKind.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            ForEach(SecretUse.allCases, id: \.self) { use in
                Toggle(use.title, isOn: Binding(get: { draft.uses.contains(use) },
                                                set: { on in if on { draft.uses.insert(use) } else { draft.uses.remove(use) } }))
            }
            SecureField(draft.kind == .totp ? "TOTP 密钥（base32）" : "密码 / token", text: $draft.value)
                .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
            TextField("备注（可选，仅保存在 iPhone 上）", text: $draft.note)
            if let problem = draft.problem, !draft.value.isEmpty || !draft.label.isEmpty {
                Text(problem).font(.footnote).foregroundStyle(Theme.waiting)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
            Button("make ciphertext") { mint() }.disabled(draft.problem != nil)
        }
    }

    private func resultSection(_ item: SavedCiphertext) -> some View {
        Section(label: "just made") {
            Text(item.token).font(.caption.monospaced()).lineLimit(3).textSelection(.enabled)
            HStack {
                Button("copy") { Clipboard.copyToken(item.token) }
                Spacer()
                Button("insert") { model.insertIntoCompose(item.token) }
            }
            .buttonStyle(.borderless)
        }
    }

    private var savedSection: some View {
        Section(label: "saved") {
            if model.ciphertexts.isEmpty {
                Text("无已保存的密文").foregroundStyle(.secondary)
            }
            ForEach(model.ciphertexts) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.note)
                    Text(item.shortToken).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                .swipeActions(edge: .leading) {
                    Button("insert") { model.insertIntoCompose(item.token) }.tint(.accentColor)
                }
                .contextMenu {
                    Button("copy") { Clipboard.copyToken(item.token) }
                    Button("insert") { model.insertIntoCompose(item.token) }
                }
            }
            .onDelete { offsets in model.deleteCiphertexts(Set(offsets.map { model.ciphertexts[$0].id })) }
        }
    }

    private func mint() {
        do {
            minted = try model.mint(draft)
            error = nil
            // Plaintext is gone the moment the token exists; label, sites and kind stay for the next one.
            draft.value = ""
            draft.note = ""
        } catch {
            draft.value = ""
            self.error = error.localizedDescription
        }
    }
}

#Preview {
    NavigationStack { CiphertextsView() }.environment(AppModel.preview())
}
