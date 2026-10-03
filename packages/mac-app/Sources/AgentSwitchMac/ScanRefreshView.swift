import AgentSwitchMacCore
import AppKit

/// A screen drawn afresh over the views under it (`ScanRefresh`, ui-v0 §7.4): the main window's page switch, the
/// terminal page's screen showing another terminal. A step at a time from the top, the ground covers what has not come
/// in yet and a scan line runs on its edge — the phone's `ScreenRefresh` and the web terminal's `wipe` / `scan`. It
/// takes no picture of what is under it (the terminal's screen draws itself) and no mouse, and leaves nothing behind:
/// over, cancelled or played again, it is hidden.
@MainActor
final class ScanRefreshView: NSView {
    private let cover = FillView()
    private let line = FillView()
    /// The refresh and the step on screen, while one plays (or a preview holds one still).
    private var current: (refresh: ScanRefresh, step: Int)?
    private var run = 0
    private var task: Task<Void, Never>?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        isHidden = true
        addSubview(cover)
        addSubview(line)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// Steps count from the top.
    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        place()
    }

    var playing: Bool { current != nil }

    /// Plays `refresh` from its first step, `ground` below the edge and the scan line in `color`; one under way gives
    /// way at once. Steps follow the clock: a step the main thread was too busy to show is skipped, not shown late.
    func play(_ refresh: ScanRefresh, ground: NSColor, line color: NSColor) {
        cancel()
        let token = run
        let start = ContinuousClock.now
        show(step: 0, of: refresh, ground: ground, line: color)
        task = Task { @MainActor [weak self] in
            var next = 1
            while true {
                try? await Task.sleep(until: start.advanced(by: .milliseconds(next * refresh.interval)), clock: .continuous)
                guard let self, self.run == token else { return }
                let elapsed = start.duration(to: .now).components
                let ms = Int(elapsed.seconds) * 1000 + Int(elapsed.attoseconds / 1_000_000_000_000_000)
                guard let step = refresh.step(at: ms) else { return self.cancel() }
                self.current = (refresh, step)
                self.place()
                next = step + 1
            }
        }
    }

    /// One step held still (the design preview's pictures; `play` steps through them).
    func show(step: Int, of refresh: ScanRefresh, ground: NSColor, line color: NSColor) {
        cover.color = ground
        line.color = color
        current = (refresh, step)
        isHidden = false
        place()
    }

    /// Nothing over the views under it any more.
    func cancel() {
        run += 1
        task?.cancel()
        task = nil
        current = nil
        isHidden = true
    }

    private func place() {
        guard let (refresh, step) = current else { return }
        let height = Double(bounds.height)
        let edge = CGFloat(refresh.edge(at: step, height: height))
        cover.frame = NSRect(x: 0, y: edge, width: bounds.width, height: max(0, bounds.height - edge))
        line.frame = NSRect(x: 0, y: CGFloat(refresh.line(at: step, height: height)), width: bounds.width,
                            height: CGFloat(ScanRefresh.lineThickness))
    }
}

/// A plain fill: the layer's colour on screen, drawn by hand only into a picture of the window (the design preview).
private final class FillView: NSView {
    var color: NSColor = .clear {
        didSet { if color != oldValue { needsDisplay = true } }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = color.cgColor }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        color.setFill()
        bounds.fill(using: .sourceOver)
    }
}

extension NSColor {
    /// The refresh's scan line: bright on a dark ground (the phone's white at 90 %), ink on the light Dispatch page.
    static let scanLine = NSColor(name: "AgentSwitchScanLine") { appearance in
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.9)
            : NSColor(srgbRed: 0x15 / 255.0, green: 0x14 / 255.0, blue: 0x13 / 255.0, alpha: 0.85)
    }
}
