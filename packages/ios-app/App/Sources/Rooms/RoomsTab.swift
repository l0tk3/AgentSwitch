import AgentSwitchKit
import SwiftUI

/// The `Rooms` tab (docs/chatroom-v0.md §10; 2026-11-22, user: 空出来的放这个chatroom): the rooms on the Mac shown, the
/// one talked in last first — its name, who said the last thing and what, how many messages are not seen yet (amber
/// when one of them names the user) — and from each its page. `New` makes one. The list is read by the tabs' root
/// (MainTabs), often while this tab is on screen.
struct RoomsTab: View {
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var path: [RoomRoute] = []
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
                // 等你处理 (user #191): its own entry at the top, with how many things wait.
                ToolbarItem(placement: .topBarTrailing) {
                    Button { path.append(.attention) } label: { attentionLabel(store.attentionCount) }
                        .accessibilityLabel(store.attentionCount > 0 ? "等你处理 \(store.attentionCount)" : "等你处理")
                        .disabled(store.list == nil || store.unsupported)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { creating = true } label: {
                        if look.isClassic { Image(systemName: "plus") } else { Text("New").mono(15, weight: .medium) }
                    }
                    .accessibilityLabel("New")
                    .disabled(store.list == nil || store.unsupported)
                }
            }
            .navigationDestination(for: RoomRoute.self) { route in
                switch route {
                case .room(let id, let open): RoomPage(id: id, detail: Self.sample(id), open: open)
                case .attention: RoomAttentionPage { path.append($0) }
                }
            }
            .refreshable { await store.refresh(model.api) }
            .onAppear {
                openRequested()
                #if DEBUG
                if DemoRooms.isDemo, DemoRooms.screen == "roomnew" { creating = true }
                if DemoRooms.isDemo, DemoRooms.screen == "roomattention" { path = [.attention] }
                #endif
            }
            .onChange(of: model.openRoomRequest) { openRequested() }
            // Another Mac: its rooms, from the list.
            .onChange(of: model.profile?.fingerprint) { path = [] }
        }
        .sheet(isPresented: $creating) {
            RoomSessionsSheet(purpose: .create) { made in path = [.room(made)] }.followsLook()
        }
    }

    @ViewBuilder
    private func rows(_ rooms: [RoomSummary]) -> some View {
        let list = VStack(spacing: 0) {
            // The desk has its mark, not a number: the rooms are counted after it.
            let skip = rooms.first?.desk == true ? 1 : 0
            ForEach(Array(rooms.enumerated()), id: \.element.id) { index, room in
                NavigationLink(value: RoomRoute.room(room.id)) { RoomListRow(room: room, index: index - skip, last: index == rooms.count - 1) }
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
        let at = model.openRoomAt
        model.openRoomRequest = nil
        model.openRoomAt = nil
        path = [.room(id, at)]
    }

    /// The inbox's mark and, when something waits, how many — amber (what waits for you).
    @ViewBuilder private func attentionLabel(_ n: Int) -> some View {
        HStack(spacing: 3) {
            if look.isClassic { Image(systemName: n > 0 ? "tray.full" : "tray") } else { Text("等你").mono(14, weight: .medium) }
            if n > 0 {
                if look.isClassic {
                    Text("\(n)").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(Theme.waiting, in: Capsule())
                } else {
                    Text("[\(n)]").mono(13, weight: .medium).foregroundStyle(Theme.waiting)
                }
            }
        }
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
                if room.desk {
                    RoomDeskMark()
                } else if !look.isClassic {
                    Text(String(format: "%02d", index + 1)).font(.system(size: 14, design: .monospaced)).foregroundStyle(Theme.inkDim)
                }
                Text(room.name).font(.system(size: 15.5, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                if room.desk { RoomDeskTag() }
                Spacer(minLength: 6)
                if room.paused { Text("Paused").mono(11).foregroundStyle(Theme.inkDim) }
                // Sessions talking among themselves with no word from the user (§7): told here too, in amber — it
                // waits for the user's look, and stops nothing.
                else if let n = room.rounds { Text("\(n) Rounds").mono(11).foregroundStyle(Theme.waiting).accessibilityLabel("\(n) rounds without you") }
                if room.attention > 0 { Text("⚠ \(room.attention)").mono(11).foregroundStyle(Theme.waiting).accessibilityLabel("\(room.attention) 件事等你处理") }
                if room.unread > 0 { count }
            }
            Text(room.lastLine).font(.system(size: 13.5)).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, room.desk ? 13 : 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The desk stands apart: a ground of the accent under it, a firmer rule below.
        .background { if room.desk { Theme.signal.opacity(look.isClassic ? 0.07 : 0.09) } }
        .overlay(alignment: .bottom) {
            if room.desk { Theme.line.frame(height: look.isClassic ? 0.5 : 2) }
            else if !(look.isClassic && last) { HairRule().padding(.leading, look.isClassic ? Theme.Space.l : 0) }
        }
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

/// The dispatch desk's mark (调度台): one source switched onto three lanes — the app's own mark, as the dispatch is the
/// one that sends work out; a system symbol in the classic look.
struct RoomDeskMark: View {
    @Environment(\.interfaceLook) private var look

    static let rows = PixelArt.markRows.map { String($0.map { $0 == "." ? "." : "#" }) }

    var body: some View {
        Group {
            if look.isClassic {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 24, height: 24).background(Theme.signal, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            } else {
                Canvas { context, _ in
                    for (y, row) in Self.rows.enumerated() {
                        for (x, c) in row.enumerated() where c == "#" {
                            context.fill(Path(CGRect(x: CGFloat(x) * 1.5, y: CGFloat(y) * 1.5, width: 1.5, height: 1.5)), with: .color(Theme.signal))
                        }
                    }
                }
                .frame(width: 21, height: 16.5)
            }
        }
        .accessibilityHidden(true)
    }
}

/// `Dispatch` beside the desk's name.
struct RoomDeskTag: View {
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            Text("Dispatch").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.signal)
                .padding(.horizontal, 6).padding(.vertical, 2).background(Theme.signal.opacity(0.14), in: Capsule())
        } else {
            Text("[DISPATCH]").mono(10.5, weight: .medium).foregroundStyle(Theme.signal)
        }
    }
}
