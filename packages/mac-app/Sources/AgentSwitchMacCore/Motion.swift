import Foundation

/// When what moves on screen moves (docs/ui-v0.md §7.4, 2026-10-03; user: 是不是还得优化一下 cpu/gpu 占用): the spinner,
/// the blinking square, the mark's running block, the clocks — only while they are seen, and only when they have
/// something to show. While seen they look and step as before; steps count from one epoch, so every mark on screen
/// steps at the same moment (one redraw for all of them, not one each).
public enum Motion {
    /// The spinner `⠋⠙⠹…`: a frame every 0.09 s.
    public static let spinner: TimeInterval = 0.09
    /// What waits for you blinks in two steps over 1.1 s.
    public static let blink: TimeInterval = 0.55
    /// The block running along the mark's lit lane, the live card's spinners.
    public static let run: TimeInterval = 0.14
    /// The moment every step counts from.
    public static let epoch = Date(timeIntervalSinceReferenceDate: 0)

    /// The step a motion repeating every `interval` is on at `date`. A step's own moment counts as that step (a timeline
    /// entry falls exactly on it; the division must not land a hair short).
    public static func step(at date: Date, every interval: TimeInterval) -> Int {
        Int((date.timeIntervalSince(epoch) / interval + 1e-6).rounded(.down))
    }

    /// Where a view is, as AppKit says it: it is seen while its window is on screen — ordered in, not minimised, not
    /// covered entirely by other windows (which is also what an app hidden, another Space or a sleeping display give) —
    /// and neither it nor a view around it is hidden (another page of the main window, a closed panel's content).
    public struct Place: Equatable, Sendable {
        public var inWindow: Bool
        public var windowVisible: Bool
        public var occluded: Bool
        public var miniaturized: Bool
        public var hidden: Bool

        public init(inWindow: Bool, windowVisible: Bool, occluded: Bool, miniaturized: Bool, hidden: Bool) {
            self.inWindow = inWindow
            self.windowVisible = windowVisible
            self.occluded = occluded
            self.miniaturized = miniaturized
            self.hidden = hidden
        }

        public var seen: Bool { inWindow && windowVisible && !occluded && !miniaturized && !hidden }
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

/// Clocks that count whole seconds from their own moment — `0:42` since a row started, `Expires in 4:59` until a code
/// expires: the moments one of them shows a new second, so a view redraws then and not in between.
public enum ClockTicks {
    /// A hair after the second turns: the clock's own arithmetic then reads the new second, never the old one.
    public static let lead: TimeInterval = 0.001

    /// The first moment after `date` at which a clock counting from one of `origins` turns; nil without clocks.
    public static func next(after date: Date, origins: [Date]) -> Date? {
        origins.map { origin -> Date in
            let elapsed = date.timeIntervalSince(origin) - lead
            var turn = origin.addingTimeInterval(elapsed.rounded(.down) + 1 + lead)
            // A date that is itself a turn, give or take the arithmetic: always move on.
            if turn.timeIntervalSince(date) < lead { turn = turn.addingTimeInterval(1) }
            return turn
        }.min()
    }

    /// `start` (to draw at once), then every moment one of the clocks turns, up to `until` (a countdown that has run out
    /// stops there: the turn that says so is the last).
    public static func moments(from start: Date, origins: [Date], until: Date? = nil) -> AnyIterator<Date> {
        var next: Date? = start
        return AnyIterator {
            guard let current = next else { return nil }
            next = ClockTicks.next(after: current, origins: origins)
            if let until, let upcoming = next, upcoming > until.addingTimeInterval(lead * 2) { next = nil }
            return current
        }
    }
}
