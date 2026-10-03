import AgentSwitchMacCore
import AppKit
import ImageIO

/// The Browser page's screen (docs/browser-v0.md §1 Mac, demo `docs/design/implemented/browser.html`): the tab's frames
/// drawn aspect-fit from the top on the page's black ground, the agent's last action as a cyan box with its label over
/// them, and the keyboard and mouse sent on as the daemon's input events (BrowserGeometry maps points to the frame's
/// pixels; BrowserKeys says which key is what).
///
/// - Frames: decoded off the main thread, only the newest (a frame that comes while one is decoded replaces the one
///   waiting), shown as a layer's contents. `draw(_:)` draws the same for a picture of the window (`cacheDisplay`: the
///   design preview, the probe), which does not see layers.
/// - Mouse: moves (with the window key), presses and releases of the three buttons with their click counts, drags
///   (kept at the frame's edge once they leave it), the wheel and the trackpad as scrolling, in the frame's pixels; a
///   mouse's side buttons (4 and 5, AppKit's 3 and 4) go back and forward, as in a browser.
/// - Keyboard, while the screen has focus: named keys and ⌘ / ⌃ letters as keys; typed characters through the text
///   input system (`NSTextInputClient`), so an input method composes here — the marked text shown at the last click —
///   and commits text; ⌘V types the Mac's clipboard (the page's `paste`); ⌘C ⌘X cannot copy out of a picture. A
///   composition is dropped, not carried over, when the screen loses the keyboard or shows another tab.
@MainActor
final class BrowserScreenView: NSView, @preconcurrency NSTextInputClient {
    /// An input event for the tab on screen (the model decides whether it may go).
    var onInput: (BrowserInputEvent) -> Void = { _ in }
    var onPaste: () -> Void = {}
    var onCopy: () -> Void = {}
    /// The size changed (a held tab's size follows it).
    var onResize: () -> Void = {}
    /// A mouse's back or forward button.
    var onHistory: (BrowserHistoryAction) -> Void = { _ in }

    /// Where the frame on screen sits on the page; nil before the first.
    private(set) var geometry: BrowserFrameGeometry?
    private var image: CGImage?
    private var action: (box: BrowserBox, label: String)?

    private let imageLayer = CALayer()
    private let boxLayer = CALayer()
    private let labelLayer = CALayer()
    private let labelText = CATextLayer()
    private let markedField = NSTextField(labelWithString: "")

    /// The newest frame not drawn yet, and whether a decode is under way.
    private var waiting: BrowserFrame?
    private var decoding = false
    /// Frames from before `clear()` are not drawn.
    private var generation = 0

    /// The input method's marked text (shown, not sent, until committed).
    private var marked = ""
    /// The last click, for where the marked text and the input method's candidates go.
    private var caret = CGPoint(x: 24, y: 24)
    /// The buttons pressed on the frame (an up is sent only for a down that was).
    private var pressed: Set<String> = []

    static let cyan = NSColor(srgbRed: 0x2E / 255.0, green: 0xE6 / 255.0, blue: 0xFF / 255.0, alpha: 1)
    static let labelFont = NSFont.monospacedSystemFont(ofSize: 10.5, weight: .semibold)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        for layer in [imageLayer, boxLayer, labelLayer, labelText] {
            layer.actions = ["contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "frame": NSNull(), "hidden": NSNull()]
        }
        imageLayer.contentsGravity = .resize
        imageLayer.magnificationFilter = .linear
        boxLayer.borderColor = Self.cyan.cgColor
        boxLayer.borderWidth = 2
        boxLayer.isHidden = true
        labelLayer.backgroundColor = Self.cyan.cgColor
        labelLayer.isHidden = true
        labelText.font = Self.labelFont
        labelText.fontSize = Self.labelFont.pointSize
        labelText.foregroundColor = NSColor.black.cgColor
        labelText.alignmentMode = .left
        labelText.truncationMode = .end
        labelLayer.addSublayer(labelText)
        markedField.font = .systemFont(ofSize: 15)
        markedField.textColor = .black
        markedField.drawsBackground = true
        markedField.backgroundColor = Self.cyan
        markedField.isHidden = true
        addSubview(markedField)
        setAccessibilityLabel("Browser Screen")
        setAccessibilityRole(.image)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    /// The keyboard goes elsewhere (the address bar, another page): what the input method was composing goes too.
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { discardComposition() }
        return resigned
    }
    override var wantsUpdateLayer: Bool { true }

    override func makeBackingLayer() -> CALayer {
        let layer = CALayer()
        for sub in [imageLayer, boxLayer, labelLayer] { layer.addSublayer(sub) }
        return layer
    }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.black.cgColor
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        labelText.contentsScale = scale
        imageLayer.contentsScale = scale
    }

    override func layout() {
        super.layout()
        place()
    }

    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize != frame.size
        super.setFrameSize(newSize)
        if changed { onResize() }
    }

    // MARK: frames

    /// The newest frame: drawn once decoded, unless a newer one came meanwhile.
    func show(_ frame: BrowserFrame) {
        waiting = frame
        guard !decoding else { return }
        decoding = true
        let generation = generation
        Task { [weak self] in
            while let self, self.generation == generation, let next = self.waiting {
                self.waiting = nil
                let decoded = await Task.detached(priority: .userInitiated) { DecodedFrame.decode(next) }.value
                if self.generation == generation, let decoded { self.present(decoded.image, next.geometry) }
            }
            // After `clear()` the flag is the next screen's.
            guard let self, self.generation == generation else { return }
            self.decoding = false
        }
    }

    /// An image drawn at once (the design preview's made-up frames).
    func present(_ image: CGImage, _ geometry: BrowserFrameGeometry) {
        self.image = image
        let resized = self.geometry.map { $0.width != geometry.width || $0.height != geometry.height } ?? true
        self.geometry = geometry
        imageLayer.contents = image
        if resized { place() }
        needsDisplay = true
    }

    /// Nothing on screen (another tab is coming); a decode under way is dropped, and so is a composition (its text was
    /// meant for the tab that was here).
    func clear() {
        generation += 1
        waiting = nil
        decoding = false
        image = nil
        geometry = nil
        imageLayer.contents = nil
        pressed = []
        discardComposition()
        place()
        needsDisplay = true
    }

    /// The agent's last action (a box in the page's CSS pixels and its label), or nothing.
    func setAction(_ action: BrowserAction?, owner: BrowserOwner) {
        let next = action.flatMap { a in a.box.map { ($0, BrowserTabText.actionLabel(a, owner: owner)) } }
        if next?.0 == self.action?.box, next?.1 == self.action?.label { return }
        self.action = next.map { (box: $0.0, label: $0.1) }
        place()
        needsDisplay = true
    }

    /// The size the Mac asks for while it holds the tab: these points, at the display's scale.
    var viewportRequest: BrowserViewportRequest? {
        guard bounds.width >= 1, bounds.height >= 1 else { return nil }
        return BrowserGeometry.viewport(for: bounds.size, backingScale: Double(window?.backingScaleFactor ?? 2))
    }

    var hasFrame: Bool { image != nil }

    private func place() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard let geometry else {
            imageLayer.frame = .zero
            boxLayer.isHidden = true
            labelLayer.isHidden = true
            return
        }
        imageLayer.frame = BrowserGeometry.fit(geometry, in: bounds.size)
        guard let (outline, label, labelSize) = overlay(geometry) else {
            boxLayer.isHidden = true
            labelLayer.isHidden = true
            return
        }
        boxLayer.frame = outline
        boxLayer.isHidden = false
        labelLayer.frame = CGRect(origin: label, size: labelSize)
        labelText.frame = CGRect(x: 6, y: 2, width: labelSize.width - 12, height: labelSize.height - 3)
        labelText.string = action?.label ?? ""
        labelLayer.isHidden = false
    }

    /// The box around the action's element (2 pt cyan, 3 pt out, as the demo's outline) and where its label goes: above
    /// it, or below when there is no room above.
    private func overlay(_ geometry: BrowserFrameGeometry) -> (CGRect, CGPoint, CGSize)? {
        guard let action, let rect = BrowserGeometry.viewRect(action.box, frame: geometry, in: bounds.size) else { return nil }
        let outline = rect.insetBy(dx: -5, dy: -5)
        let text = (action.label as NSString).size(withAttributes: [.font: Self.labelFont])
        let size = CGSize(width: min(ceil(text.width) + 12, max(bounds.width - 8, 40)), height: ceil(text.height) + 4)
        let above = outline.minY - size.height - 2
        let y = above >= 0 ? above : outline.maxY + 2
        let x = min(max(outline.minX, 0), max(bounds.width - size.width, 0))
        return (outline, CGPoint(x: x, y: y), size)
    }

    /// A picture of the window (`cacheDisplay` draws views, not their layers): the same as the layers show.
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        guard let geometry, let image else { return }
        NSImage(cgImage: image, size: .zero).draw(in: BrowserGeometry.fit(geometry, in: bounds.size), from: .zero, operation: .sourceOver,
                                                  fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high.rawValue])
        guard let (outline, label, size) = overlay(geometry), let text = action?.label else { return }
        Self.cyan.setStroke()
        let path = NSBezierPath(rect: outline.insetBy(dx: 1, dy: 1))
        path.lineWidth = 2
        path.stroke()
        Self.cyan.setFill()
        CGRect(origin: label, size: size).fill()
        (text as NSString).draw(at: CGPoint(x: label.x + 6, y: label.y + 2), withAttributes: [.font: Self.labelFont, .foregroundColor: NSColor.black])
    }

    // MARK: mouse

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        press(.down, event, .left)
    }
    override func mouseUp(with event: NSEvent) { press(.up, event, .left) }
    override func mouseDragged(with event: NSEvent) { move(event, dragging: true) }
    override func mouseMoved(with event: NSEvent) { move(event, dragging: !pressed.isEmpty) }

    override func rightMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        press(.down, event, .right)
    }
    override func rightMouseUp(with event: NSEvent) { press(.up, event, .right) }
    override func rightMouseDragged(with event: NSEvent) { move(event, dragging: true) }

    /// The middle button is AppKit's button 2; 3 and 4 are a mouse's side buttons, back and forward (not clicks).
    override func otherMouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        switch event.buttonNumber {
        case 2: press(.down, event, .middle)
        case 3 where geometry != nil: onHistory(.back)
        case 4 where geometry != nil: onHistory(.forward)
        default: break
        }
    }
    override func otherMouseUp(with event: NSEvent) { if event.buttonNumber == 2 { press(.up, event, .middle) } }
    override func otherMouseDragged(with event: NSEvent) { if event.buttonNumber == 2 { move(event, dragging: true) } }

    /// A press starts only on the frame; its release goes wherever the pointer is (at the frame's edge).
    private func press(_ action: BrowserMouseAction, _ event: NSEvent, _ button: BrowserMouseButton) {
        guard let geometry else { return }
        let point = convert(event.locationInWindow, from: nil)
        let down = action == .down
        if !down, !pressed.contains(button.rawValue) { return }
        guard let at = BrowserGeometry.framePoint(point, frame: geometry, in: bounds.size, clamped: !down) else { return }
        if down {
            pressed.insert(button.rawValue)
            caret = point
        } else {
            pressed.remove(button.rawValue)
        }
        onInput(.mouse(action, x: at.x, y: at.y, button: button, clickCount: min(max(event.clickCount, 1), 3),
                       modifiers: Self.modifiers(event), seq: geometry.seq))
    }

    private func move(_ event: NSEvent, dragging: Bool) {
        guard let geometry else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard let at = BrowserGeometry.framePoint(point, frame: geometry, in: bounds.size, clamped: dragging) else { return }
        onInput(.mouse(.move, x: at.x, y: at.y, modifiers: Self.modifiers(event), seq: geometry.seq))
    }

    /// The page's wheel runs the other way from AppKit's deltas (positive is down); lines are 40 pt, as a browser's.
    override func scrollWheel(with event: NSEvent) {
        guard let geometry else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard let at = BrowserGeometry.framePoint(point, frame: geometry, in: bounds.size) else { return }
        let factor: Double = event.hasPreciseScrollingDeltas ? 1 : 40
        let dx = BrowserGeometry.frameDistance(-Double(event.scrollingDeltaX) * factor, frame: geometry, in: bounds.size)
        let dy = BrowserGeometry.frameDistance(-Double(event.scrollingDeltaY) * factor, frame: geometry, in: bounds.size)
        guard dx != 0 || dy != 0 else { return }
        onInput(.wheel(x: at.x, y: at.y, deltaX: dx, deltaY: dy, modifiers: Self.modifiers(event), seq: geometry.seq))
    }

    static func modifiers(_ event: NSEvent) -> BrowserModifiers {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var out: BrowserModifiers = []
        if flags.contains(.shift) { out.insert(.shift) }
        if flags.contains(.control) { out.insert(.control) }
        if flags.contains(.option) { out.insert(.option) }
        if flags.contains(.command) { out.insert(.command) }
        return out
    }

    // MARK: keyboard

    override func keyDown(with event: NSEvent) {
        // An input method composing takes every key until it commits.
        if hasMarkedText() { interpretKeyEvents([event]); return }
        switch BrowserKeys.action(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers, modifiers: Self.modifiers(event)) {
        case .key(let name, let modifiers): onInput(.key(name, modifiers: modifiers))
        case .paste: onPaste()
        case .copy, .cut: onCopy()
        case .text: interpretKeyEvents([event])
        case .ignore: super.keyDown(with: event)
        }
    }

    // MARK: NSTextInputClient

    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        unmarkText()
        for event in BrowserInputEvent.texts(text) { onInput(event) }
    }

    override func doCommand(by selector: Selector) {
        if let key = BrowserKeys.key(forCommand: NSStringFromSelector(selector)) { onInput(key) }
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        marked = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        showMarked()
    }

    func unmarkText() {
        marked = ""
        showMarked()
    }

    /// The input method drops its composition (nothing is committed) and the marked text goes.
    private func discardComposition() {
        inputContext?.discardMarkedText()
        unmarkText()
    }

    func selectedRange() -> NSRange { NSRange(location: marked.utf16.count, length: 0) }

    func markedRange() -> NSRange { marked.isEmpty ? NSRange(location: NSNotFound, length: 0) : NSRange(location: 0, length: marked.utf16.count) }

    func hasMarkedText() -> Bool { !marked.isEmpty }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.underlineStyle] }

    /// The candidates go under the marked text, at the last click.
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        let local = markedField.isHidden ? NSRect(x: caret.x, y: caret.y, width: 1, height: 18) : markedField.frame
        guard let window else { return .zero }
        return window.convertToScreen(convert(local, to: nil))
    }

    func characterIndex(for point: NSPoint) -> Int { NSNotFound }

    private func showMarked() {
        markedField.isHidden = marked.isEmpty
        guard !marked.isEmpty else { return }
        markedField.attributedStringValue = NSAttributedString(string: marked, attributes: [
            .font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.black, .underlineStyle: NSUnderlineStyle.single.rawValue,
        ])
        markedField.sizeToFit()
        let size = markedField.frame.size
        markedField.frame = NSRect(x: min(max(caret.x, 0), max(bounds.width - size.width, 0)), y: min(max(caret.y - size.height - 4, 0), max(bounds.height - size.height, 0)),
                                   width: size.width + 4, height: size.height)
    }
}

/// A decoded JPEG handed from the decoding task to the main thread (CGImage is immutable).
struct DecodedFrame: @unchecked Sendable {
    let image: CGImage

    static func decode(_ frame: BrowserFrame) -> DecodedFrame? {
        guard let data = frame.jpeg, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        return DecodedFrame(image: image)
    }
}
