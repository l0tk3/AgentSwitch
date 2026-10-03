import AgentSwitchMacCore
import AppKit
import WebKit

/// A link ⌘-clicked in a terminal, by `LinkPolicy`: a web page in the browser, a folder in Finder, a document in its
/// app (as in iTerm); an app, a script or anything else that could run is only shown in Finder. Other schemes are ignored.
enum LinkOpener {
    #if DEBUG
    /// The probe sees what a click would open, instead of it opening.
    @MainActor static var probeOpened: ((URL) -> Void)?
    #endif

    @MainActor static func open(_ url: URL) {
        #if DEBUG
        if let probeOpened { probeOpened(url); return }
        #endif
        switch LinkPolicy.action(for: url) {
        case .browse(let target), .open(let target): NSWorkspace.shared.open(target)
        case .reveal(let target): NSWorkspace.shared.activateFileViewerSelecting([target])
        case .ignore: break
        }
    }
}

/// The page over the native screen: its own parts (the list, the panels, the bars, what floats over the screen) take
/// the mouse; the screen's area, where the page draws nothing, lets it through to the native view below.
final class TerminalStage: NSView {
    let web: TerminalWebView
    let screen: NSView?

    init(web: TerminalWebView, screen: NSView?) {
        self.web = web
        self.screen = screen
        super.init(frame: NSRect(origin: .zero, size: web.frame.size))
        if let screen { addSubview(screen) }
        addSubview(web)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// Top left origin, as the page's coordinates.
    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        web.frame = bounds
    }
}

/// A menu bar app has no Edit menu, so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z never reach the page on their own: send them here.
final class TerminalWebView: WKWebView {
    /// The terminal's screen in the page (its coordinates, top left origin), while one is shown.
    var screenRect: CGRect?
    /// What floats over it (permission requests, the composer, the loading line, a sheet).
    var overlays: [CGRect] = []
    /// A drop on the screen's area (files, text): the terminal's, as in iTerm; anywhere else the page's (WebKit's).
    var dropOnScreen: ((NSPasteboard) -> Bool)?
    /// The drag is over the screen's area now (WebKit is not told of it there).
    private var dragOnScreen = false
    private var droppedOnScreen = false

    private func onScreen(_ info: NSDraggingInfo) -> Bool {
        guard let screen = screenRect, dropOnScreen != nil else { return false }
        let local = convert(info.draggingLocation, from: nil)
        let p = CGPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
        return screen.contains(p) && !overlays.contains(where: { $0.contains(p) })
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        dragOnScreen = onScreen(sender)
        return dragOnScreen ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        let now = onScreen(sender)
        if now != dragOnScreen {
            // Across the screen's edge: WebKit hears the drag leave, or come in.
            if now { super.draggingExited(sender) } else { _ = super.draggingEntered(sender) }
            dragOnScreen = now
        }
        return now ? .copy : super.draggingUpdated(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        if !dragOnScreen { super.draggingExited(sender) }
        dragOnScreen = false
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dragOnScreen ? true : super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard dragOnScreen else { return super.performDragOperation(sender) }
        dragOnScreen = false
        droppedOnScreen = true
        return dropOnScreen?(sender.draggingPasteboard) ?? false
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        if droppedOnScreen { droppedOnScreen = false; return }
        super.concludeDragOperation(sender)
    }

    /// Over the screen and nothing of the page's there: the native screen below takes it (nil lets the stage look
    /// further down).
    override func hitTest(_ point: NSPoint) -> NSView? {
        if let screen = screenRect, let superview {
            let local = convert(point, from: superview)
            let p = CGPoint(x: local.x, y: isFlipped ? local.y : bounds.height - local.y)
            if screen.contains(p), !overlays.contains(where: { $0.contains(p) }) { return nil }
        }
        return super.hitTest(point)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Hidden under the Dispatch page: the window's keys are not the terminals' (⌘W would close one unseen).
        if isHiddenOrHasHiddenAncestor { return false }
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, let key = event.charactersIgnoringModifiers else {
            return super.performKeyEquivalent(with: event)
        }
        // The page's own shortcuts: ⌘W closes the terminal on screen (not the window), ⌘T opens a new one, ⌘B hides or
        // shows the list, ⌘F searches it, ⌘1–9 switch.
        if key == "w" || key == "t" || key == "b" || key == "f" || (key.count == 1 && ("1"..."9").contains(key)) {
            evaluateJavaScript("window.agentswitch?.shortcut(\"\(key)\")", completionHandler: nil)
            return true
        }
        // ⌘A: the page picks (the terminal's own selection, or the text field in focus).
        if key == "a" {
            evaluateJavaScript("window.agentswitch?.selectAll()", completionHandler: nil)
            return true
        }
        let action: Selector? = switch key {
        case "c": #selector(NSText.copy(_:))
        case "v": #selector(NSText.paste(_:))
        case "x": #selector(NSText.cut(_:))
        case "z": Selector(("undo:"))
        default: nil
        }
        if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }
}
