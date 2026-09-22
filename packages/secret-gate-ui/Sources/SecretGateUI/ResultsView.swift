import AppKit
import SecretGateCore
import SwiftUI
import UniformTypeIdentifiers

/// Minted tokens with everything needed to paste them into AgentSwitch's CONTEXT.md: per row "复制条目"
/// gives the list item (note, label, hosts, account, token); "复制全部" gives all of them; the bare token
/// is still one click away.
struct ResultsView: View {
    let results: [MintedRow]
    let onClear: () -> Void
    @State private var copied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("结果：\(results.filter(\.ok).count) 成功，\(results.filter { !$0.ok }.count) 失败")
                    .font(.headline)
                Spacer()
                Button(copied == "all" ? "已复制全部条目" : "复制全部条目") { copy(allEntries, id: "all") }
                    .help("按 CONTEXT.md 的格式：备注（label）：host / 账号 / 密码 enc:v1:…")
                Button("保存为 JSON") { saveJSON() }
                Button("清空", action: onClear)
            }
            List(results) { r in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: r.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(r.ok ? Color.green : Color.red)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(r.label).font(.body.weight(.medium))
                            if !r.note.isEmpty { Text(r.note).foregroundStyle(.secondary) }
                            if !r.account.isEmpty { Text("账号 \(r.account)").font(.caption).foregroundStyle(.secondary) }
                        }
                        Text(r.hosts.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                        Text(r.token ?? r.error ?? "").font(.caption.monospaced())
                            .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                            .foregroundStyle(r.ok ? Color.secondary : Color.red)
                    }
                    Spacer()
                    if let entry = r.contextEntry, let tok = r.token {
                        Button(copied == r.id.uuidString ? "已复制" : "复制条目") { copy(entry, id: r.id.uuidString) }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                            .help("备注、label、host、账号、密文一起，可直接贴进 CONTEXT.md")
                        Button("只复制密文") { copy(tok, id: r.id.uuidString + "/tok") }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            }
            Text("显示的密文中间是省略的，不要从文字里选中复制；用按钮。").font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
    }

    private var allEntries: String {
        results.compactMap(\.contextEntry).joined(separator: "\n")
    }

    private func copy(_ text: String, id: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = id
    }

    private func saveJSON() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "secret-gate-tokens.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let rows = results.filter(\.ok).map(\.exportObject)
        if let data = try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]) {
            try? data.write(to: url)
        }
    }
}
