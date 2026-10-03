import AgentSwitchKit
import SwiftUI
import UIKit

/// A tab's live picture (docs/browser-v0.md §1): the newest JPEG frame where the layout puts it, and what the agent
/// just did outlined over it — a cyan box around the element with a label (`codex · click "Merge"`), as the demo page
/// draws it. Frames go straight to the image view, never through SwiftUI, already decoded (BrowserFrameDecoder).
final class BrowserScreenView: UIView {
    let imageView = UIImageView()
    private let outline = UIView()
    private let label = InsetLabel()

    /// Where the picture goes and how the zoom moves it.
    var layout: BrowserLayout? { didSet { if layout != oldValue { setNeedsLayout() } } }
    /// The agent's last action: its box on the page (CSS pixels), the frame's pixels per CSS pixel, the label.
    var action: (box: BrowserBox, frameScale: Double, said: String)? { didSet { setNeedsLayout() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        imageView.contentMode = .scaleToFill
        imageView.layer.minificationFilter = .trilinear
        addSubview(imageView)
        let cyan = UIColor(Theme.busy)
        outline.layer.borderColor = cyan.cgColor
        outline.layer.borderWidth = 2
        outline.isUserInteractionEnabled = false
        label.backgroundColor = cyan
        label.textColor = .black
        label.font = .monospacedSystemFont(ofSize: 10.5, weight: .semibold)
        label.isUserInteractionEnabled = false
        addSubview(outline)
        addSubview(label)
        isAccessibilityElement = true
        accessibilityLabel = "页面画面"
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: BrowserScreenView, _: UITraitCollection) in view.recolor() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ image: UIImage) {
        imageView.image = image
    }

    /// The outline's cyan follows light and dark (a layer's colour does not on its own).
    private func recolor() {
        let cyan = UIColor(Theme.busy).resolvedColor(with: traitCollection)
        outline.layer.borderColor = cyan.cgColor
        label.backgroundColor = cyan
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let layout, layout.picture.width > 0 else {
            imageView.isHidden = true
            outline.isHidden = true
            label.isHidden = true
            return
        }
        imageView.isHidden = imageView.image == nil
        let origin = layout.zoom.apply(layout.picture.origin)
        imageView.frame = CGRect(x: origin.x, y: origin.y, width: layout.picture.width * layout.zoom.scale, height: layout.picture.height * layout.zoom.scale)
        guard let action, imageView.image != nil else {
            outline.isHidden = true
            label.isHidden = true
            return
        }
        // outline-offset 3 px, the label sitting on the box's top-left corner (the demo page's .hit)
        let rect = layout.screenRect(ofPage: action.box, frameScale: action.frameScale).insetBy(dx: -3, dy: -3)
        outline.frame = rect
        outline.isHidden = false
        label.text = action.said
        let size = label.sizeThatFits(CGSize(width: bounds.width - 8, height: 20))
        let width = min(size.width, bounds.width - 8)
        let x = min(max(rect.minX - 2, 4), bounds.width - width - 4)
        let y = rect.minY - size.height >= 0 ? rect.minY - size.height : rect.maxY
        label.frame = CGRect(x: x, y: y, width: width, height: size.height)
        label.isHidden = false
    }
}

/// A label with the demo page's padding (1 × 6).
final class InsetLabel: UILabel {
    private let inset = UIEdgeInsets(top: 1, left: 6, bottom: 1, right: 6)

    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: inset)) }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let inner = super.sizeThatFits(CGSize(width: size.width - inset.left - inset.right, height: size.height))
        return CGSize(width: inner.width + inset.left + inset.right, height: inner.height + inset.top + inset.bottom)
    }
}

/// What a finger does on the picture (browser-v0 §1 操作): a tap clicks, a long press is the right button, a drag
/// scrolls the page (a flick carries on a little), two fingers zoom and move the picture on the phone only.
struct BrowserScreen: UIViewRepresentable {
    let view: BrowserScreenView
    let layout: BrowserLayout?
    var onTap: (CGPoint) -> Void
    var onLongPress: (CGPoint) -> Void
    /// A drag's movement since the last call, and where the finger is.
    var onDrag: (CGSize, CGPoint) -> Void
    /// The zoom by a pinch (relative to the last call) about a point, or moved by two fingers.
    var onPinch: (CGFloat, CGPoint) -> Void
    var onPan: (CGSize) -> Void

    func makeUIView(context: Context) -> BrowserScreenView {
        let c = context.coordinator
        let tap = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tapped(_:)))
        let long = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.held(_:)))
        long.minimumPressDuration = 0.5
        let drag = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.dragged(_:)))
        drag.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinched(_:)))
        let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.panned(_:)))
        pan.minimumNumberOfTouches = 2
        tap.require(toFail: long)
        for g in [tap, long, drag, pinch, pan] as [UIGestureRecognizer] {
            g.delegate = c
            view.addGestureRecognizer(g)
        }
        c.pinch = pinch
        c.pan = pan
        return view
    }

    func updateUIView(_ uiView: BrowserScreenView, context: Context) {
        uiView.layout = layout
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: BrowserScreen
        weak var pinch: UIPinchGestureRecognizer?
        weak var pan: UIPanGestureRecognizer?
        private var coast: Task<Void, Never>?

        init(parent: BrowserScreen) { self.parent = parent }

        /// Pinch and the two-finger move go together; nothing else does.
        nonisolated func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            MainActor.assumeIsolated {
                let pair: [UIGestureRecognizer?] = [pinch, pan]
                return pair.contains { $0 === g } && pair.contains { $0 === other }
            }
        }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            coast?.cancel()
            parent.onTap(g.location(in: g.view))
        }

        @objc func held(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            parent.onLongPress(g.location(in: g.view))
        }

        @objc func dragged(_ g: UIPanGestureRecognizer) {
            switch g.state {
            case .began:
                coast?.cancel()
            case .changed:
                let t = g.translation(in: g.view)
                g.setTranslation(.zero, in: g.view)
                parent.onDrag(CGSize(width: t.x, height: t.y), g.location(in: g.view))
            case .ended:
                // A flick carries on, slowing: a few more turns, smaller each time.
                let v = g.velocity(in: g.view)
                guard hypot(v.x, v.y) > 300 else { return }
                let at = g.location(in: g.view)
                let onDrag = parent.onDrag
                coast = Task { @MainActor in
                    var step = CGSize(width: v.x * 0.05, height: v.y * 0.05)
                    for _ in 0..<8 where !Task.isCancelled {
                        onDrag(step, at)
                        step = CGSize(width: step.width * 0.7, height: step.height * 0.7)
                        try? await Task.sleep(for: .milliseconds(50))
                    }
                }
            default:
                break
            }
        }

        @objc func pinched(_ g: UIPinchGestureRecognizer) {
            guard g.state == .changed || g.state == .began else { return }
            parent.onPinch(g.scale, g.location(in: g.view))
            g.scale = 1
        }

        @objc func panned(_ g: UIPanGestureRecognizer) {
            guard g.state == .changed else { return }
            let t = g.translation(in: g.view)
            g.setTranslation(.zero, in: g.view)
            parent.onPan(CGSize(width: t.x, height: t.y))
        }
    }
}
