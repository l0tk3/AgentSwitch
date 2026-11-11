import AgentSwitchMacCore
import SwiftUI

/// What `TimelineView(.periodic(from:by:))` gives — its content with the moment of the step it is on, drawn again at
/// every step — by a clock of its own instead of a timeline (docs/ui-v0.md §7.4, 2026-11-10; user: 优化一下它的性能).
/// On a Mac a timeline is not asleep between its steps: whenever its window is drawn again within a quarter of a second
/// of the next one — an agent writing to its screen does that eleven times a second — SwiftUI lays the whole window
/// out at every frame of the display until the step comes. For a blink's 0.55 s that was nearly half the time, for a
/// clock's second a quarter of it. Here nothing is asked of SwiftUI but the step itself.
///
/// Steps count from `Motion.epoch`, as everything that steps does: what steps at one pace changes at one moment. For
/// what steps more often than a few times a second this is still too much (each step is the whole window's update):
/// that is a layer's to move (LayerMotion.swift).
struct Stepped<Content: View>: View {
    /// Seconds a step.
    let every: TimeInterval
    @ViewBuilder let content: (Date) -> Content
    /// The moment of the step it is on; none before its first one comes: then the moment it is drawn at.
    @State private var moment: Date?

    var body: some View {
        if Motion.timelines {
            TimelineView(.periodic(from: Motion.epoch, by: every)) { timeline in content(timeline.date) }
        } else {
            stepped
        }
    }

    private var stepped: some View {
        content(moment ?? Date())
            .task(id: every) {
                while !Task.isCancelled {
                    let now = Date()
                    try? await Task.sleep(for: .seconds(Motion.next(after: now, every: every).timeIntervalSince(now)))
                    if Task.isCancelled { return }
                    // The step the clock is on now: the one waited for, or a later one if this was kept waiting.
                    moment = Motion.moment(of: Motion.step(at: Date(), every: every), every: every)
                }
            }
    }
}

extension Motion {
    /// `-timelineMotion YES` (debug builds): the spinner, the blink and the clocks stepped by SwiftUI's timelines again,
    /// as they were before 2026-11-10 — for measuring what that costs beside what they cost now (`TerminalsCPUProbe`,
    /// `-perfProbe`). Never in a release build.
    static var timelines: Bool {
        #if DEBUG
        UserDefaults.standard.bool(forKey: "timelineMotion")
        #else
        false
        #endif
    }
}
