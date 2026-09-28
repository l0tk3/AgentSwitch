import AgentSwitchKit
import SwiftUI

/// Pick one saved ciphertext (for the input box, a question, or CONTEXT.md).
struct CiphertextPicker: View {
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
            .navigationTitle("insert ciphertext")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("cancel") { dismiss() } } }
        }
    }
}
