import ActivityKit
import AgentSwitchLive
import AgentSwitchLiveUI
import SwiftUI
import WidgetKit

/// The widget extension: only the Live Activity (assistant-v0 §4). It gets its state from the app (LiveState) and
/// never talks to the Mac itself. The views live in AgentSwitchLiveUI, where the Mac renders them in tests; here they
/// are only placed.
@main
struct AgentSwitchWidgets: WidgetBundle {
    var body: some Widget {
        AgentLiveActivity()
    }
}

struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            LockScreenCard(state: context.state, mac: context.attributes.macName, stale: context.isStale)
                // Dark on any wallpaper: the views are drawn for it.
                .activityBackgroundTint(LiveLook.background)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(LiveLook.link(context.state))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { IslandLeading(state: state) }
                DynamicIslandExpandedRegion(.trailing) { IslandTrailing(state: state) }
                DynamicIslandExpandedRegion(.center) { IslandCenter(state: state) }
                DynamicIslandExpandedRegion(.bottom) { IslandBottom(state: state) }
            } compactLeading: {
                StatusGlyph(state: state, size: 22)
            } compactTrailing: {
                IslandCompactTrailing(state: state)
            } minimal: {
                StatusGlyph(state: state, size: 22)
            }
            .widgetURL(LiveLook.link(state))
            .keylineTint(LiveLook.tint(state))
        }
    }
}
