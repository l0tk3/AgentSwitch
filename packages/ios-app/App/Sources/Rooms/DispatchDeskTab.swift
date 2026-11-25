import AgentSwitchKit
import SwiftUI

/// The Dispatch tab: the room the Mac flags as the
/// dispatch desk (调度台, `desk: true` in `GET /rooms`) — its page as the Rooms tab pushes it, here as the tab's own,
/// titled `Dispatch`. The rooms list is the one the tabs' root reads (MainTabs). No desk: the dispatch is not on, and
/// only the Mac turns it on (its Settings › Dispatch; `/dispatch/desk` is the Mac's own).
struct DispatchDeskTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.rooms
        NavigationStack {
            if let desk = store.rooms.first(where: \.desk) {
                RoomPage(id: desk.id, detail: Self.sample(desk.id), tabTitle: "Dispatch")
                    // Another desk (another Mac, or made again): its own page model.
                    .id(desk.id)
            } else {
                VStack(spacing: 10) {
                    if store.list != nil || store.unsupported {
                        Text("调度还没打开").mono(15, weight: .semibold)
                        Text("在 Mac 的 Settings › Dispatch 里打开。").font(.subheadline).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.base)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if model.connection.endpoint == nil { ConnectionBanner().padding(.horizontal, Theme.Space.l) }
                }
                .navigationTitle("Dispatch")
                .navigationBarTitleDisplayMode(.inline)
                .refreshable { await store.refresh(model.api) }
            }
        }
    }

    /// The sample screens' desk; nil with a real Mac.
    private static func sample(_ id: String) -> RoomDetail? {
        #if DEBUG
        return DemoRooms.detail(id)
        #else
        return nil
        #endif
    }
}
