import AgentSwitchKit
import SwiftUI

/// Ended and not opened yet (control-v0 §5): a small dot in the accent colour, at the trailing end so it is never
/// mistaken for the status dot. No new status colour.
struct UnreadDot: View {
    var body: some View {
        Circle()
            .fill(Color.accentColor)
            .frame(width: 8, height: 8)
            .accessibilityLabel("未读")
    }
}

/// "N 分钟无更新" for a running task that has gone quiet (control-v0 §5); the status word stays as it is. Checked again
/// every half minute while shown. `separated` puts the " · " of a status line in front.
struct StaleNote: View {
    let task: AgentTask
    var lastEventAt: Int64?
    var waiting = false
    var separated = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if let minutes = Staleness.minutes(task, lastEventAt: lastEventAt, now: context.date, waiting: waiting) {
                HStack(spacing: 6) {
                    if separated { Text("·").foregroundStyle(.tertiary) }
                    Text(Staleness.text(minutes: minutes)).foregroundStyle(.secondary)
                }
            }
        }
    }
}
