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
    /// What the empty field says. The field draws it itself: it is empty only while nothing is typed *and* nothing is
    /// being composed — an input method's letters are in the field before they are in `text`, and words drawn over it
    /// from outside sat on top of them (2026-10-07, user: 打字的时候这个占位的字体会覆盖我的字体).
    var placeholder = ""
    /// Put in place of a range once (a completion taken from a list over the field).
    var replace: ReplaceRequest? = nil
    /// A list open over the field takes these keys first: true when it took the key.
    var onKey: ((ComposeKey) -> Bool)? = nil
    /// What is in the field and where its caret is (UTF-16), as either changes.
    var onCaret: ((String, Int) -> Void)? = nil
    var onSubmit: () -> Void
    var onFiles: ([URL]) -> Void
    /// The clipboard holds files or an image: attach them instead of pasting text.
    var onPasteAttachments: () -> Void
    var onFocus: (Bool) -> Void

    /// The size of what you said in the conversation, moved with it by the size set in 设置 › General.
    static var font: NSFont { NSFont.systemFont(ofSize: Look.typed) }
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
        scroll.hasVerticalScroller = false
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
        view.placeholder = placeholder
        view.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        guard let view = coordinator.view else { return }
        if view.placeholder != placeholder { view.placeholder = placeholder }
        // The text size was changed in the settings: the field's own follows, and its height with it.
        let font = Self.font
        if view.font?.pointSize != font.pointSize {
            view.font = font
            view.typingAttributes[.font] = font
            view.needsDisplay = true
            coordinator.measure()
        }
        if view.string != text, !view.hasMarkedText() {
            view.string = text
            // Put in from outside (sent, another draft): what was typed before cannot be undone into this text.
            coordinator.undo.removeAllActions()
            view.needsDisplay = true
            coordinator.measure()
        }
        if let insert, insert.id != coordinator.inserted, Self.take(insert.id) {
            coordinator.inserted = insert.id
            view.window?.makeFirstResponder(view)
            let range = view.selectedRange()
            let before = range.location > 0 && range.location <= (view.string as NSString).length
                ? (view.string as NSString).substring(with: NSRange(location: range.location - 1, length: 1)).first : nil
            view.insertText(insert.tokens.isEmpty ? insert.text : TerminalDraft.typed(insert.tokens, after: before), replacementRange: range)
        }
        if let replace, replace.id != coordinator.replaced, Self.take(replace.id) {
            coordinator.replaced = replace.id
            if NSMaxRange(replace.range) <= (view.string as NSString).length {
                view.window?.makeFirstResponder(view)
                view.insertText(replace.text, replacementRange: replace.range)
            }
        }
        if !active {
            if view.window?.firstResponder === view { view.window?.makeFirstResponder(nil) }
        } else if focusRequests != coordinator.focused {
            coordinator.focused = focusRequests
            view.wantsFocus = true
            DispatchQueue.main.async { view.takeFocusIfShown() }
        }
    }

    /// The requests put in so far, by any field. A request stays on its model after it is put in, and a field made
    /// again (another pane, the other view, the page shown again) has a coordinator that never saw it: it put the
    /// suggestion taken with Tab in once more each time — the box filled with the same sentence over and over
    /// (2026-10-16, user: 我这边对话框还在一直自己自己补对话). One asked once is put in once.
    @MainActor private static var taken: [UUID] = []
    @MainActor private static func take(_ id: UUID) -> Bool {
        guard !taken.contains(id) else { return false }
        taken.append(id)
        if taken.count > 64 { taken.removeFirst(taken.count - 64) }
        return true
    }

    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
        coordinator.undo.removeAllActions()
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposeField
        weak var view: ComposeTextView?
        var inserted: UUID?
        var replaced: UUID?
        /// The focus request last acted on; -1: the field takes the keyboard as it first shows.
        var focused = -1
        /// The field's own undo, gone with the field. Left to the window's, its typing stays there after the field
        /// is replaced (another terminal's reply box, the other view), and the next ⌘Z anywhere in the window calls the
        /// freed text view: the app quit that way on 2026-10-11. ⌘Z here also never undoes another field's typing.
        let undo = UndoManager()

        init(_ parent: ComposeField) { self.parent = parent }

        func undoManager(for view: NSTextView) -> UndoManager? { undo }

        func textDidChange(_ notification: Notification) {
            guard let view else { return }
            if parent.text != view.string { parent.text = view.string }
            measure()
            caretMoved()
        }

        func textViewDidChangeSelection(_ notification: Notification) { caretMoved() }

        /// Told a moment later: the text is also set from the model (while the views are being brought up to date),
        /// and what is told changes what is shown.
        private func caretMoved() {
            guard let view, let tell = parent.onCaret else { return }
            let text = view.string, caret = view.selectedRange().location
            DispatchQueue.main.async { tell(text, caret) }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                } else if parent.onKey?(.enter) != true {
                    parent.onSubmit()
                }
                return true
            case #selector(NSResponder.moveUp(_:)):
                return parent.onKey?(.up) ?? false
            case #selector(NSResponder.moveDown(_:)):
                return parent.onKey?(.down) ?? false
            case #selector(NSResponder.insertTab(_:)):
                return parent.onKey?(.tab) ?? false
            case #selector(NSResponder.insertLineBreak(_:)):
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            case #selector(NSResponder.cancelOperation(_:)), #selector(NSResponder.complete(_:)):
                _ = parent.onKey?(.escape)
                return true   // no completion list of the system's on Esc
            default:
                return false
            }
        }

        /// The text's height, one line to six; the rest scrolls.
        func measure() {
            guard let view, let manager = view.layoutManager, let container = view.textContainer else { return }
            manager.ensureLayout(for: container)
            let used = manager.usedRect(for: container).height
            // A scroller only for more than the box holds. Where scrollers take room (a mouse, or “always show”), one
            // shown for a moment — the box a line shorter than the text until its new height comes — narrowed the text,
            // which wrapped onto a second line and grew the box, which hid the scroller, which let it fit on one again:
            // the box jumped between one line and two without end (2026-10-16, user: 在简略模式写两行字然后删除的刚好只剩下一行的时候就会触发抽搐动作).
            let over = ceil(used) > ComposeField.maxHeight
            if let scroll = view.enclosingScrollView, scroll.hasVerticalScroller != over { scroll.hasVerticalScroller = over }
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

/// A key a list over the field may take before the field does.
enum ComposeKey { case up, down, tab, enter, escape }

/// Text put in place of a range of the field, once.
struct ReplaceRequest: Equatable {
    let id = UUID()
    let range: NSRange
    let text: String
}

/// The input's text view: paste and drop take files, focus is reported.
final class ComposeTextView: NSTextView {
    weak var coordinator: ComposeField.Coordinator?
    /// Asked for the keyboard while the page was hidden (⌘N from Terminals, before the page is in): taken once shown.
    var wantsFocus = false

    var placeholder = "" { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !placeholder.isEmpty, string.isEmpty, !hasMarkedText() else { return }
        let origin = NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height)
        (placeholder as NSString).draw(at: origin, withAttributes: [.font: ComposeField.font, .foregroundColor: NSColor(Look.faint)])
    }

    // What is in the field changed, by a key or by an input method: the placeholder comes or goes with it.
    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        needsDisplay = true
    }

    override func unmarkText() {
        super.unmarkText()
        needsDisplay = true
    }

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
