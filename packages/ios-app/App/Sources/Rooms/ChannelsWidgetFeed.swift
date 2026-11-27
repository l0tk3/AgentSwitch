import AgentSwitchKit
import AgentSwitchLive
import Foundation
import WidgetKit

/// The home screen's Channels widget's copy of the rooms (docs/app-v0.md §6): written to the app group whenever the
/// list read from the Mac or the look changes, and the widget told to draw again. Unchanged, nothing is written.
@MainActor
enum ChannelsWidgetFeed {
    fileprivate static var last: ChannelsSnapshot?

    static func save(_ list: RoomList?) {
        guard let list else { return }
        let now = ChannelsSnapshot(list, classic: InterfaceLook.current.isClassic)
        if let last, last.channels == now.channels, last.classic == now.classic { return }
        guard ChannelsShelf.write(now) else { return }
        last = now
        WidgetCenter.shared.reloadTimelines(ofKind: ChannelsShelf.kind)
    }

    /// The look changed: the widget draws in the new one.
    static func relook() {
        guard let kept = last ?? ChannelsShelf.read() else { return }
        let now = ChannelsSnapshot(channels: kept.channels, classic: InterfaceLook.current.isClassic)
        guard now.classic != kept.classic, ChannelsShelf.write(now) else { return }
        last = now
        WidgetCenter.shared.reloadTimelines(ofKind: ChannelsShelf.kind)
    }
}

extension ChannelsWidgetFeed {
    /// Another Mac, or none: the widget shows nothing of the one before.
    static func forget() {
        last = nil
        ChannelsShelf.clear()
        WidgetCenter.shared.reloadTimelines(ofKind: ChannelsShelf.kind)
    }
}
