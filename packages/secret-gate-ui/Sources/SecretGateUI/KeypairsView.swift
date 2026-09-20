import AppKit
import SecretGateCore
import SwiftUI

struct KeypairsView: View {
    @EnvironmentObject private var state: AppState
    @State private var showingNew = false
    @State private var newName = ""
    @State private var makeCurrent = true

    var body: some View {
        List {
            Section("密钥对") {
                if state.keys.isEmpty {
                    Text("还没有密钥对。点右上角 + 生成一个。").foregroundStyle(.secondary)
                }
                ForEach(state.keys) { key in
                    KeypairRow(key: key, onUse: { state.useKey(key) })
                }
            }
        }
        .navigationTitle("密钥对")
        .toolbar {
            ToolbarItem { Button { state.refreshKeys() } label: { Image(systemName: "arrow.clockwise") }.help("刷新") }
            ToolbarItem { Button { showingNew = true } label: { Image(systemName: "plus") }.help("生成密钥对") }
        }
        .sheet(isPresented: $showingNew) { newKeySheet }
    }

    private var newKeySheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("生成新的密钥对").font(.headline)
            TextField("名字，例如 work、home、test", text: $newName)
                .textFieldStyle(.roundedBorder)
            Toggle("生成后设为当前（之后的密文都用它加密）", isOn: $makeCurrent)
            Text("私钥写入 <gate home>/keys/<名字>/key.priv，权限 0600，界面永远不显示它。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("取消") { showingNew = false }
                Button("生成") {
                    state.createKey(named: newName.trimmingCharacters(in: .whitespaces), makeCurrent: makeCurrent)
                    newName = ""
                    showingNew = false
                }
                .keyboardShortcut(.defaultAction)
                .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

private struct KeypairRow: View {
    let key: Keypair
    let onUse: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: key.current ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(key.current ? Color.accentColor : Color.secondary)
                Text(key.name).font(.body.weight(key.current ? .semibold : .regular))
                Spacer()
                if !key.current {
                    Button("设为当前", action: onUse).buttonStyle(.link).font(.caption)
                }
            }
            HStack(spacing: 6) {
                Text(key.public).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(.secondary)
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
