import AppKit
import SwiftUI

/// A one-line field of the Terminals page's own — the search, a name being changed, a folder — AppKit's rather than
/// SwiftUI's: the keyboard goes to it when it is asked for, whether or not the window is in front, and ↩, esc and
/// losing the keyboard are told. Corrections are off (paths and names are typed here).
struct PlainField: NSViewRepresentable {
    @Binding var text: String
    var placeholder = ""
    var font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    var color = NSColor(white: 0.91, alpha: 1)
    var placeholderColor = NSColor(white: 0.3, alpha: 1)
    /// Each change puts the keyboard here, the text selected.
    var focusRequests = 0
    /// The field takes the keyboard as it first shows (a name being changed).
    var takesFocusAtFirst = false
    var onSubmit: () -> Void = {}
    var onCancel: () -> Void = {}
    /// The keyboard came (true) or went.
    var onFocus: (Bool) -> Void = { _ in }

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(self)
        if !takesFocusAtFirst { coordinator.focused = focusRequests }
        return coordinator
    }

    func makeNSView(context: Context) -> PlainTextField {
        let field = PlainTextField()
        field.delegate = context.coordinator
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.usesSingleLineMode = true
        field.lineBreakMode = .byTruncatingTail
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.stringValue = text
        field.onFocus = { [weak coordinator = context.coordinator] in coordinator?.parent.onFocus(true) }
        return field
    }

    func updateNSView(_ field: PlainTextField, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if field.stringValue != text, (field.currentEditor() as? NSTextView)?.hasMarkedText() != true { field.stringValue = text }
        field.font = font
        field.textColor = color
        field.placeholderAttributedString = NSAttributedString(string: placeholder, attributes: [.font: font, .foregroundColor: placeholderColor])
        if focusRequests != coordinator.focused {
            coordinator.focused = focusRequests
            DispatchQueue.main.async { [weak field] in
                guard let field, let window = field.window, !field.isHiddenOrHasHiddenAncestor else { return }
                window.makeFirstResponder(field)
                field.currentEditor()?.selectAll(nil)
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: PlainTextField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 120, height: ceil(font.ascender - font.descender + font.leading) + 2)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: PlainField
        /// The focus request last acted on.
        var focused = -1

        init(_ parent: PlainField) { self.parent = parent }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField, parent.text != field.stringValue else { return }
            parent.text = field.stringValue
        }

        func controlTextDidEndEditing(_ notification: Notification) { parent.onFocus(false) }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                parent.onSubmit()
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                parent.onCancel()
                return true
            default:
                return false
            }
        }
    }
}

/// The field itself: one of the page's own, which the page's key handling knows by its type.
final class PlainTextField: NSTextField {
    var onFocus: () -> Void = {}

    override func becomeFirstResponder() -> Bool {
        let took = super.becomeFirstResponder()
        if took { onFocus() }
        return took
    }

    override func textDidBeginEditing(_ notification: Notification) {
        super.textDidBeginEditing(notification)
        // No corrections or substitutions: paths, names and searches are typed as they are.
        guard let editor = currentEditor() as? NSTextView else { return }
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
    }
}
