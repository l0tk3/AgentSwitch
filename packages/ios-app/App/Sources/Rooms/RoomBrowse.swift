import AgentSwitchKit
import SwiftUI

// A room's second version (design-room-ui-v2): its tasks as channels in a drawer, a task's card at the top of its
// messages and the room's beginning at the top of the room's, the search, and 等你处理 — what waits on the user in every
// room.

/// Where the Rooms tab goes: a room — opened at a task, a message or a member's card when 等你处理 asks — or the list
/// of what waits on the user.
enum RoomRoute: Hashable {
    struct Open: Hashable {
        var task: Int?
        var seq: Int?
        var card: String?
    }

    case room(String, Open? = nil)
    case attention
}

/// The task drawer (user #191: 任务栏收进抽屉): `# 全部` on top, then the tasks not done — stuck ones first, each with
/// its number, title, owner's face and how many new messages are about it — those done folded under 已完成, and
/// `+ 新任务` at the foot. A task picked narrows the timeline to it and the drawer goes.
struct RoomTaskDrawer: View {
    let model: RoomPageModel
    let close: () -> Void
    let newTask: () -> Void
    @Environment(\.interfaceLook) private var look
    @State private var showDone = false

    var body: some View {
        let detail = model.detail
        let open = (detail?.tasks(.blocked) ?? []) + (detail?.tasks(.doing) ?? []) + (detail?.tasks(.todo) ?? [])
        let done = detail?.tasks(.done) ?? []
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Color.black.opacity(look.isClassic ? 0.25 : 0.45).ignoresSafeArea().onTapGesture(perform: close)
                VStack(alignment: .leading, spacing: 0) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            allRow
                            HairRule().padding(.vertical, 4)
                            if open.isEmpty && done.isEmpty {
                                Text("还没有任务。任务像频道：点进去只看它的消息。").font(.system(size: 12.5)).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 10)
                            }
                            ForEach(open) { task in row(task, detail) }
                            if !done.isEmpty {
                                Button { withAnimation(.easeOut(duration: 0.15)) { showDone.toggle() } } label: {
                                    HStack(spacing: 6) {
                                        LookGlyph.fold(open: showDone, size: 10).foregroundStyle(Theme.inkDim)
                                        Text("已完成").mono(11.5).foregroundStyle(Theme.secondaryInk)
                                        Text("\(done.count)").mono(11).foregroundStyle(Theme.inkDim)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                if showDone || done.contains(where: { $0.n == model.taskFilter }) {
                                    ForEach(done) { task in row(task, detail) }
                                }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    HairRule()
                    Button(action: newTask) {
                        HStack(spacing: 8) {
                            LookGlyph(glyph: "+", symbol: "plus", size: 15)
                            Text("新任务").font(.system(size: 15, weight: .medium))
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(look.isClassic ? Theme.signal : Theme.ink)
                        .padding(.horizontal, 14).padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .frame(width: min(320, g.size.width * 0.84))
                .frame(maxHeight: .infinity)
                .background { Theme.base.ignoresSafeArea(edges: .bottom) }
                .overlay(alignment: .trailing) { Theme.line.frame(width: 1) }
                .gesture(DragGesture(minimumDistance: 20).onEnded { if $0.translation.width < -60 { close() } })
            }
        }
    }

    /// `# 全部`: the whole room.
    private var allRow: some View {
        let on = model.taskFilter == nil
        return Button { model.taskFilter = nil; close() } label: {
            HStack(spacing: 10) {
                Text("#").font(.system(size: 17, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.secondaryInk).frame(width: 22)
                Text("全部").font(.system(size: 15, weight: on ? .semibold : .regular)).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
                if let name = model.detail?.room.name { Text(name).font(.system(size: 12)).foregroundStyle(Theme.inkDim).lineLimit(1) }
            }
            .modifier(DrawerRow(on: on))
        }
        .buttonStyle(.plain)
    }

    private func row(_ task: RoomTask, _ detail: RoomDetail?) -> some View {
        let on = model.taskFilter == task.n
        let unread = model.unread(task: task.n)
        return Button { model.taskFilter = task.n; close() } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(task.name).mono(12, weight: .medium).foregroundStyle(Theme.secondaryInk).frame(width: 22, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(task.title).font(.system(size: 15, weight: on || unread > 0 ? .semibold : .regular))
                            .foregroundStyle(task.state == .done ? Theme.secondaryInk : Theme.ink).lineLimit(1)
                        if task.state == .blocked { Text("⚠ 卡住").mono(11, weight: .medium).foregroundStyle(Theme.waiting).fixedSize() }
                        if task.state == .done { Text("✓").mono(12).foregroundStyle(Theme.done) }
                    }
                    if task.state == .blocked, let note = task.note, !note.isEmpty {
                        Text(note).font(.system(size: 12)).foregroundStyle(Theme.waiting).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if let owner = task.owner {
                    RoomFaceView(face: detail?.seat(owner)?.face, you: owner == RoomSeat.you, side: 18).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 4 }
                }
                if unread > 0 { RoomCount(n: unread) }
            }
            .modifier(DrawerRow(on: on))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(task.name) \(task.title)，\(task.state.says)\(unread > 0 ? "，\(unread) 条新消息" : "")")
    }
}

/// A drawer row: the one shown marked — a ground in the classic look, a bar at its left in the pixel one.
private struct DrawerRow: ViewModifier {
    let on: Bool
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background {
                if on { if look.isClassic { RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.panel) } else { Theme.line.opacity(0.5) } }
            }
            .overlay(alignment: .leading) { if on && !look.isClassic { Theme.ink.frame(width: 2) } }
            .padding(.horizontal, look.isClassic ? 6 : 0)
            .contentShape(Rectangle())
    }
}

/// How many new: a small count, quiet.
struct RoomCount: View {
    let n: Int
    var tone: Color = Theme.inkDim
    @Environment(\.interfaceLook) private var look

    var body: some View {
        if look.isClassic {
            Text("\(n)").font(.system(size: 10.5, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 5).frame(minWidth: 17, minHeight: 17)
                .background(tone, in: Capsule())
        } else {
            Text("[\(n)]").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(tone == Theme.inkDim ? Theme.secondaryInk : tone)
        }
    }
}

/// The room's beginning, above its first message: its name, its topic, and that this is where it starts.
struct RoomOpening: View {
    let detail: RoomDetail
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if look.isClassic {
                Image(systemName: "bubble.left.and.bubble.right.fill").font(.system(size: 22)).foregroundStyle(Theme.signal)
                    .frame(width: 48, height: 48).background(Theme.panel, in: Circle())
            } else {
                ShadedSpriteView(sprite: .rooms, cell: 3)
            }
            Text(detail.room.name).font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.ink).padding(.top, 4)
            if !detail.room.topic.isEmpty {
                Text(detail.room.topic).font(.system(size: 14)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text("这是房间的开始。").font(.system(size: 13)).foregroundStyle(Theme.inkDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.top, 18)
        .padding(.bottom, 6)
    }
}

/// A task's card, above its messages: its number and title, whose it is and how it stands — a stuck one in amber with
/// what it waits for — what more was said of it, what it waits for, and what it has cost.
struct RoomTaskCard: View {
    let task: RoomTask
    let detail: RoomDetail
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(task.name).mono(15, weight: .semibold).foregroundStyle(Theme.secondaryInk)
                Text(task.title).font(.system(size: 19, weight: .bold)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                if let owner = task.owner {
                    RoomFaceView(face: detail.seat(owner)?.face, you: owner == RoomSeat.you, side: 18)
                    Text(owner == RoomSeat.you ? "你" : "@" + owner).foregroundStyle(Theme.secondaryInk)
                    Text("·").foregroundStyle(Theme.inkDim)
                } else {
                    Text("没人认领 ·").foregroundStyle(Theme.inkDim)
                }
                Text(task.state == .blocked ? "⚠ 卡住" : task.state.says).foregroundStyle(task.state == .blocked ? Theme.waiting : task.state == .done ? Theme.done : Theme.secondaryInk)
                if let waits = detail.waitsWord(task) { Text("· " + waits).foregroundStyle(Theme.waiting) }
            }
            .mono(12).lineLimit(1)
            if task.state == .blocked, let note = task.note, !note.isEmpty {
                Text("卡在：" + note).font(.system(size: 13.5)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.waiting.opacity(0.14))
                    .overlay(alignment: .leading) { Theme.waiting.frame(width: 3) }
            } else if let note = task.note, !note.isEmpty {
                Text(note).font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 8).overlay(alignment: .leading) { Theme.line.frame(width: 2) }
            }
            if let more = task.detail, !more.isEmpty {
                Text(more).font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let stats = detail.taskStats[task.n], !stats.isEmpty {
                Text(stats.line).mono(11).foregroundStyle(Theme.inkDim)
            }
            Text("这是 \(task.name) 的消息；在这里发的都属于它。").font(.system(size: 12)).foregroundStyle(Theme.inkDim).padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) { HairRule().padding(.horizontal, 14) }
    }
}

/// The search (⌕): words over the whole room, or over the task the timeline is narrowed to; the newest first, each
/// with its author, its time, its task and the words around what was found, marked. A hit tapped is brought into view
/// in the timeline with what came before and after it.
struct RoomSearchPage: View {
    let model: RoomPageModel
    var initial = ""
    let pick: (Int) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [RoomMessage]?
    @State private var error: String?
    @State private var working = false
    @FocusState private var typing: Bool

    var body: some View {
        let detail = model.detail
        NavigationStack {
            VStack(spacing: 0) {
                field
                HairRule()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed).padding(Theme.Space.l) }
                        if let results {
                            if results.isEmpty, !query.trimmingCharacters(in: .whitespaces).isEmpty {
                                Text("没有找到“\(query)”。").font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
                            }
                            ForEach(results) { m in
                                Button { dismiss(); pick(m.seq) } label: { row(m, detail) }.buttonStyle(.plain)
                            }
                        } else {
                            Text(scope + "。结果从新到旧。").font(.system(size: 13)).foregroundStyle(.secondary).padding(Theme.Space.l)
                        }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("搜索").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Done") } else { Text("Done").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
            }
        }
        .onAppear { query = initial; typing = initial.isEmpty }
        .task(id: query) {
            let q = query
            guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { results = nil; return }
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            working = true
            defer { working = false }
            do {
                let found = try await model.search(q, api: app.api)
                guard q == query else { return }
                results = found
                error = nil
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    /// Where it searches.
    private var scope: String {
        if let n = model.taskFilter { return "在 " + RoomMessage.taskWord(n, model.detail?.tasks.first { $0.n == n }?.title) + " 里搜" }
        return "在整个房间里搜"
    }

    private var field: some View {
        HStack(spacing: 8) {
            if look.isClassic {
                Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.inkDim)
            } else {
                Text("⌕").font(.system(size: 16, weight: .bold, design: .monospaced)).foregroundStyle(Theme.signal)
            }
            TextField(scope, text: $query).autocorrectionDisabled().textInputAutocapitalization(.never).focused($typing).submitLabel(.search)
            if working { BrailleSpinner(color: Theme.secondaryInk) }
            if !query.isEmpty {
                Button { query = "" } label: { LookGlyph(glyph: "×", symbol: "xmark.circle.fill", size: 15) }
                    .buttonStyle(.plain).foregroundStyle(Theme.inkDim).accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .grounded(look.isClassic ? Theme.panel : Color.clear, radius: 10)
        .framed(Theme.line, radius: look.isClassic ? 10 : 0)
        .padding(.horizontal, Theme.Space.l).padding(.vertical, 10)
    }

    private func row(_ m: RoomMessage, _ detail: RoomDetail?) -> some View {
        let snippet = RoomSnippet.of(m.text, query: query)
        return HStack(alignment: .top, spacing: 10) {
            RoomFaceView(face: detail?.seat(m.from)?.face, you: m.from == RoomSeat.you, side: 24).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(RoomWords.who(m.from)).font(.system(size: 14, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let n = m.task, model.taskFilter == nil {
                        Text("T\(n)").mono(10.5, weight: .medium).foregroundStyle(Theme.secondaryInk)
                            .padding(.horizontal, 4).framed(Theme.line, radius: look.isClassic ? 4 : 0)
                    }
                    Text(RoomWords.day(m.date) + " " + RoomWords.time(m.date)).mono(11).foregroundStyle(Theme.inkDim)
                }
                (Text(snippet.before) + Text(snippet.hit).bold().foregroundColor(Theme.ink).underline(color: Theme.waiting) + Text(snippet.after))
                    .font(.system(size: 13.5)).foregroundStyle(.secondary).lineLimit(3)
                    .background(alignment: .leading) { EmptyView() }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { HairRule().padding(.leading, look.isClassic ? 50 : 0) }
        .contentShape(Rectangle())
    }
}

/// 等你处理 (user #191: 顶部单独一个入口): what waits on the user's hand in every room, one to a line, the newest first —
/// a member's screen asking, a permission, a stuck task, a question to the user, sessions talking long alone. A tap
/// goes to the room, at the task, the message or the member's card.
struct RoomAttentionPage: View {
    let open: (RoomRoute) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let items = app.rooms.attention
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if items.isEmpty {
                    Text("没有等你处理的事。会话要你确认权限、信任文件夹，任务卡住，或有人问你问题时，会列在这里。")
                        .font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
                }
                ForEach(items) { item in
                    Button { open(.room(item.room, Self.where(item))) } label: { row(item) }.buttonStyle(.plain)
                }
            }
            .padding(.vertical, Theme.Space.s)
        }
        .background { ZStack { Theme.base; if !look.isClassic { Scanlines() } }.ignoresSafeArea() }
        .safeAreaInset(edge: .top, spacing: 0) { HairRule() }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { Text("等你处理").font(.headline) } }
        .refreshable { await app.rooms.refreshAttention(app.api, always: true) }
        .task(id: app.connection.endpoint) {
            while !Task.isCancelled {
                await app.rooms.refreshAttention(app.api, always: true)
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    /// Where in the room an item is: the task, the question, or the member whose screen asks.
    static func `where`(_ item: RoomAttentionItem) -> RoomRoute.Open {
        switch item.kind {
        case .trust, .asks, .permission: return .init(card: item.handle)
        case .blocked: return .init(task: item.task)
        case .question: return .init(seq: item.seq)
        case .rounds, .other: return .init()
        }
    }

    private func row(_ item: RoomAttentionItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.line).font(.system(size: 15)).foregroundStyle(item.urgent ? Theme.waiting : Theme.ink).lineLimit(2)
                Text(item.roomName + " · " + item.date.relative).mono(11.5).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            LookGlyph.onward().foregroundStyle(Theme.inkDim)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { HairRule().padding(.leading, look.isClassic ? Theme.Space.l : 0) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
