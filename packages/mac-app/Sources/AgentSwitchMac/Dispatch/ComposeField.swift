import AgentSwitchMacCore
import AppKit
import SwiftUI

/// The input's text (docs/dispatch-v0.md §2): several lines that grow to six, ↩ sends and ⇧↩ starts a new line (as the
/// terminal's), an input method's ↩ only ends its composition. A paste with files or an image on the clipboard attaches
/// them; files dropped on it are attachments, not paths. Corrections and substitutions are off: passwords may be typed
/// here (the Mac seals them before anything stores the message). The window forwards ⌘C ⌘V ⌘X ⌘A ⌘Z to it.
struct ComposeField: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    /// Each change puts the keyboard here.
    var focusRequests: Int
    /// Put in at the cursor once (a ciphertext).
    var insert: InsertRequest?
    /// False while a page covers the record: the field gives the keyboard up.
    var active = true
    /// The field takes the keyboard as it first shows (the input, a box opened to write in); false for a field that
    /// waits to be asked (a question's Other).
    var takesFocusAtFirst = true
    var label = "输入任务或问题"
    var onSubmit: () -> Void
    var onFiles: ([URL]) -> Void
    /// The clipboard holds files or an image: attach them instead of pasting text.
    var onPasteAttachments: () -> Void
    var onFocus: (Bool) -> Void

    static let font = NSFont.systemFont(ofSize: 14)
    static let lineSpacing: CGFloat = 3
    static let maxLines = 6
    static var lineHeight: CGFloat { ceil(font.ascender - font.descender + font.leading) }
    static var minHeight: CGFloat { lineHeight }
    static var maxHeight: CGFloat { CGFloat(maxLines) * (lineHeight + lineSpacing) }

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(self)
        if !takesFocusAtFirst { coordinator.focused = focusRequests }
        return coordinator
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let view = ComposeTextView(usingTextLayoutManager: false)
        view.coordinator = context.coordinator
        view.delegate = context.coordinator
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.drawsBackground = false
        view.font = Self.font
        view.textColor = .dispatchInk
        view.insertionPointColor = .dispatchInk
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = Self.lineSpacing
        view.defaultParagraphStyle = paragraph
        view.typingAttributes = [.font: Self.font, .foregroundColor: NSColor.dispatchInk, .paragraphStyle: paragraph]
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.isGrammarCheckingEnabled = false
        view.isAutomaticLinkDetectionEnabled = false
        view.smartInsertDeleteEnabled = false
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.setAccessibilityLabel(label)
        scroll.documentView = view
        context.coordinator.view = view
        view.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let view = coordinator.view else { return }
        if view.string != text, !view.hasMarkedText() {
            view.string = text
            coordinator.measure()
        }
        if let insert, insert.id != coordinator.inserted {
            coordinator.inserted = insert.id
            view.window?.makeFirstResponder(view)
            let range = view.selectedRange()
            let before = range.location > 0 && range.location <= (view.string as NSString).length
                ? (view.string as NSString).substring(with: NSRange(location: range.location - 1, length: 1)).first : nil
            view.insertText(insert.tokens.isEmpty ? insert.text : TerminalDraft.typed(insert.tokens, after: before), replacementRange: range)
        }
        if !active {
            if view.window?.firstResponder === view { view.window?.makeFirstResponder(nil) }
        } else if focusRequests != coordinator.focused {
            coordinator.focused = focusRequests
            view.wantsFocus = true
            DispatchQueue.main.async { view.takeFocusIfShown() }
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposeField
        weak var view: ComposeTextView?
        var inserted: UUID?
        /// The focus request last acted on; -1: the field takes the keyboard as it first shows.
        var focused = -1

        init(_ parent: ComposeField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view else { return }
            if parent.text != view.string { parent.text = view.string }
            measure()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    parent.onSubmit()
                }
                return true
            case #selector(NSResponder.insertLineBreak(_:)):
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            case #selector(NSResponder.cancelOperation(_:)), #selector(NSResponder.complete(_:)):
                return true   // no completion list on Esc
            default:
                return false
            }
        }

        /// The text's height, one line to six; the rest scrolls.
        func measure() {
            guard let view, let manager = view.layoutManager, let container = view.textContainer else { return }
            manager.ensureLayout(for: container)
            let used = manager.usedRect(for: container).height
            let height = min(max(ceil(used), ComposeField.minHeight), ComposeField.maxHeight)
            if abs(height - parent.height) > 0.5 {
                let binding = parent.$height
                DispatchQueue.main.async { binding.wrappedValue = height }
            }
        }

        func focusChanged(_ focused: Bool) {
            let report = parent.onFocus
            DispatchQueue.main.async { report(focused) }
        }

        /// Files or an image (and no text) on the clipboard.
        func pastesAttachments() -> Bool {
            let board = NSPasteboard.general
            if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
                return true
            }
            let types = board.types ?? []
            return !types.contains(.string) && (types.contains(.png) || types.contains(.tiff))
        }
    }
}

/// The input's text view: paste and drop take files, focus is reported.
final class ComposeTextView: NSTextView {
    weak var coordinator: ComposeField.Coordinator?
    /// Asked for the keyboard while the page was hidden (⌘N from Terminals, before the page is in): taken once shown.
    var wantsFocus = false

    /// Never from a hidden page: the terminal page keeps its keyboard while Dispatch is behind it.
    func takeFocusIfShown() {
        guard wantsFocus, let window, !isHiddenOrHasHiddenAncestor else { return }
        wantsFocus = false
        window.makeFirstResponder(self)
    }

    /// Shown again: after the window has put the keyboard on the page, the field takes it if it was asked to.
    override func viewDidUnhide() {
        super.viewDidUnhide()
        DispatchQueue.main.async { [weak self] in self?.takeFocusIfShown() }
    }

    /// A new width wraps the text anew: its height again.
    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = newSize.width != frame.width
        super.setFrameSize(newSize)
        if widthChanged { coordinator?.measure() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        DispatchQueue.main.async { [weak self] in self?.takeFocusIfShown() }
    }

    override func becomeFirstResponder() -> Bool {
        let took = super.becomeFirstResponder()
        if took { coordinator?.focusChanged(true) }
        return took
    }

    override func resignFirstResponder() -> Bool {
        let gave = super.resignFirstResponder()
        if gave { coordinator?.focusChanged(false) }
        return gave
    }

    override func paste(_ sender: Any?) {
        if let coordinator, coordinator.pastesAttachments() {
            coordinator.parent.onPasteAttachments()
            return
        }
        super.paste(sender)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        Self.files(sender) == nil ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        Self.files(sender) == nil ? super.draggingUpdated(sender) : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = Self.files(sender) else { return super.performDragOperation(sender) }
        coordinator?.parent.onFiles(urls)
        return true
    }

    private static func files(_ info: NSDraggingInfo) -> [URL]? {
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        return urls?.isEmpty == false ? urls : nil
    }
}

extension NSColor {
    /// The page's ink (ui-v0 §7.3), for AppKit text.
    static let dispatchInk = NSColor.dynamic(light: 0x151413, dark: 0xE9E6DF, name: "AgentSwitchDispatchInk")
}
