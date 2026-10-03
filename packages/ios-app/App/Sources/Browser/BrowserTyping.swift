import AgentSwitchKit
import SwiftUI
import UIKit

/// Typing into the page (browser-v0 §1: the system keyboard, text inserted as typed): a field nobody sees holds the
/// keyboard. What the keyboard commits goes to the page and the field is emptied; while an input method composes
/// (pinyin, kana) nothing is sent until a candidate is chosen. Backspace on the empty field and return become keys.
/// Nothing is corrected, predicted or capitalised: the page gets exactly what was typed.
struct BrowserTypingField: UIViewRepresentable {
    @Binding var typing: Bool
    /// What the input method is composing (shown on the key bar, since the field itself is not seen).
    @Binding var composing: String
    var onText: (String) -> Void
    var onKey: (BrowserKey) -> Void

    func makeUIView(context: Context) -> KeyField {
        let field = KeyField(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        field.alpha = 0.02
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.keyboardAppearance = .dark
        field.returnKeyType = .default
        field.textContentType = nil
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.accessibilityLabel = "向页面输入"
        return field
    }

    func updateUIView(_ field: KeyField, context: Context) {
        context.coordinator.parent = self
        field.onBackspace = { [onKey] in onKey(.backspace) }
        if typing, !field.isFirstResponder {
            DispatchQueue.main.async { _ = field.becomeFirstResponder() }
        } else if !typing, field.isFirstResponder {
            field.resignFirstResponder()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    /// Backspace with nothing in the field still reaches the page.
    final class KeyField: UITextField {
        var onBackspace: (() -> Void)?

        override func deleteBackward() {
            if (text ?? "").isEmpty && markedTextRange == nil {
                onBackspace?()
                return
            }
            super.deleteBackward()
        }
    }

    @MainActor
    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: BrowserTypingField

        init(parent: BrowserTypingField) { self.parent = parent }

        /// Committed text goes; text still being composed waits.
        @objc func changed(_ field: UITextField) {
            if let marked = field.markedTextRange {
                parent.composing = field.text(in: marked) ?? ""
                return
            }
            parent.composing = ""
            guard let text = field.text, !text.isEmpty else { return }
            field.text = ""
            parent.onText(text)
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            if field.markedTextRange == nil { parent.onKey(.enter) }
            return false
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            parent.composing = ""
            if parent.typing { parent.typing = false }
        }
    }
}
