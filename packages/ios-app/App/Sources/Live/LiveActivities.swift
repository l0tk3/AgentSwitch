import ActivityKit
import AgentSwitchKit
import AgentSwitchLive
import Foundation
import os

/// The one summary Live Activity (assistant-v0 §4) — lock screen and Dynamic Island — kept by the app while it runs:
/// started when a task is in progress, updated when the summary changes, and once everything has ended it shows the
/// last conclusion for a minute and goes. No push (a free developer team cannot): once iOS suspends the app the activity
/// keeps its last state, its clocks keep counting, and after `staleAfter` it says to open the app.
///
/// Not on the main actor: ActivityKit's `Activity` values are not Sendable, so they are fetched and used in the same
/// nonisolated call and never handed across an isolation boundary. The one piece of state is behind a lock.
final class LiveActivities: @unchecked Sendable {
    private static let log = Logger(subsystem: "com.agentswitch.ios", category: "live")
    static let staleAfter: TimeInterval = 10 * 60
    static let lingerAfterEnd: TimeInterval = 60
    private static let enabledKey = "liveActivities"

    private let lock = NSLock()
    /// The state last handed to ActivityKit: an unchanged summary is not sent again.
    private var shownState: LiveState?
    private var shown: LiveState? {
        get { lock.lock(); defer { lock.unlock() }; return shownState }
        set { lock.lock(); shownState = newValue; lock.unlock() }
    }

    /// Settings › 提示与朗读 › 实时活动. Off ends what is showing.
    var enabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
            if !newValue { Task { await self.endAll(nil) } }
        }
    }

    /// Whether iOS lets this app show Live Activities (the user can turn them off per app).
    var allowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func sync(_ state: LiveState?, ended: LiveState.Ended?, macName: String) async {
        guard enabled else { return }
        guard allowed else { Self.log.notice("Live Activities are off for this app in iOS settings"); return }
        let live = { Activity<AgentActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale } }
        // One summary: a second one (left from an earlier launch) goes.
        for extra in live().dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
        let exists = !live().isEmpty
        guard let state else {
            if exists { await endAll(ended) }
            shown = nil
            return
        }
        guard state != shown || !exists else { return }
        shown = state
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.staleAfter))
        if let current = live().first {
            await current.update(content)
        } else {
            // Only allowed while the app is in the foreground; otherwise the next sync in the foreground starts it.
            do {
                let started = try Activity.request(attributes: AgentActivityAttributes(macName: macName), content: content, pushType: nil)
                Self.log.notice("Live Activity started: \(started.id, privacy: .public)")
            } catch {
                shown = nil   // try again on the next sync
                Self.log.error("Live Activity not started: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// The last conclusion for a minute (when there is one), then nothing.
    private func endAll(_ ended: LiveState.Ended?) async {
        for activity in Activity<AgentActivityAttributes>.activities {
            if let ended {
                let content = ActivityContent(state: LiveState.finished(ended), staleDate: nil)
                await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(Self.lingerAfterEnd)))
            } else {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
}
