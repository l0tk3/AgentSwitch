import AgentSwitchMacCore
import SwiftUI

/// 密钥: the gate's keypairs through the bundled CLI (`keys --json`). The private key is never read or shown.
struct KeysView: View {
    @Environment(AppModel.self) private var model
    @State private var showingNew = false
    @State private var newName = ""
    @State private var makeCurrent = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("凭据网关密钥对").font(.title3.weight(.semibold))
                Spacer()
                Button { model.refreshKeys() } label: { Image(systemName: "arrow.clockwise") }.help("刷新")
                Button("新建密钥对…") { showingNew = true }
            }
            if let current = model.keys.first(where: \.current) {
                GroupBox("当前公钥（手机用它在本地加密密码）") {
                    HStack {
                        Text(current.public).font(.body.monospaced()).textSelection(.enabled).lineLimit(2)
                        Spacer()
                        Button { Clipboard.copy(current.public) } label: { Image(systemName: "doc.on.doc") }.help("复制公钥")
                    }
                    .padding(4)
                }
            }
            List(model.keys) { key in
                HStack {
                    Image(systemName: key.current ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(key.current ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading) {
                        Text(key.name).fontWeight(key.current ? .semibold : .regular)
                        Text(key.public).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer()
                    if !key.current { Button("设为当前") { model.useKey(key) } }
                }
            }
            .frame(minHeight: 140)
            Text("切换后新密文用新的公钥加密；旧密文照样能解开，因为网关持有所有密钥对。手机在下次连接时从 /gate/pubkey 取到新公钥。私钥在 \(model.paths.gateHome.path)/keys/<名字>/，界面永远不显示它。")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .onAppear { model.refreshKeys() }
        .sheet(isPresented: $showingNew) { newKeySheet }
    }

    private var newKeySheet: some View {
        let name = newName.trimmingCharacters(in: .whitespaces)
        return VStack(alignment: .leading, spacing: 14) {
            Text("新建密钥对").font(.headline)
            TextField("名字，例如 work、home", text: $newName).textFieldStyle(.roundedBorder)
            if !name.isEmpty && !GateCLI.isValidName(name) {
                Text("只能用字母、数字和 . _ -，最多 32 个字符").font(.caption).foregroundStyle(.orange)
            }
            Toggle("设为当前（之后的密文都用它加密）", isOn: $makeCurrent)
            HStack {
                Spacer()
                Button("取消") { showingNew = false }
                Button("新建") {
                    model.createKey(named: name, makeCurrent: makeCurrent)
                    newName = ""
                    showingNew = false
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!GateCLI.isValidName(name))
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}
