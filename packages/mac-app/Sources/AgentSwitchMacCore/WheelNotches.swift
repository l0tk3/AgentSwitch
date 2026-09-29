import Foundation

/// Scroll-wheel movement as the notches a terminal program takes (docs/terminal-v0.md, the Mac window). The web view
/// in the Mac window hands its page no scroll events, so the window turns them into notches itself, as iTerm does: a
/// wheel's click is at least one notch (macOS reports a slow click as a tenth of a line) and a fast spin a notch a line;
/// a trackpad or Magic Mouse gives one notch as a movement begins, then one per two lines of travel (its momentum
/// included). Up — back through what the program showed — is positive.
public struct WheelNotches: Sendable {
    private var travel: Double = 0

    public init() {}

    /// `deltaY`: NSEvent's scrollingDeltaY (lines for a wheel, points for a precise device); `began`: the event starts a
    /// precise movement (phase began); `lineHeight`: a line of the screen, in points.
    public mutating func add(deltaY: Double, precise: Bool, began: Bool, lineHeight: Double) -> Int {
        guard deltaY != 0 else { return 0 }
        let sign = deltaY > 0 ? 1 : -1
        guard precise else {
            travel = 0
            return sign * max(1, min(10, Int(abs(deltaY).rounded())))
        }
        if began {
            travel = 0
            return sign
        }
        if travel != 0 && (travel > 0) != (deltaY > 0) { travel = 0 }   // turned around mid-movement
        travel += deltaY
        let step = 2 * max(8, lineHeight)
        let notches = Int(travel / step)
        travel -= Double(notches) * step
        return notches
    }
}
