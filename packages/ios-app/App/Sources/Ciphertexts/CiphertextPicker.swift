import AgentSwitchKit
import SwiftUI

/// Pick one saved ciphertext (for the input box, a question, or CONTEXT.md; `Fill Ciphertext` on a browser page).
struct CiphertextPicker: View {
    var title = "Insert Ciphertext"
    let onPick: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(model.ciphertexts) { item in
                Button {
                    onPick(item.token)
                    dismiss()
                } label: {
                    VStack(alignment: .leading) {
                        Text(item.note)
                        Text(item.shortToken).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
