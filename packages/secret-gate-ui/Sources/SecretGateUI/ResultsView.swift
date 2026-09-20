import AppKit
import SecretGateCore
import SwiftUI
import UniformTypeIdentifiers

struct ResultsView: View {
    let results: [TokenResult]
    let onClear: () -> Void
    @State private var copiedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("结果：\(results.filter(\.ok).count) 成功，\(results.filter { !$0.ok }.count) 失败")
                    .font(.headline)
                Spacer()
                Button("复制全部") { copy(allText) }
                Button("保存为 JSON") { saveJSON() }
                Button("清空", action: onClear)
            }
            List(results) { r in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: r.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(r.ok ? Color.green : Color.red)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.label ?? "?").font(.body.weight(.medium))
                        Text(r.token ?? r.error ?? "").font(.caption.monospaced())
                            .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                            .foregroundStyle(r.ok ? Color.secondary : Color.red)
                    }
                    Spacer()
                    if let tok = r.token {
                        Button(copiedID == r.id ? "已复制" : "复制") {
                            copy(tok)
                            copiedID = r.id
                        }
                        .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            }
        }
        .padding(12)
    }

    private var allText: String {
        results.compactMap { r in r.token.map { "\(r.label ?? ""): \($0)" } }.joined(separator: "\n")
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func saveJSON() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "secret-gate-tokens.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let rows = results.filter(\.ok).map { ["label": $0.label ?? "", "token": $0.token ?? ""] }
        if let data = try? JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted]) {
            try? data.write(to: url)
        }
    }
}
