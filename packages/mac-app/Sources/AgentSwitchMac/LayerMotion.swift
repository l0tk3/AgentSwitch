import AgentSwitchMacCore
import AppKit
import QuartzCore
import SwiftUI

// What moves smoothly is moved by Core Animation (docs/ui-v0.md §7.4, 2026-10-04; user, of the classic look's ring
// stepped ten times a turn: 转圈的动画也一卡一卡的): the classic look's ring at work, and a light that breathes (the
// bars a put-away rail leaves on the window's edge). The window server moves the layer at the screen's own rate; the app lays nothing out and draws
// nothing again while it does. They move only while they are told to (seen, and not under Reduce Motion), and every one
// of a kind is at the same point of its motion: time counts from one moment, as Motion's steps do.
//
// So is what moves in steps and is on screen for as long as an agent works or waits (2026-11-10, user: 优化一下它的性能):
// the pixel look's spinner (`SteppedGlyphView`) and its blink (`BlinkView`), and the classic look's waiting ring
// (`WaitingRingView`). A SwiftUI timeline whose next step is less than a quarter of a second away has its whole window
// laid out again at every frame of the display, not at every step — 240 times a second for the spinner's eleven steps,
// on a 120 Hz screen — and an animation SwiftUI eases does the same for as long as it runs: the installed app stood at
// a third of a core while one agent worked, nearly all of it this. Even a step that is only a step is the whole
// window's update, some ten milliseconds of it. A layer's picture changed by the render server costs the app nothing.

extension CAAnimation {
    /// Repeats for ever from where the clock is now in its period, so that every layer it moves keeps the same time.
    func keepingTime() -> Self {
        repeatCount = .infinity
        isRemovedOnCompletion = false
        timeOffset = CACurrentMediaTime().truncatingRemainder(dividingBy: duration)
        return self
    }

    /// Repeats for ever from where `Motion`'s own clock is in its period now: what moves in steps is on the step
    /// `Motion.step` says, in every layer, and so on the one a still picture of it shows.
    func keepingStep() -> Self {
        repeatCount = .infinity
        isRemovedOnCompletion = false
        timeOffset = Date().timeIntervalSince(Motion.epoch).truncatingRemainder(dividingBy: duration)
        return self
    }
}

/// The ring: seven tenths of a circle, round ends, turning clockwise once in `LayerMotion.turn`.
final class TurningRingView: NSView {
    private let ring = CAShapeLayer()
    var color: NSColor = .controlAccentColor { didSet { paint() } }
    var lineWidth: CGFloat = 1.5 { didSet { if lineWidth != oldValue { needsLayout = true } } }
    var turning = false { didSet { if turning != oldValue { move() } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        ring.fillColor = nil
        ring.lineCap = .round
        ring.strokeStart = 0.1
        ring.strokeEnd = 0.8
        // Placed and painted at once: a layer of our own would ease into every change.
        ring.actions = ["position": NSNull(), "bounds": NSNull(), "path": NSNull(), "strokeColor": NSNull(), "lineWidth": NSNull()]
        layer?.addSublayer(ring)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        let side = min(bounds.width, bounds.height)
        ring.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
        ring.lineWidth = lineWidth
        ring.path = CGPath(ellipseIn: ring.bounds, transform: nil)
        paint()
        move()
    }

    /// A layer that leaves its window loses what moved it.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        move()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paint()
    }

    private func paint() {
        effectiveAppearance.performAsCurrentDrawingAppearance { ring.strokeColor = color.cgColor }
    }

    /// Turning or still, as told; asked again whenever the view is drawn again (an animation may have been dropped).
    func move() {
        guard turning, window != nil else { return ring.removeAnimation(forKey: Self.key) }
        guard ring.animation(forKey: Self.key) == nil else { return }
        let turn = CABasicAnimation(keyPath: "transform.rotation.z")
        turn.fromValue = 0
        // The view's own coordinates run upwards: a negative angle is clockwise.
        turn.toValue = -2 * Double.pi
        turn.duration = LayerMotion.turn
        ring.add(turn.keepingTime(), forKey: Self.key)
    }

    private static let key = "turn"
}

/// A light: a bar in one colour, round-ended or square, that breathes — its strength falling and rising again — or is
/// still.
final class BreathingLightView: NSView {
    var color: NSColor = .white { didSet { paint() } }
    var radius: CGFloat = 0 { didSet { layer?.cornerRadius = radius } }
    /// The corners rounded: all of them, or those away from the edge it stands against.
    var corners: CACornerMask = [.layerMinXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMinYCorner, .layerMaxXMaxYCorner] {
        didSet { layer?.maskedCorners = corners }
    }
    var breath: LayerMotion.Breath? { didSet { if breath != oldValue { move(afresh: true) } } }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        move()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paint()
    }

    private func paint() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = color.cgColor }
    }

    func move(afresh: Bool = false) {
        guard let layer else { return }
        if afresh { layer.removeAnimation(forKey: Self.key) }
        guard let breath, window != nil else { return layer.removeAnimation(forKey: Self.key) }
        guard layer.animation(forKey: Self.key) == nil else { return }
        let breathe = CAKeyframeAnimation(keyPath: "opacity")
        breathe.values = breath.strengths
        breathe.duration = breath.period
        if breath.stepped {
            breathe.calculationMode = .discrete
        } else {
            breathe.timingFunctions = breath.strengths.dropFirst().map { _ in CAMediaTimingFunction(name: .easeInEaseOut) }
        }
        layer.add(breathe.keepingTime(), forKey: Self.key)
    }

    private static let key = "breathe"
}

/// A picture that changes in steps: each of its frames drawn once, and the layer's picture changed from one to the
/// next by Core Animation — a frame held for `step` seconds, nothing eased. Still, it shows the frame the clock is on
/// (`Motion.step`), which is also what a picture of the window shows (`cacheDisplay` draws views, not their layers).
/// What the frames are is a subclass's: the spinner's glyphs (`SteppedGlyphView`), a blink's two strengths
/// (`BlinkView`).
class SteppedPictureView: NSView {
    /// Seconds a frame.
    var step: CFTimeInterval = Motion.spinner { didSet { if step != oldValue { move(afresh: true) } } }
    var stepping = false { didSet { if stepping != oldValue { move(afresh: true) } } }
    /// The frame it stands on while it is still; none: the one the clock is on.
    var held: Int? { didSet { if held != oldValue { show() } } }

    /// How many frames it has.
    var count: Int { 0 }
    /// One frame, drawn into the current context: from the top left, in points, the view's appearance the current one.
    func draw(frame: Int, size: CGSize) {}

    private let picture = CALayer()
    private var frames: [CGImage] = []
    /// What the frames were drawn for: the view's size, the screen's pixels to a point, the appearance.
    private var drawnFor: Drawn?
    private struct Drawn: Equatable {
        var size: CGSize
        var scale: CGFloat
        var dark: Bool
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        // Its picture is put there, never eased to.
        picture.actions = ["contents": NSNull(), "position": NSNull(), "bounds": NSNull(), "contentsScale": NSNull()]
        layer?.addSublayer(picture)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    // The layer shows the picture; `draw(_:)` is only for a picture of the window.
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {}

    override func draw(_ dirtyRect: NSRect) {
        guard let image = frames.indices.contains(now) ? frames[now] : nil else { return }
        NSImage(cgImage: image, size: picture.frame.size).draw(in: picture.frame)
    }

    override func layout() {
        super.layout()
        redraw()
    }

    /// A layer that leaves its window loses what moved it; another window may have other pixels to a point.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        redraw()
        move(afresh: true)
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        redraw()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        redraw()
    }

    /// What it draws has changed: its frames are drawn again.
    func stale() {
        drawnFor = nil
        needsLayout = true
    }

    /// The frame the clock is on, or the one it is held on.
    private var now: Int {
        guard !frames.isEmpty else { return 0 }
        return (held ?? Motion.step(at: Date(), every: step)) % frames.count
    }

    /// The frames drawn again, if what they were drawn for has changed.
    private func redraw() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        let wanted = Drawn(size: bounds.size, scale: scale, dark: effectiveAppearance.isDark)
        guard wanted != drawnFor else { return move() }
        drawnFor = wanted
        frames = bounds.isEmpty ? [] : (0..<count).compactMap { picture(of: $0, size: bounds.size, scale: scale) }
        // At the view's top left, a pixel of the picture on a pixel of the screen.
        let size = frames.first.map { CGSize(width: CGFloat($0.width) / scale, height: CGFloat($0.height) / scale) } ?? .zero
        picture.contentsScale = scale
        picture.frame = CGRect(x: 0, y: bounds.height - size.height, width: size.width, height: size.height)
        show()
        move(afresh: true)
    }

    private func picture(of frame: Int, size: CGSize, scale: CGFloat) -> CGImage? {
        let wide = Int((size.width * scale).rounded(.up)), high = Int((size.height * scale).rounded(.up))
        guard wide > 0, high > 0, let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: wide, height: high, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.translateBy(x: 0, y: CGFloat(high))
        context.scaleBy(x: scale, y: -scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        effectiveAppearance.performAsCurrentDrawingAppearance { draw(frame: frame, size: size) }
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }

    /// The picture it rests on: what shows while nothing moves it, and under what does.
    private func show() {
        picture.contents = frames.indices.contains(now) ? frames[now] : nil
        if !stepping { needsDisplay = true }
    }

    /// Stepping or still, as told; asked again whenever the view is laid out (an animation may have been dropped).
    func move(afresh: Bool = false) {
        if afresh { picture.removeAnimation(forKey: Self.key) }
        guard stepping, window != nil, frames.count > 1, step > 0 else { return picture.removeAnimation(forKey: Self.key) }
        guard picture.animation(forKey: Self.key) == nil else { return }
        let steps = CAKeyframeAnimation(keyPath: "contents")
        steps.values = frames
        // Discrete: one more time than frames, the last the turn's end.
        steps.keyTimes = (0...frames.count).map { NSNumber(value: Double($0) / Double(frames.count)) }
        steps.calculationMode = .discrete
        steps.duration = step * Double(frames.count)
        picture.add(steps.keepingStep(), forKey: Self.key)
    }

    private static let key = "step"
}

/// A glyph that changes in steps — the pixel look's spinner `⠋⠙⠹…`: each frame the glyph as a line of text draws it,
/// in the view's font and colour.
final class SteppedGlyphView: SteppedPictureView {
    var glyphs: [String] = [] { didSet { if glyphs != oldValue { stale() } } }
    var font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) { didSet { if font != oldValue { stale() } } }
    var color = NSColor.labelColor { didSet { if color != oldValue { stale() } } }

    override var count: Int { glyphs.count }

    override func draw(frame: Int, size: CGSize) {
        NSAttributedString(string: glyphs[frame], attributes: [.font: font, .foregroundColor: color])
            .draw(with: CGRect(origin: .zero, size: size), options: [.usesLineFragmentOrigin])
    }
}

/// What blinks in the pixel look, waiting for you: one colour over the whole view at its full strength, then at a
/// quarter of it, a step of the blink each. With `edge`, the status square's key (docs/ui-v0.md §9): a light edge
/// above and left, a dark one below and right, as `GraphicsContext.keyEdges` draws them. Without, a light for words to
/// be cut from (`Blinking`).
final class BlinkView: SteppedPictureView {
    var color = NSColor.systemOrange { didSet { if color != oldValue { stale() } } }
    var edge: CGFloat? { didSet { if edge != oldValue { stale() } } }

    /// The dim step's strength.
    static let dim: CGFloat = 0.25

    override var count: Int { 2 }

    override func draw(frame: Int, size: CGSize) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.setAlpha(frame % 2 == 1 ? Self.dim : 1)
        context.beginTransparencyLayer(auxiliaryInfo: nil)
        color.setFill()
        CGRect(origin: .zero, size: size).fill()
        if let edge {
            let side = size.width
            NSColor.white.withAlphaComponent(0.45).setFill()
            CGRect(x: 0, y: 0, width: side - edge, height: edge).fill(using: .sourceOver)
            CGRect(x: 0, y: edge, width: edge, height: side - 2 * edge).fill(using: .sourceOver)
            NSColor.black.withAlphaComponent(0.35).setFill()
            CGRect(x: edge, y: side - edge, width: side - edge, height: edge).fill(using: .sourceOver)
            CGRect(x: side - edge, y: edge, width: edge, height: side - 2 * edge).fill(using: .sourceOver)
        }
        context.endTransparencyLayer()
    }
}

/// The classic look's waiting ring (`ClassicWaitingDot`): a circle around a dot that breathes — out and fading over one
/// step of the blink, in again over the next, eased. At rest it stands in, half strong: what a picture of the window
/// shows too.
final class WaitingRingView: NSView {
    var color: NSColor = .systemOrange { didSet { paint() } }
    /// The dot's side: the ring is drawn round it, in the middle of this view (which is larger: the ring goes out).
    var side: CGFloat = 8 { didSet { if side != oldValue { needsLayout = true } } }
    var breathing = false { didSet { if breathing != oldValue { move(afresh: true) } } }
    private let ring = CAShapeLayer()

    /// The ring's two ends: in, and out (gone).
    static let scales: (in: CGFloat, out: CGFloat) = (1.3, 1.9)
    static let strengths: (in: Float, out: Float) = (0.5, 0)
    static func lineWidth(side: CGFloat) -> CGFloat { max(1, side * 0.16) }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        ring.fillColor = nil
        ring.actions = ["position": NSNull(), "bounds": NSNull(), "path": NSNull(), "strokeColor": NSNull(), "lineWidth": NSNull(), "transform": NSNull(), "opacity": NSNull()]
        layer?.addSublayer(ring)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    // The layer shows the ring; `draw(_:)` is only for a picture of the window.
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {}

    override func draw(_ dirtyRect: NSRect) {
        let across = side * Self.scales.in
        let path = NSBezierPath(ovalIn: CGRect(x: bounds.midX - across / 2, y: bounds.midY - across / 2, width: across, height: across))
        path.lineWidth = Self.lineWidth(side: side) * Self.scales.in
        color.withAlphaComponent(CGFloat(Self.strengths.in)).setStroke()
        path.stroke()
    }

    override func layout() {
        super.layout()
        ring.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
        ring.path = CGPath(ellipseIn: ring.bounds, transform: nil)
        ring.lineWidth = Self.lineWidth(side: side)
        ring.transform = CATransform3DMakeScale(Self.scales.in, Self.scales.in, 1)
        ring.opacity = Self.strengths.in
        paint()
        move()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        move(afresh: true)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paint()
    }

    private func paint() {
        effectiveAppearance.performAsCurrentDrawingAppearance { ring.strokeColor = color.cgColor }
    }

    /// Breathing or at rest, as told; asked again whenever the view is laid out (an animation may have been dropped).
    func move(afresh: Bool = false) {
        if afresh { ring.removeAnimation(forKey: Self.key) }
        guard breathing, window != nil else { return ring.removeAnimation(forKey: Self.key) }
        guard ring.animation(forKey: Self.key) == nil else { return }
        // An even step of the blink brings it in, an odd one takes it out: from out, in, and out again.
        let scale = CAKeyframeAnimation(keyPath: "transform.scale")
        scale.values = [Self.scales.out, Self.scales.in, Self.scales.out]
        let strength = CAKeyframeAnimation(keyPath: "opacity")
        strength.values = [Self.strengths.out, Self.strengths.in, Self.strengths.out]
        let breath = CAAnimationGroup()
        for part in [scale, strength] {
            part.keyTimes = [0, 0.5, 1]
            part.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeInEaseOut)]
            part.duration = Motion.blink * 2
        }
        breath.animations = [scale, strength]
        breath.duration = Motion.blink * 2
        ring.add(breath.keepingStep(), forKey: Self.key)
    }

    private static let key = "breathe"
}

enum LayerMotion {
    /// One turn of the ring, in seconds.
    static let turn: CFTimeInterval = 0.9

    /// How a light breathes: its strengths in turn over `period` seconds, eased from one to the next or, `stepped`,
    /// held and changed at once (the pixel look: steps, no easing).
    struct Breath: Equatable {
        var period: CFTimeInterval
        var strengths: [Double]
        var stepped: Bool

        /// The light of a page at work or waiting for you (`RailBar`), in the look.
        static func of(_ pace: RailBar.Pace, classic: Bool) -> Breath? {
            switch pace {
            case .still: nil
            // Slow enough to be a breath and not a blink (a sleeping Mac's light took five seconds over one).
            case .slow: classic ? Breath(period: 3.2, strengths: [1, 0.3, 1], stepped: false)
                                : Breath(period: 3.2, strengths: [1, 0.65, 0.3, 0.65], stepped: true)
            // What waits for you: twice as quick; in the pixel look the blink's two steps over 1.1 s, as everywhere.
            case .quick: classic ? Breath(period: 1.6, strengths: [1, 0.3, 1], stepped: false)
                                 : Breath(period: Motion.blink * 2, strengths: [1, 0.25], stepped: true)
            }
        }
    }
}

/// The classic look's ring at work, in SwiftUI: `turning` while it is seen and motion is not reduced.
struct TurningRing: NSViewRepresentable {
    var color: NSColor
    var lineWidth: CGFloat = 1.5
    var turning = true

    func makeNSView(context: Context) -> TurningRingView { TurningRingView() }

    func updateNSView(_ view: TurningRingView, context: Context) {
        view.color = color
        view.lineWidth = lineWidth
        view.turning = turning
        view.move()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: TurningRingView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}

/// A glyph changing in steps, in SwiftUI: laid over the same glyph as text (hidden), whose place and size it takes.
/// The appearance is the one SwiftUI draws in here (a page may be dark whatever the system says).
struct SteppedGlyph: NSViewRepresentable {
    var glyphs: [String]
    /// The type's size, in the monospaced system font.
    var size: CGFloat
    var color: NSColor
    var step: TimeInterval
    /// The frame it stands on, still; none: stepping.
    var held: Int?

    func makeNSView(context: Context) -> SteppedGlyphView { SteppedGlyphView() }

    func updateNSView(_ view: SteppedGlyphView, context: Context) {
        let dark = context.environment.colorScheme == .dark
        if view.appearance?.isDark != dark { view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        view.glyphs = glyphs
        view.font = .monospacedSystemFont(ofSize: size, weight: .regular)
        view.color = color
        view.step = step
        view.held = held
        view.stepping = held == nil
        view.move()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: SteppedGlyphView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}

/// What blinks in the pixel look, in SwiftUI: `color` over the whole of its frame, full and then dim; with `edge` the
/// status square's key. `held`: that step, still.
struct Blink: NSViewRepresentable {
    var color: NSColor
    var edge: CGFloat?
    var held: Int?

    func makeNSView(context: Context) -> BlinkView { BlinkView() }

    func updateNSView(_ view: BlinkView, context: Context) {
        let dark = context.environment.colorScheme == .dark
        if view.appearance?.isDark != dark { view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        view.color = color
        view.edge = edge
        view.step = Motion.blink
        view.held = held
        view.stepping = held == nil
        view.move()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: BlinkView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}

/// The classic look's waiting ring in SwiftUI, round a dot `side` across: breathing while it is seen and motion is not
/// reduced. Give it more room than the dot (the ring goes out to nearly twice the dot's size).
struct WaitingRing: NSViewRepresentable {
    var color: NSColor
    var side: CGFloat
    var breathing = true

    func makeNSView(context: Context) -> WaitingRingView { WaitingRingView() }

    func updateNSView(_ view: WaitingRingView, context: Context) {
        let dark = context.environment.colorScheme == .dark
        if view.appearance?.isDark != dark { view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua) }
        view.color = color
        view.side = side
        view.breathing = breathing
        view.move()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: WaitingRingView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}

/// A light in SwiftUI: breathing as `breath` says, still without one.
struct BreathingLight: NSViewRepresentable {
    var color: NSColor
    var radius: CGFloat = 0
    var corners: CACornerMask = [.layerMinXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMinYCorner, .layerMaxXMaxYCorner]
    var breath: LayerMotion.Breath?

    func makeNSView(context: Context) -> BreathingLightView { BreathingLightView() }

    func updateNSView(_ view: BreathingLightView, context: Context) {
        view.color = color
        view.radius = radius
        view.corners = corners
        view.breath = breath
        view.move()
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: BreathingLightView, context: Context) -> CGSize? { proposal.replacingUnspecifiedDimensions() }
}
