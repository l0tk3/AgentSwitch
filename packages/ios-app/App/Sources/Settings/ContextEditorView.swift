import AgentSwitchKit
import SwiftUI

/// CONTEXT.md on the Mac (router-v0 §2b): edited here, saved with `PUT /context`. The Mac seals the credentials in it
/// like a task's and lints it; the editor then shows what was actually stored, what was sealed and the warnings.
/// Unsaved edits keep the Settings sheet from being swiped away.
struct ContextEditorView: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    /// The text as last read from the Mac; nil until the first load succeeds (no save before that).
    @State private var stored: String?
    @State private var warnings: [String] = []
    @State private var error: String?
    @State private var saving = false
    @State private var saved: ContextSaveResult?
    @State private var picking = false

    var body: some View {
        Form {
            Section {
                TextEditor(text: $text)
                    .font(.callout.monospaced())
                    .frame(minHeight: 320)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            } footer: {
                Text("记录站点、账号、环境和偏好。密码可直接填写，保存时由 Mac 加密。")
            }
            if !warnings.isEmpty {
                Section(label: "Save Notes") {
                    ForEach(warnings, id: \.self) { Text($0).font(.footnote).foregroundStyle(Theme.waiting) }
                }
            }
            if error != nil {
                Section { ErrorText(message: $error) }
            }
            if let saved, !dirty {
                Section { Label(Self.savedLine(saved), systemImage: "checkmark.circle").foregroundStyle(Theme.done) }
            }
        }
        .navigationTitle("Context")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Menu {
                    Button("Insert Ciphertext", systemImage: "lock") { picking = true }
                        .disabled(model.ciphertexts.isEmpty)
                    Button("Load Example", systemImage: "doc.text") { Task { await loadExample() } }
                        .disabled(!text.isEmpty)
                    Button("Revert", systemImage: "arrow.uturn.backward") { text = stored ?? "" }
                        .disabled(!dirty)
                } label: { LookGlyph.more }
                Button(saving ? "保存中" : "保存") { Task { await save() } }
                    .disabled(saving || !dirty || stored == nil)
            }
        }
        .interactiveDismissDisabled(dirty)
        .sheet(isPresented: $picking) {
            CiphertextPicker { token in text += (text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " ") + token }
        }
        .task { if stored == nil { await load() } }
    }

    private var dirty: Bool { stored != nil && text != stored }

    static func savedLine(_ result: ContextSaveResult) -> String {
        var parts = ["已保存"]
        if !result.sealed.isEmpty { parts.append("\(result.sealed.count) 个凭据已加密（\(result.sealed.map(\.field).joined(separator: "、"))）") }
        if !result.warnings.isEmpty { parts.append("部分行已移除") }
        return parts.joined(separator: "，")
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            let doc = try await api.context()
            text = doc.text
            stored = doc.text
            warnings = doc.warnings
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }

    private func loadExample() async {
        guard let api = model.api else { return }
        do { text = try await api.contextExample() } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        guard let api = model.api else { return }
        saving = true
        defer { saving = false }
        do {
            let result = try await api.saveContext(text)
            await load()   // what the Mac kept, after sealing and the lint
            warnings = result.warnings
            saved = result
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}
