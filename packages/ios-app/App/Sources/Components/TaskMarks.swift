import AgentSwitchKit
import SwiftUI

/// Ended and not opened yet (control-v0 §5): a small signal-coloured square at the trailing end, so it is never
/// mistaken for the status mark. No new status colour.
struct UnreadDot: View {
    var body: some View {
        Rectangle()
            .fill(Theme.signal)
            .frame(width: 6, height: 6)
            .accessibilityLabel("未读")
    }
}

/// "N 分钟无更新" for a running task that has gone quiet (control-v0 §5); the status word stays as it is. Checked again
/// every half minute while shown, only for a task that can go quiet and while the app is in front (ui-v0 §7.4,
/// 2026-10-03). `separated` puts the " · " of a status line in front.
struct StaleNote: View {
    let task: AgentTask
    var lastEventAt: Int64?
    var waiting = false
    var separated = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if (task.status == .running || task.status == .routing) && !waiting && scenePhase == .active {
            TimelineView(.periodic(from: .now, by: 30)) { context in note(now: context.date) }
        } else {
            note(now: Date())
        }
    }

    @ViewBuilder private func note(now: Date) -> some View {
        if let minutes = Staleness.minutes(task, lastEventAt: lastEventAt, now: now, waiting: waiting) {
            HStack(spacing: 6) {
                if separated { Text("·").foregroundStyle(.tertiary) }
                Text(Staleness.text(minutes: minutes)).foregroundStyle(.secondary)
            }
        }
    }
}
