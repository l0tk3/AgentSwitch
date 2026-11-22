import AgentSwitchKit
import SwiftUI

/// The `Rooms` tab (docs/chatroom-v0.md §10; 2026-11-22, user: 空出来的放这个chatroom): the rooms on the Mac shown, the
/// one talked in last first — its name, who said the last thing and what, how many messages are not seen yet (amber
/// when one of them names the user) — and from each its page. `New` makes one. The list is read by the tabs' root
/// (MainTabs), often while this tab is on screen.
struct RoomsTab: View {
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var path: [String] = []
    @State private var creating = false

    var body: some View {
        let store = model.rooms
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.connection.endpoint == nil {
                        ConnectionBanner().padding(.horizontal, Theme.Space.l).padding(.bottom, Theme.Space.m)
                    }
                    if let error = store.error {
                        Text(error).font(.footnote).foregroundStyle(Theme.failed).padding(.horizontal, Theme.Space.l).padding(.bottom, Theme.Space.m)
                    }
                    if store.unsupported {
                        Text("这台 Mac 上的 AgentSwitch 还没有 Chat Room。请先在 Mac 上更新。").font(.footnote).foregroundStyle(.secondary)
                            .padding(.horizontal, Theme.Space.l).padding(.top, 40)
                    } else if store.list != nil && store.rooms.isEmpty {
                        Text("尚无房间。点 New 新建一个，把正在运行的会话拉进来。").font(.footnote).foregroundStyle(.secondary)
                            .padding(.horizontal, Theme.Space.l).padding(.top, 40)
                    }
                    rows(store.rooms)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Theme.Space.m)
            }
            .background { ZStack { Theme.base; Scanlines() }.ignoresSafeArea() }
            .safeAreaInset(edge: .top, spacing: 0) { HairRule() }
            .navigationTitle("Rooms")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { MacTabTitle(title: "Rooms") }
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: {
                        if look.isClassic { Image(systemName: "plus") } else { Text("New").mono(15, weight: .medium) }
                    }
                    .accessibilityLabel("New")
                    .disabled(store.list == nil || store.unsupported)
                }
            }
            .navigationDestination(for: String.self) { id in RoomPage(id: id, detail: Self.sample(id)) }
            .refreshable { await store.refresh(model.api) }
            .onAppear {
                openRequested()
                #if DEBUG
                if DemoRooms.isDemo, DemoRooms.screen == "roomnew" { creating = true }
                #endif
            }
            .onChange(of: model.openRoomRequest) { openRequested() }
            // Another Mac: its rooms, from the list.
            .onChange(of: model.profile?.fingerprint) { path = [] }
        }
        .sheet(isPresented: $creating) {
            RoomSessionsSheet(purpose: .create) { made in path = [made] }.followsLook()
        }
    }

    @ViewBuilder
    private func rows(_ rooms: [RoomSummary]) -> some View {
        let list = VStack(spacing: 0) {
            ForEach(Array(rooms.enumerated()), id: \.element.id) { index, room in
                NavigationLink(value: room.id) { RoomListRow(room: room, index: index, last: index == rooms.count - 1) }
                    .buttonStyle(.plain)
            }
        }
        if look.isClassic {
            // A standard grouped list's card.
            list.grounded(Theme.panel, radius: Theme.Radius.card).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .padding(.horizontal, Theme.Space.l).opacity(rooms.isEmpty ? 0 : 1)
        } else {
            list
        }
    }

    /// The sample screens' room; nil with a real Mac.
    private static func sample(_ id: String) -> RoomDetail? {
        #if DEBUG
        return DemoRooms.detail(id)
        #else
        return nil
        #endif
    }

    private func openRequested() {
        guard let id = model.openRoomRequest else { return }
        model.openRoomRequest = nil
        path = [id]
    }
}

/// One room's line in the list.
private struct RoomListRow: View {
    let room: RoomSummary
    let index: Int
    let last: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                if !look.isClassic {
                    Text(String(format: "%02d", index + 1)).font(.system(size: 14, design: .monospaced)).foregroundStyle(Theme.inkDim)
                }
                Text(room.name).font(.system(size: 15.5, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 6)
                if room.paused { Text("Paused").mono(11).foregroundStyle(Theme.inkDim) }
                // Sessions talking among themselves with no word from the user (§7): told here too, in amber — it
                // waits for the user's look, and stops nothing.
                else if let n = room.rounds { Text("\(n) Rounds").mono(11).foregroundStyle(Theme.waiting).accessibilityLabel("\(n) rounds without you") }
                if room.unread > 0 { count }
            }
            Text(room.lastLine).font(.system(size: 13.5)).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { if !(look.isClassic && last) { HairRule().padding(.leading, look.isClassic ? Theme.Space.l : 0) } }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// How many are not seen yet: amber when one of them names the user (amber is what waits for you), quiet otherwise.
    @ViewBuilder private var count: some View {
        if look.isClassic {
            Text("\(room.unread)").font(.system(size: 10.5, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 5).frame(minWidth: 17, minHeight: 17)
                .background(room.forYou ? Theme.waiting : Theme.inkDim, in: Capsule())
        } else {
            Text("[\(room.unread)]").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(room.forYou ? Theme.waiting : Theme.secondaryInk)
        }
    }
}
