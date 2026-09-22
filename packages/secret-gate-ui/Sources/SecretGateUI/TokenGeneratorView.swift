import AppKit
import SecretGateCore
import SwiftUI

struct TokenGeneratorView: View {
    @EnvironmentObject private var state: AppState
    @State private var showingImport = false
    @State private var importText = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(state.entries) { entry in
                        EntryRow(entry: entry,
                                 onChange: { state.update($0) },
                                 onRemove: { state.remove(entry) })
                    }
                }
                .padding(16)
            }
            Divider()
            footer
            if !state.results.isEmpty {
                Divider()
                ResultsView(results: state.results, onClear: { state.clearResults() })
                    .frame(maxHeight: 260)
            }
        }
        .navigationTitle("生成密文")
        .sheet(isPresented: $showingImport) { importSheet }
    }

    private var header: some View {
        HStack {
            if let cur = state.current {
                Label("当前密钥对：\(cur.name)", systemImage: "key.fill")
            } else {
                Label("没有当前密钥对，先在左边生成一个", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
            Spacer()
            Button { showingImport = true } label: { Label("粘贴批量导入", systemImage: "text.badge.plus") }
            Button { state.addEntry() } label: { Label("加一行", systemImage: "plus") }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private var footer: some View {
        HStack {
            let ready = state.readyEntries.count
            Text("\(ready) / \(state.entries.count) 行可生成").foregroundStyle(.secondary)
            Spacer()
            Button("清空明文") { state.clearValues() }
                .disabled(!state.entries.contains { !$0.value.isEmpty })
                .help("生成后明文会留在表格里，方便再生成或改错；这个按钮一次清掉")
            Button("全部生成") { state.encryptAll() }
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(ready == 0 || state.current == nil || state.busy)
                .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private var importSheet: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("批量导入").font(.headline)
            Text("每行一条：label, host1|host2, [secret|totp,] 值。TOTP 行可以不写 host。以 # 开头的行忽略。")
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $importText)
                .font(.body.monospaced())
                .frame(minHeight: 200)
            HStack {
                Spacer()
                Button("取消") { showingImport = false }
                Button("导入") {
                    state.importCSV(importText)
                    importText = ""
                    showingImport = false
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 620)
    }
}

private struct EntryRow: View {
    let entry: TokenEntry
    let onChange: (TokenEntry) -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField("label，例如 portal-a/pass", text: Binding(get: { entry.label }, set: { onChange(entry.with(label: $0)) }))
                    .frame(width: 180)
                TextField("host，逗号分隔；可带端口 10.0.0.5:8001；支持 *.example.com",
                          text: Binding(get: { entry.hosts }, set: { onChange(entry.with(hosts: $0)) }))
                Picker("", selection: Binding(get: { entry.kind }, set: { onChange(entry.with(kind: $0, uses: defaultUses(for: $0))) })) {
                    ForEach(SecretKind.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .labelsHidden().frame(width: 150)
                Button(role: .destructive, action: onRemove) { Image(systemName: "minus.circle") }
                    .buttonStyle(.plain).help("删除这一行")
            }
            HStack(spacing: 8) {
                TextField("备注：这个平台是做什么的，例如 财务系统", text: Binding(get: { entry.note }, set: { onChange(entry.with(note: $0)) }))
                TextField("账号（可选）", text: Binding(get: { entry.account }, set: { onChange(entry.with(account: $0)) }))
                    .frame(width: 200)
                Toggle("账号也加密", isOn: Binding(get: { entry.encryptAccount }, set: { onChange(entry.with(encryptAccount: $0)) }))
                    .toggleStyle(.checkbox).font(.caption)
                    .disabled(entry.account.isEmpty)
                    .help("多铸一个 <label>/user 密文，条目里的账号行也是 enc:v1:，模型看不到账号名")
            }
            HStack(spacing: 8) {
                SecureField(entry.kind == .totp ? "2FA 的 base32 密钥" : "密码 / token 的值",
                            text: Binding(get: { entry.value }, set: { onChange(entry.with(value: $0)) }))
                ForEach(SecretUse.allCases, id: \.self) { use in
                    Toggle(use.title, isOn: Binding(
                        get: { entry.uses.contains(use) },
                        set: { on in onChange(entry.with(uses: on ? entry.uses.union([use]) : entry.uses.subtracting([use]))) }
                    ))
                    .toggleStyle(.checkbox).font(.caption)
                }
            }
            if let problem = entry.problem {
                Text(problem).font(.caption).foregroundStyle(.orange)
            }
        }
        .textFieldStyle(.roundedBorder)
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
    }

    private func defaultUses(for kind: SecretKind) -> Set<SecretUse> {
        kind == .totp ? [.otp] : [.http]
    }
}
