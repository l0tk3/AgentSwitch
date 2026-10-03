import Foundation

/// The terminal screen's output on its way into SwiftTerm (docs/app-v0.md §4, 2026-10-03). While the screen is seen,
/// each piece goes in as it comes (SwiftTerm itself draws at most once a frame). While it is not — its window covered,
/// minimised or hidden, another page shown — pieces wait and go in together: `holdFor` after the first one waiting at
/// the latest (a program that asks the terminal something still hears back soon), as soon as `holdBytes` wait, before
/// anything else the stream says (a size, a snapshot, the end: the caller flushes first), and at once when the screen is
/// seen again. Nothing is dropped or reordered except by `drop()` (another terminal, a snapshot that replaces it all).
public struct TerminalFeedBatcher: Sendable {
    public static let holdFor: Duration = .milliseconds(250)
    public static let holdBytes = 64 * 1024

    /// What to do with a piece of output.
    public enum Step: Equatable, Sendable {
        /// Into the terminal now: what waited and then the piece, in order.
        case feed(String)
        /// The first piece waiting: flush at this moment at the latest.
        case wait(until: ContinuousClock.Instant)
        /// Waiting with what already waits (its flush is already due).
        case waiting
    }

    private var held: [String] = []
    private var heldBytes = 0

    public init() {}

    /// Output is waiting.
    public var holding: Bool { !held.isEmpty }

    public mutating func receive(_ text: String, seen: Bool, at now: ContinuousClock.Instant) -> Step {
        guard !seen else { return .feed((flush() ?? "") + text) }
        let first = held.isEmpty
        held.append(text)
        heldBytes += text.utf8.count
        if heldBytes >= Self.holdBytes { return .feed(flush() ?? "") }
        return first ? .wait(until: now.advanced(by: Self.holdFor)) : .waiting
    }

    /// Everything waiting, in order; nil when nothing waits.
    public mutating func flush() -> String? {
        guard !held.isEmpty else { return nil }
        defer {
            held.removeAll(keepingCapacity: true)
            heldBytes = 0
        }
        return held.count == 1 ? held[0] : held.joined()
    }

    /// Forgets what waits (it no longer belongs on the screen).
    public mutating func drop() {
        held.removeAll()
        heldBytes = 0
    }
}
