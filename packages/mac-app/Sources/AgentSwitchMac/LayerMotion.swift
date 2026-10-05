import AgentSwitchMacCore
import AppKit
import QuartzCore
import SwiftUI

// What moves smoothly is moved by Core Animation (docs/ui-v0.md §7.4, 2026-10-04; user, of the classic look's ring
// stepped ten times a turn: 转圈的动画也一卡一卡的): the classic look's ring at work, and a light that breathes (the
// bars a put-away rail leaves on the window's edge). The window server moves the layer at the screen's own rate; the app lays nothing out and draws
// nothing again while it does. They move only while they are told to (seen, and not under Reduce Motion), and every one
// of a kind is at the same point of its motion: time counts from one moment, as Motion's steps do.

extension CAAnimation {
    /// Repeats for ever from where the clock is now in its period, so that every layer it moves keeps the same time.
    func keepingTime() -> Self {
        repeatCount = .infinity
        isRemovedOnCompletion = false
        timeOffset = CACurrentMediaTime().truncatingRemainder(dividingBy: duration)
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
