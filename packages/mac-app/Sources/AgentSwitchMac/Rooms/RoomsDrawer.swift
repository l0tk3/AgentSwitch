import AgentSwitchMacCore
import SwiftUI

// The room's second version (design-room-ui-v2.md, user #191): the task drawer, the search, and 等你处理.

/// The tasks of the room as channels (user #177, #191: 任务栏收进抽屉): `# 全部` on top, then the tasks under way —
/// stuck first — each with its owner and what the user has not seen of it, those done folded below, and a new one at
/// the foot. A pick narrows the timeline to it and the drawer goes back in.
struct RoomTaskDrawer: View {
    @Bindable var model: RoomsModel
    let room: Room
    @State private var doneOpen = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.opacity(0.18).contentShape(Rectangle()).onTapGesture { model.drawer = false }
            VStack(alignment: .leading, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        row(nil, title: "# 全部", note: nil, count: 0)
                        HairRule(color: Look.line).padding(.vertical, 5)
                        let open = room.tasks.filter { $0.state != .done }.sorted { order($0) < order($1) }
                        if open.isEmpty { Text("还没有任务").font(.system(size: 12)).foregroundStyle(Look.faint).padding(.horizontal, 12).padding(.vertical, 6) }
                        ForEach(open) { task in row(task, title: RoomTaskLabel.word(task.n, task.title), note: task.state == .blocked ? "⚠ 卡住" : task.state == .todo ? "未开始" : nil, count: model.unseen(task: task.n)) }
                        let done = room.tasks(.done)
                        if !done.isEmpty {
                            Button { doneOpen.toggle() } label: {
                                HStack(spacing: 6) {
                                    LookGlyph(glyph: doneOpen ? "▾" : "▸", symbol: doneOpen ? "chevron.down" : "chevron.right", size: 9)
                                    Text("已完成 \(done.count)").font(.system(size: 11.5, weight: .medium))
                                    Spacer()
                                }
                                .foregroundStyle(Look.faint).padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 3).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            if doneOpen { ForEach(done) { task in row(task, title: RoomTaskLabel.word(task.n, task.title), note: "✓", count: 0) } }
                        }
                    }
                    .padding(.vertical, 6)
                }
                HairRule(color: Look.line)
                Button { model.drawer = false; model.open(.tasks) } label: {
                    HStack(spacing: 6) { LookGlyph(glyph: "+", symbol: "plus", size: 12); Text("新任务 · 任务表").font(.system(size: 12.5)); Spacer() }
                        .foregroundStyle(Look.ink2).padding(.horizontal, 12).frame(height: 34).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .frame(width: 280)
            .frame(maxHeight: 460, alignment: .top)
            .fixedSize(horizontal: false, vertical: true)
            .background(Look.panel)
            .overlay(alignment: .trailing) { HairRule(color: Look.line, vertical: true) }
            .overlay(alignment: .bottom) { HairRule(color: Look.line) }
            .roomFloat()
            .padding(.leading, 8)
        }
        .onExitCommand { model.drawer = false }
    }

    /// Stuck first, then those under way, then those not begun; by number within.
    private func order(_ t: RoomTask) -> Int { (t.state == .blocked ? 0 : t.state == .doing ? 1 : 2) * 100_000 + t.n }

    private func row(_ task: RoomTask?, title: String, note: String?, count: Int) -> some View {
        let current = model.taskFilter == task?.n
        return Button { model.taskFilter = task?.n; model.drawer = false } label: {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 13, weight: current ? .semibold : .regular)).foregroundStyle(task?.state == .done ? Look.faint : Look.ink).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                if let note { Text(note).font(.system(size: 11)).foregroundStyle(task?.state == .blocked ? Color.waiting : Look.faint) }
                if let owner = task?.owner, let seat = room.seat(owner) { RoomFaceView(seat: seat, side: 16, cell: 2.4).help("@" + owner) }
                if count > 0 {
                    Text("\(count)").font(.system(size: 10.5, weight: .bold)).foregroundStyle(Color.white)
                        .padding(.horizontal, 5).frame(minWidth: 17, minHeight: 17).background(Capsule().fill(Color.signal))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0).fill(current ? Look.raised : Color.clear))
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(task.map { [$0.detail, $0.state == .blocked ? $0.note.map { "卡住：" + $0 } : nil].compactMap { $0 }.joined(separator: "\n") } ?? "整个房间的消息")
    }
}

/// The room's bar while searching (⌕): the words, and the way back.
struct RoomSearchBar: View {
    @Bindable var model: RoomsModel
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            LookGlyph(glyph: "⌕", symbol: "magnifyingglass", size: 13).foregroundStyle(Look.ink2)
            TextField(model.taskFilter.map { "在 T\($0) 里搜索" } ?? "在这个房间里搜索", text: $model.query)
                .textFieldStyle(.plain).font(.system(size: 13)).focused($focused)
                .onSubmit { Task { await model.runSearch() } }
                .onChange(of: model.query) {
                    let q = model.query
                    Task { try? await Task.sleep(for: .milliseconds(250)); if q == model.query { await model.runSearch() } }
                }
            if model.finding { BrailleSpinner() }
            Button { model.closeSearch() } label: { Text("Done").font(.system(size: 12.5)) }.buttonStyle(BracketButtonStyle(size: 12))
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
        .onAppear { focused = true }
    }
}

/// What the search found, newest first: who, when, its task, and its words around what was asked for, lit. A click
/// goes to it in the timeline; one older than the timeline holds opens here whole.
struct RoomSearchResults: View {
    @Bindable var model: RoomsModel
    let room: Room
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let q = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        Group {
            if q.isEmpty {
                hint("输入要找的字。三个字以上用全文索引，更快。")
            } else if model.found.isEmpty, !model.finding {
                hint("没有找到“\(q)”。")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        Text("\(model.found.count) 条").font(.system(size: 11.5)).foregroundStyle(Look.faint).padding(.horizontal, 14).padding(.vertical, 6)
                        ForEach(model.found) { message in result(message, q: q) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.system(size: 12.5)).foregroundStyle(Look.ink2).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func result(_ m: RoomMessage, q: String) -> some View {
        let open = model.opened == m.seq
        return Button { model.go(to: m.seq) } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(m.from == Room.you ? "You" : m.from).mono(12.5, weight: .semibold).foregroundStyle(Look.ink)
                    Text(TimeText.at(m.date)).mono(11).foregroundStyle(Look.faint)
                    if let n = m.task { Text("T\(n)").mono(11).foregroundStyle(Look.ink2) }
                    Spacer()
                    Text("#\(m.seq)").mono(11).foregroundStyle(Look.faint)
                }
                if open {
                    Text(RoomRich.text(m.text, handles: Set(room.seats.map(\.handle)), look: look)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("这条较早，不在当前时间线里，全文在这里。").font(.system(size: 11)).foregroundStyle(Look.faint)
                } else {
                    Text(Self.snippet(m.text, q)).font(.system(size: 12.5)).foregroundStyle(Look.ink2).lineLimit(2)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { HairRule(color: Look.line).opacity(0.6) }
    }

    /// Its words around the first place `q` stands, `q` lit.
    static func snippet(_ text: String, _ q: String) -> AttributedString {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        guard let hit = flat.range(of: q, options: .caseInsensitive) else { return AttributedString(String(flat.prefix(160))) }
        let start = flat.index(hit.lowerBound, offsetBy: -40, limitedBy: flat.startIndex) ?? flat.startIndex
        let end = flat.index(hit.upperBound, offsetBy: 80, limitedBy: flat.endIndex) ?? flat.endIndex
        var out = AttributedString((start > flat.startIndex ? "…" : "") + String(flat[start..<hit.lowerBound]))
        var lit = AttributedString(String(flat[hit]))
        lit.foregroundColor = Look.ink
        lit.backgroundColor = Color.waiting.opacity(0.3)
        out += lit
        out += AttributedString(String(flat[hit.upperBound..<end]) + (end < flat.endIndex ? "…" : ""))
        return out
    }
}

/// 等你处理 (user #191: 顶部单独一个入口): one entry at the top of the rooms, with how many things in all the rooms
/// wait on the user's hand; a click lists them, and one taken goes where it is.
struct RoomAttentionEntry: View {
    @Bindable var model: RoomsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let n = model.attentionCount
        Button { model.attentionShown.toggle(); if model.attentionShown { Task { await model.loadAttention() } } } label: {
            HStack(spacing: 8) {
                if n > 0 { BlinkingSquare() } else { LookGlyph(glyph: "✓", symbol: "checkmark", size: 11).foregroundStyle(Look.faint) }
                Text("等你处理").font(.system(size: 12.5, weight: n > 0 ? .semibold : .regular)).foregroundStyle(n > 0 ? Look.ink : Look.faint)
                Spacer()
                if n > 0 {
                    Text("\(n)").font(.system(size: 10.5, weight: .bold)).foregroundStyle(Color.white)
                        .padding(.horizontal, 5).frame(minWidth: 17, minHeight: 17).background(Capsule().fill(Color.waiting))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(n > 0 ? Color.waiting.opacity(look.isClassic ? 0.12 : 0.08) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { HairRule(color: Look.line) }
        .help(n > 0 ? "所有房间里要你动手的事" : "现在没有要你动手的事")
        .popover(isPresented: $model.attentionShown, arrowEdge: .trailing) { list }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("等你处理").font(.system(size: 13, weight: .semibold)).padding(.horizontal, 14).padding(.vertical, 10)
            HairRule(color: Look.line)
            if model.attention.isEmpty {
                Text("现在没有要你动手的事。").font(.system(size: 12.5)).foregroundStyle(Look.ink2).padding(14)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.attention) { item in
                            Button { model.open(attention: item) } label: {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(Self.mark(item.kind)).font(.system(size: 12)).foregroundStyle(item.kind == .question ? Look.ink2 : Color.waiting).frame(width: 14)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(item.line).font(.system(size: 12.5)).foregroundStyle(Look.ink).lineLimit(2).multilineTextAlignment(.leading)
                                        Text("\(item.roomName) · \(TimeText.at(Date(timeIntervalSince1970: Double(item.at) / 1000)))").font(.system(size: 11)).foregroundStyle(Look.faint)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 420)
            }
        }
        .frame(width: 340)
    }

    static func mark(_ kind: RoomAttention.Kind) -> String {
        switch kind {
        case .trust, .asks, .permission: "⚠"
        case .blocked: "⚠"
        case .question: "?"
        case .rounds: "↻"
        case .other: "•"
        }
    }
}
