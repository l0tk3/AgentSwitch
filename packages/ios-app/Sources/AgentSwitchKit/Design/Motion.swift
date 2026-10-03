import Foundation

/// When what moves on screen moves (docs/ui-v0.md §7.4, 2026-10-03; user: 是不是还得优化一下 cpu/gpu 占用): the spinner,
/// the blinking square, the mark's running block, the caret — only while the app is in front (scene phase active) and
/// they have something to show. While shown they look and step as before; steps count from one epoch, so every mark on
/// screen steps at the same moment (one redraw for all of them, not one each). As the Mac's `Motion`.
public enum Motion {
    /// The spinner `⠋⠙⠹…`: a frame every 0.09 s.
    public static let spinner: TimeInterval = 0.09
    /// What waits for you blinks in two steps over 1.1 s.
    public static let blink: TimeInterval = 0.55
    /// The block running along the mark's lit lane.
    public static let run: TimeInterval = 0.14
    /// A prompt's block caret: 1 s a cycle, in two steps.
    public static let caret: TimeInterval = 0.5
    /// The moment every step counts from.
    public static let epoch = Date(timeIntervalSinceReferenceDate: 0)

    /// The step a motion repeating every `interval` is on at `date`. A step's own moment counts as that step (a timeline
    /// entry falls exactly on it; the division must not land a hair short).
    public static func step(at date: Date, every interval: TimeInterval) -> Int {
        Int((date.timeIntervalSince(epoch) / interval + 1e-6).rounded(.down))
    }
}

extension PixelArt.MarkState {
    /// How often the mark changes: the block runs while busy, the lane's end blinks while something waits; idle, off and
    /// error are still pictures.
    public var motionInterval: TimeInterval? {
        switch self {
        case .busy: Motion.run
        case .waiting: Motion.blink
        case .idle, .error, .off: nil
        }
    }
}
