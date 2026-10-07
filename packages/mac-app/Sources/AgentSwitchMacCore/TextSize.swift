import Foundation

/// The size of the conversation's text, as you set it (docs/ui-v0.md §8 “字号调节”): steps of one point around each
/// look's own sizes. It moves what is read and written in a conversation — messages, steps, code, the reply box — and
/// nothing else: lists, bars and buttons keep their sizes, and a terminal's screen has its own.
public enum TextSize {
    /// Where the step is kept (UserDefaults): 0 is each look's own size. (`conversationTextStep` was the first day's
    /// key, when the classic look's own size was a point larger: left behind, so the default is the default.)
    public static let key = "conversationTextSizeStep"
    /// Two points smaller to four larger.
    public static let steps = -2...4

    public static func clamp(_ step: Int) -> Int { min(max(step, steps.lowerBound), steps.upperBound) }

    /// A size `step` points from `base`.
    public static func size(_ base: Double, step: Int) -> Double { max(9, base + Double(clamp(step))) }

    /// What the setting says a step is: the size an answer is then set at — "14 pt", "13.5 pt".
    public static func label(prose base: Double, step: Int) -> String {
        let points = size(base, step: step)
        return points == points.rounded() ? "\(Int(points)) pt" : "\(points) pt"
    }
}
