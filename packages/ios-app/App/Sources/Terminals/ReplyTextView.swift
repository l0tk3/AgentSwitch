import AgentSwitchKit
import SwiftUI
import UIKit

// The reply box's text (docs/simple-view-v0.md §5.1, docs/terminal-v0.md §4): UIKit's own text view under it, for the
// one thing SwiftUI's field cannot do — take a picture from the system's Paste (2026-10-07, user: 手机上要可以直接用ios的
// 粘贴来粘贴图片). With a picture on the clipboard its menu offers Paste, and the picture becomes one of the reply's
// files; text is pasted as text. It also says where its caret is on every iOS, so a placeholder goes in there.

/// A text view whose Paste takes pictures.
final class PasteTextView: UITextView {
    /// Pictures pasted: the reply's files, not its text. Nil: pictures are not taken here (a sealed reply).
    var onImages: (([UIImage]) -> Void)?
    /// The clipboard asked and read: the phone's; a check's own, so nothing of yours is touched.
    var board: UIPasteboard = .general
    let hint = UILabel()

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        // Asking whether there are pictures does not read them (no "Allow Paste" question).
        if action == #selector(paste(_:)), onImages != nil, board.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        // Pictures and no text with them: a screenshot, a photo copied. Text copied with a picture pastes as text.
        if let onImages, board.hasImages, !board.hasStrings, let images = board.images, !images.isEmpty {
            onImages(images)
            return
        }
        super.paste(sender)
    }
}

struct ReplyTextView: UIViewRepresentable {
    let prompt: String
    @Binding var text: String
    /// Placeholders to put in where the caret is, once.
    @Binding var pending: [String]
    @Binding var focused: Bool
    var monospaced = false
    var lines: ClosedRange<Int> = 1...5
    var onImages: (([UIImage]) -> Void)?
    #if DEBUG
    /// A check's own clipboard, pasted from once the view is up.
    var demoBoard: UIPasteboard?
    #endif

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> PasteTextView {
        let view = PasteTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.autocorrectionType = .no
        view.autocapitalizationType = .none
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.textColor = .label
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.hint.textColor = .placeholderText
        view.hint.numberOfLines = 1
        view.hint.adjustsFontForContentSizeCategory = true
        view.addSubview(view.hint)
        return view
    }

    func updateUIView(_ view: PasteTextView, context: Context) {
        context.coordinator.parent = self
        let font: UIFont = monospaced ? UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 14, weight: .regular)) : .preferredFont(forTextStyle: .body)
        if view.font != font { view.font = font; view.hint.font = font }
        view.onImages = onImages
        // What an input method is composing is in the view before it is in `text`: left alone until it is done.
        let coordinator = context.coordinator
        if view.text != text, view.markedTextRange == nil, coordinator.inserting.isEmpty { view.text = text }
        if !pending.isEmpty, pending != coordinator.inserting {
            let tokens = pending
            coordinator.inserting = tokens
            let at = (view.text as NSString).substring(to: min(view.selectedRange.location, (view.text as NSString).length)).count
            let result = TerminalDraft.insert(tokens, into: view.text, at: view.isFirstResponder ? at : nil)
            view.text = result.text
            let caret = (String(result.text.prefix(result.caret)) as NSString).length
            view.selectedRange = NSRange(location: caret, length: 0)
            DispatchQueue.main.async {
                text = result.text
                pending = []
                coordinator.inserting = []
            }
        }
        view.hint.text = prompt
        view.hint.isHidden = !view.text.isEmpty || view.markedTextRange != nil
        view.hint.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: font.lineHeight)
        let tall = view.sizeThatFits(CGSize(width: max(view.bounds.width, 10), height: .greatestFiniteMagnitude)).height > CGFloat(lines.upperBound) * font.lineHeight + 1
        if view.isScrollEnabled != tall { view.isScrollEnabled = tall }
        if focused, !view.isFirstResponder, view.window != nil { DispatchQueue.main.async { view.becomeFirstResponder() } }
        if !focused, view.isFirstResponder { DispatchQueue.main.async { view.resignFirstResponder() } }
        #if DEBUG
        if let demoBoard, !context.coordinator.demoPasted, view.window != nil {
            context.coordinator.demoPasted = true
            view.board = demoBoard
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                let offered = view.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil)
                view.paste(nil)
                print("reply paste check: Paste offered \(offered), pictures on the clipboard \(demoBoard.images?.count ?? 0), text '\(view.text ?? "")'")
            }
        }
        #endif
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PasteTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 200
        let line = (view.font ?? .preferredFont(forTextStyle: .body)).lineHeight
        // Asked at no width and at any width too, to see how far it gives: measured within reason.
        let fits = view.sizeThatFits(CGSize(width: min(max(width, 10), 4000), height: .greatestFiniteMagnitude)).height
        let height = min(max(fits, CGFloat(lines.lowerBound) * line), CGFloat(lines.upperBound) * line)
        return CGSize(width: width, height: ceil(height))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ReplyTextView
        /// Placeholders being put in: the text view has them, the page's text not yet.
        var inserting: [String] = []
        var demoPasted = false

        init(_ parent: ReplyTextView) { self.parent = parent }

        func textViewDidChange(_ view: UITextView) {
            (view as? PasteTextView)?.hint.isHidden = !view.text.isEmpty || view.markedTextRange != nil
            if parent.text != view.text { parent.text = view.text }
        }

        func textViewDidBeginEditing(_ view: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ view: UITextView) { if parent.focused { parent.focused = false } }
    }
}
