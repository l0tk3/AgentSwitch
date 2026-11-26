import AgentSwitchKit
import SwiftUI

/// The `Rooms` tab (docs/chatroom-v0.md §10; 2026-11-22, user: 空出来的放这个chatroom): the rooms on the Mac shown, the
/// one talked in last first — its name, who said the last thing and what, how many messages are not seen yet (amber
/// when one of them names the user) — and from each its page. `New` makes one. The list is read by the tabs' root
/// (MainTabs), often while this tab is on screen. In three groups that fold, as on the Mac (user #488, #492, #625):
/// `Mentions` (what waits on the user's hand, a row each — the 等你处理 entry that was in the bar —, then the rooms
/// with a message for the user and nothing else waiting in them), `Dispatch` (the desk), `Topics`.
struct RoomsTab: View {
    @Environment(AppModel.self) private var model
    @Environment(\.interfaceLook) private var look
    @State private var path: [RoomRoute] = []
    @State private var creating = false
    @AppStorage("rooms.fold.mentions") private var mentionsFolded = false
    @AppStorage("rooms.fold.dispatch") private var dispatchFolded = false
    @AppStorage("rooms.fold.topics") private var topicsFolded = false

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
                    groups(store)
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
    private func groups(_ store: RoomsStore) -> some View {
        let mentions = Self.mentions(store)
        let desks = store.rooms.filter(\.desk), topics = store.rooms.filter { !$0.desk }
        if !mentions.isEmpty {
            RoomGroupHead(title: "Mentions", count: mentions.count, hot: true, folded: $mentionsFolded)
            if !mentionsFolded {
                card(VStack(spacing: 0) {
                    ForEach(Array(mentions.enumerated()), id: \.element.id) { i, item in
                        Button { path.append(item.route) } label: { RoomMentionRow(item: item, last: i == mentions.count - 1) }.buttonStyle(.plain)
                    }
                })
            }
        }
        if !desks.isEmpty {
            RoomGroupHead(title: "Dispatch", count: desks.reduce(0) { $0 + $1.unread }, hot: desks.contains(where: \.forYou), folded: $dispatchFolded)
            if !dispatchFolded { card(rows(desks)) }
        }
        if !topics.isEmpty {
            RoomGroupHead(title: "Topics", count: topics.reduce(0) { $0 + $1.unread }, hot: topics.contains(where: \.forYou), folded: $topicsFolded)
            if !topicsFolded { card(rows(topics)) }
        }
    }

    private func rows(_ rooms: [RoomSummary]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(rooms.enumerated()), id: \.element.id) { index, room in
                NavigationLink(value: RoomRoute.room(room.id)) { RoomListRow(room: room, index: index, last: index == rooms.count - 1) }
                    .buttonStyle(.plain)
            }
        }
    }

    /// A group's rows: on a standard grouped list's card in the classic look, on the ground in the pixel look.
    @ViewBuilder private func card(_ rows: some View) -> some View {
        if look.isClassic {
            rows.grounded(Theme.panel, radius: Theme.Radius.card).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .padding(.horizontal, Theme.Space.l)
        } else {
            rows
        }
    }

    /// What waits on the user's hand, a row each, then the rooms with a message for the user and nothing else waiting
    /// in them (as the Mac's `Mentions`).
    static func mentions(_ store: RoomsStore) -> [RoomMentionItem] {
        let waiting = store.attention.filter { $0.kind != .rounds }.map { item in
            RoomMentionItem(id: item.id, roomId: item.room, room: item.roomName, line: item.line, urgent: item.urgent, route: .room(item.room, RoomAttentionPage.where(item)))
        }
        let held = Set(waiting.map(\.roomId))
        let said = store.rooms.filter { $0.forYou && $0.unread > 0 && !held.contains($0.id) }.map { room in
            RoomMentionItem(id: "said|\(room.id)", roomId: room.id, room: room.name, line: room.lastLine, urgent: false, route: .room(room.id))
        }
        return waiting + said
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
}

/// A row of `Mentions`: the room, and under it who waits and for what.
struct RoomMentionItem: Identifiable {
    let id: String
    let roomId: String
    let room: String
    let line: String
    let urgent: Bool
    let route: RoomRoute
}

/// A group's head in the room list: its name, how much is new in it (amber when something there is for the user), and
/// the mark that folds it.
private struct RoomGroupHead: View {
    let title: String
    let count: Int
    let hot: Bool
    @Binding var folded: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { folded.toggle() } } label: {
            HStack(spacing: 6) {
                LookGlyph.fold(open: !folded, size: 11).foregroundStyle(.secondary).frame(width: 12)
                SectionLabel(title)
                Spacer(minLength: 4)
                if count > 0 {
                    if look.isClassic {
                        Text("\(count)").font(.system(size: 11, weight: .bold)).foregroundStyle(hot ? Color.white : Theme.ink)
                            .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(hot ? Theme.waiting : Theme.panel, in: Capsule())
                    } else {
                        Text("[\(count)]").mono(12).foregroundStyle(hot ? Theme.waiting : Theme.secondaryInk)
                    }
                }
            }
            .padding(.horizontal, Theme.Space.l)
            .padding(.top, Theme.Space.m).padding(.bottom, Theme.Space.s)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title)\(count > 0 ? " \(count)" : "")")
        .accessibilityHint(folded ? "Expand" : "Collapse")
    }
}

/// A row of `Mentions`: `@`, the room, and what waits.
private struct RoomMentionRow: View {
    let item: RoomMentionItem
    let last: Bool
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("@").font(.system(size: 15, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.waiting).frame(width: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.room).font(.system(size: 15.5, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text(item.line).font(.system(size: 13.5)).foregroundStyle(item.urgent ? Theme.waiting : .secondary).lineLimit(2)
            }
            Spacer(minLength: 6)
            LookGlyph.onward().foregroundStyle(Theme.inkDim)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { if !(look.isClassic && last) { HairRule().padding(.leading, look.isClassic ? Theme.Space.l : 0) } }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
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
