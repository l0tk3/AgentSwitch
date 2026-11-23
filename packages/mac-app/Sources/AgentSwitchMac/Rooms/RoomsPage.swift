import AgentSwitchMacCore
import QuickLook
import SwiftUI

/// The main window's Chat Room page (docs/chatroom-v0.md §10; concept `docs/design/concepts/chatroom.html`): the rooms
/// of the node the window is on · the room on screen with its timeline and the input · its members. Read again every
/// second or so while the page is the one shown (an unchanged room costs nothing: the service answers 304); while
/// another page is shown only the list is read, slowly, for the rail's mark.
struct RoomsPage: View {
    let state: MainWindowState
    /// A made-up page for the design preview.
    var demo: RoomsDemo?
    @Environment(AppModel.self) private var app
    @State private var model = RoomsModel()

    private var shown: Bool { state.page == .rooms && state.windowVisible }

    var body: some View {
        RoomsColumns(model: model, state: state, home: app.paths.userHome.path)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Look.ground)
            .tint(.brand)
            .followsWindow()
            .quickLookPreview($model.previewing)
            .task(id: "\(shown)|\(state.nodeId ?? "")") {
                let node = state.nodeId
                model.client = { [app] in app.client(on: node) }
                model.onThisMac = node == nil
                if let demo {
                    model.show(demo: demo.rooms, room: demo.room)
                    if let sheet = RoomsDemo.opens { model.open(sheet) }
                    if let card = RoomsDemo.card { model.card = card }
                    if let draft = RoomsDemo.draft { model.draft = draft }
                    tell()
                    return
                }
                while !Task.isCancelled {
                    if shown { await model.load() } else if state.windowVisible { await model.loadList() }
                    tell()
                    try? await Task.sleep(for: shown ? .milliseconds(1500) : .seconds(15))
                }
            }
            .onChange(of: state.nodeId) { model.reset() }
            .onChange(of: state.newRoomRequests) { model.open(.new) }
    }

    /// The window's bars and rail are told what the page has.
    private func tell() {
        let waiting = model.rooms.filter(\.forYou).count
        var status = [model.rooms.count == 1 ? "1 Room" : "\(model.rooms.count) Rooms"]
        if let room = model.room {
            status.append(room.sessions.count == 1 ? "1 Session Here" : "\(room.sessions.count) Sessions Here")
            if room.room.paused { status.append("Paused") }
        }
        state.roomsChanged(activity: PageActivity(waiting: waiting), status: status, title: model.room?.room.name ?? model.summary?.name)
    }
}

/// A made-up room for the design preview.
struct RoomsDemo {
    /// The design preview: what floats over the made-up room when it is drawn.
    @MainActor static var opens: RoomsModel.Sheet?
    @MainActor static var card: String?
    @MainActor static var draft: String?
    let rooms: [RoomSummary]
    let room: Room
}

private struct RoomsColumns: View {
    @Bindable var model: RoomsModel
    let state: MainWindowState
    let home: String
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 0) {
            RoomsList(model: model).frame(width: 236)
            HairRule(color: Look.line, vertical: true)
            center.frame(maxWidth: .infinity, maxHeight: .infinity)
            if state.roomsMembers, let room = model.room {
                HairRule(color: Look.line, vertical: true)
                RoomMembers(model: model, room: room).frame(width: 232)
            }
        }
        .overlay { if model.sheet != nil { sheet } }
        .confirmationDialog("Delete “\(model.room?.room.name ?? "")”?", isPresented: $model.deleting) {
            Button("Delete", role: .destructive) { model.delete() }
        } message: {
            Text("房间和里面的消息会一并删除，成员的会话不受影响。")
        }
    }

    @ViewBuilder
    private var center: some View {
        if let room = model.room {
            RoomView(model: model, room: room, home: home, showTerminal: state.onShowTerminal)
        } else if model.loaded, model.rooms.isEmpty {
            VStack(spacing: 12) {
                Text(model.error ?? "还没有房间。建一个，把正在运行的会话拉进来，它们就能互相说话。")
                    .font(.system(size: 13)).foregroundStyle(model.error == nil ? Look.ink2 : Color.failed).multilineTextAlignment(.center).lineSpacing(4)
                Button { model.open(.new) } label: { BracketLabel(word: "New Room") }.buttonStyle(BracketButtonStyle(role: .primary))
            }
            .padding(.horizontal, 40)
        } else if let error = model.error {
            Text(error).font(.system(size: 13)).foregroundStyle(Color.failed).multilineTextAlignment(.center).padding(.horizontal, 40)
        } else {
            BrailleSpinner()
        }
    }

    private var sheet: some View {
        ZStack {
            Color.black.opacity(0.45).contentShape(Rectangle()).onTapGesture { model.sheet = nil }
            switch model.sheet {
            case .notes: RoomNotesSheet(model: model)
            case .tasks: RoomTasksSheet(model: model)
            case .files: RoomFilesSheet(model: model)
            case .models: RoomModelsSheet(model: model)
            default: RoomSheet(model: model, kind: model.sheet ?? .new)
            }
        }
    }
}

// MARK: - the rooms

private struct RoomsList: View {
    @Bindable var model: RoomsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                PartLabel("Rooms")
                Spacer()
                Button { model.open(.models) } label: { BracketLabel(word: "Models") }.buttonStyle(BracketButtonStyle(size: 12))
                    .help("管理员会话拉人时，每个配置下哪些模型能用。")
                Button { model.open(.new) } label: { BracketLabel(word: "New Room") }.buttonStyle(BracketButtonStyle(size: 12))
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            ScrollView {
                LazyVStack(spacing: look.isClassic ? 2 : 0) {
                    ForEach(Array(model.rooms.enumerated()), id: \.element.id) { index, room in
                        RoomListRow(room: room, index: index, current: room.id == model.selected) { model.selected = room.id }
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .background(look.isClassic ? Look.sidebar : Look.ground)
    }
}

private struct RoomListRow: View {
    let room: RoomSummary
    let index: Int
    let current: Bool
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    if !look.isClassic {
                        Text(String(format: "%02d", index + 1)).code(13).foregroundStyle(current ? Color.signal : Look.faint)
                    }
                    Text(room.name).mono(13, weight: look.isClassic ? .semibold : .regular).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    if room.paused { Text("Paused").mono(11).foregroundStyle(Look.faint) }
                    // Sessions went many rounds without the user (§7): the mark of what waits for you, where no count stands.
                    if room.rounds != nil, room.unread == 0, !room.paused { BlinkingSquare().help("会话之间已经往返多次，没有你参与。") }
                    if room.unread > 0 { count }
                }
                Text(room.lastLine).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, look.isClassic ? 10 : 12)
            .padding(.vertical, look.isClassic ? 7 : 8)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).fill(current ? Look.raised : hovering ? Look.hover : Color.clear))
            .overlay(alignment: .leading) { if current, !look.isClassic { Rectangle().fill(Color.signal).frame(width: 3) } }
            .padding(.horizontal, look.isClassic ? 8 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    /// How many the user has not seen: amber when one of them is for the user (what waits for you), quiet otherwise.
    @ViewBuilder
    private var count: some View {
        if look.isClassic {
            Text("\(room.unread)").font(.system(size: 10.5, weight: .bold)).foregroundStyle(room.forYou ? Color.white : Look.ink2)
                .padding(.horizontal, 5).frame(minWidth: 17, minHeight: 17)
                .background(Capsule().fill(room.forYou ? Color.waiting : Look.raised))
        } else {
            Text("[\(room.unread)]").code(11.5).foregroundStyle(room.forYou ? Color.waiting : Look.ink2)
        }
    }
}

// MARK: - a room

private struct RoomView: View {
    @Bindable var model: RoomsModel
    let room: Room
    let home: String
    var showTerminal: (String) -> Void = { _ in }
    @Environment(\.interfaceLook) private var look
    /// The reader is at the timeline's end (2026-11-24, user: 应该加一个回到底部的按钮): `↓ Latest` is away; `unseen`:
    /// a message came while they were reading further up, and they were left where they were.
    @State private var atEnd = true
    @State private var unseen = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(room.room.name).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Look.ink).lineLimit(1).fixedSize()
                Text(room.room.topic).font(.system(size: 12.5)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
                Button { model.open(.tasks) } label: { BracketLabel(word: room.tasks.isEmpty ? "Tasks" : "Tasks \(room.tasks(.done).count)/\(room.tasks.count)") }.buttonStyle(BracketButtonStyle(size: 12))
                    .help("任务表：谁在做什么、做到哪了。成员和你都能加、能改。")
                Button { model.open(.files) } label: { BracketLabel(word: "Files") }.buttonStyle(BracketButtonStyle(size: 12))
                    .help("共享文件夹：成员把报告、方案这类长内容写在这里，消息里只放路径。")
                Button { model.open(.notes) } label: { BracketLabel(word: "Notes") }.buttonStyle(BracketButtonStyle(size: 12))
                    .help(room.notes == nil ? "置顶笔记：成员都能读、能改的一份约定。" : "置顶笔记，\(room.notes!.who) 最后写于 \(TimeText.at(room.notes!.date))。")
                Button { model.open(.edit) } label: { BracketLabel(word: "Edit") }.buttonStyle(BracketButtonStyle(size: 12))
                Button { model.setPaused(!room.room.paused) } label: { BracketLabel(word: room.room.paused ? "Resume" : "Pause") }
                    .buttonStyle(BracketButtonStyle(size: 12))
            }
            .padding(.horizontal, 14)
            .frame(height: 40)
            HairRule(color: Look.line)
            if room.room.paused { banner } else if let rounds = room.room.rounds { told(rounds) }
            needs
            if let said = model.problem ?? model.error { problem(said) }
            timeline
            HairRule(color: Look.line)
            RoomWriter(model: model, room: room)
        }
        .overlay(alignment: .topTrailing) {
            if let handle = model.card, let seat = room.seat(handle), !seat.isUser {
                ZStack(alignment: .topTrailing) {
                    Color.clear.contentShape(Rectangle()).onTapGesture { model.card = nil }
                    RoomMemberCard(seat: seat, home: home, claim: room.claim(of: handle), setCanAdd: { model.setCanAdd($0, seat: handle) },
                                   setMuted: { model.setMuted($0, seat: handle) }, resume: { model.resume(seat: handle) },
                                   mention: { model.mention(handle) }, kick: { model.kick(seat: handle) }, end: { model.end(seat: handle, delete: $0) }, rename: { model.rename(seat: handle, to: $0) },
                                   openTerminal: seat.terminal.map { id in { model.card = nil; showTerminal(id) } })
                        .padding(.top, 48).padding(.trailing, 18)
                }
            }
        }
    }

    /// Paused: messages are written and not given (§2).
    private var banner: some View {
        HStack(spacing: 10) {
            BlinkingSquare()
            Text("房间已暂停。消息照写，不投递。").font(.system(size: 12.5)).foregroundStyle(Look.ink)
            Spacer()
            Button { model.setPaused(false) } label: { BracketLabel(word: "Resume") }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.waiting.opacity(look.isClassic ? 0.14 : 0.1))
        .overlay(alignment: .bottom) { HairRule(color: Look.line) }
    }

    /// Many rounds without the user (§7): told, not stopped. `OK` counts again from here; `Pause` is the user's to press.
    private func told(_ rounds: Int) -> some View {
        HStack(spacing: 10) {
            BlinkingSquare()
            Text(Room.roundsSays(rounds)).font(.system(size: 12.5)).foregroundStyle(Look.ink)
            Spacer()
            Button { model.setPaused(true) } label: { BracketLabel(word: "Pause") }.buttonStyle(BracketButtonStyle(size: 12))
            Button { model.roundsSeen() } label: { BracketLabel(word: "OK") }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.waiting.opacity(look.isClassic ? 0.14 : 0.1))
        .overlay(alignment: .bottom) { HairRule(color: Look.line) }
    }

    /// Members that need one thing of the user, several at once (§6.2): their agents ask whether a folder is trusted,
    /// or their sessions have ended.
    @ViewBuilder
    private var needs: some View {
        let asking = room.sessions.filter { $0.asks?.trust == true }
        let ended = room.sessions.filter { $0.state == .exited }
        if !asking.isEmpty {
            notice("\(asking.map { "@" + $0.handle }.joined(separator: " ")) 在等你确认是否信任它的文件夹，确认之前收不到消息。",
                   help: asking.compactMap { $0.card?.cwd }.joined(separator: "\n"), word: asking.count > 1 ? "Trust All" : "Trust") { model.trustAll() }
        }
        if !ended.isEmpty {
            notice("\(ended.map { "@" + $0.handle }.joined(separator: " ")) 的会话已经结束。", help: "用同一个会话、同一个目录恢复，席位不变。",
                   word: ended.count > 1 ? "Resume All" : "Resume") { model.resumeAll() }
        }
    }

    private func notice(_ text: String, help: String, word: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            BlinkingSquare()
            Text(text).font(.system(size: 12.5)).foregroundStyle(Look.ink).lineLimit(2).help(help)
            Spacer()
            Button(action: action) { BracketLabel(word: word) }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.waiting.opacity(look.isClassic ? 0.14 : 0.1))
        .overlay(alignment: .bottom) { HairRule(color: Look.line) }
    }

    private func problem(_ text: String) -> some View {
        HStack(spacing: 8) {
            StatusMark(level: .error)
            Text(text).font(.system(size: 12.5)).foregroundStyle(Color.failed).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Spacer()
            if model.problem != nil {
                Button { model.dismissProblem() } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 12).foregroundStyle(Look.ink2).frame(width: 22, height: 22).contentShape(Rectangle()) }
                    .buttonStyle(.plain).help("Dismiss")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) { HairRule(color: Look.line) }
    }

    @ViewBuilder
    private var timeline: some View {
        if model.rows.isEmpty {
            VStack(spacing: 10) {
                Text("这个房间里还没有消息。").font(.system(size: 13)).foregroundStyle(Look.ink2)
                Text(example).font(.system(size: 12.5)).foregroundStyle(Look.faint).multilineTextAlignment(.center).lineSpacing(4)
            }
            .padding(.horizontal, 40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(model.rows) { row in
                            if let day = row.day { RoomDayLine(day: day) }
                            RoomMessageRow(row: row, room: room, actions: RoomRowActions(card: { model.card = $0 }, reply: { model.reply(to: $0) }, reveal: model.onThisMac ? { model.reveal($0) } : nil, preview: model.onThisMac ? { model.preview(file: $0) } : nil))
                                .id(row.id)
                        }
                        Color.clear.frame(height: 1).id("end")
                            .onAppear { atEnd = true; unseen = false }
                            .onDisappear { atEnd = false }
                    }
                    .padding(.top, 10)
                    .padding(.bottom, 14)
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: room.room.id) { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: model.rows.last?.id) {
                    // Followed while the reader is at the end, or when it is the user's own; else left where it is.
                    if atEnd || room.messages.last?.from == Room.you { proxy.scrollTo("end", anchor: .bottom) } else { unseen = true }
                }
                .overlay(alignment: .bottom) {
                    if !atEnd {
                        Button { unseen = false; withAnimation(.snappy(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) } } label: {
                            Text(unseen ? "↓ New" : "↓ Latest").mono(Look.size(11.5, look), weight: .medium).foregroundStyle(unseen ? Color.signal : Look.ink)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .grounded(Look.panel, radius: look.isClassic ? 13 : 0)
                                .framed(Look.line, radius: look.isClassic ? 13 : 0)
                        }
                        .buttonStyle(.plain)
                        .fixedSize()
                        .padding(.bottom, 10)
                    }
                }
            }
        }
    }

    private var example: String {
        let first = room.sessions.first?.handle
        return first.map { "写一句并用 @ 指定收件人，例如：@\($0) 接口改完了吗" } ?? "先把正在运行的会话拉进来（成员栏的 Add）。"
    }
}

/// The input (§10): the terminal's reply field, the names offered over it while an `@` is being typed, the message
/// being answered above it, and the key that sends.
private struct RoomWriter: View {
    @Bindable var model: RoomsModel
    let room: Room
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reply = model.replyTo, let quoted = room.messages.first(where: { $0.seq == reply }) {
                HStack(spacing: 8) {
                    LookGlyph(glyph: "↩", symbol: "arrowshape.turn.up.left", size: 13)
                    Text("Reply to \(quoted.from == Room.you ? "You" : quoted.from)").mono(12)
                    Text(RoomText.quote(quoted.text, handles: Set(room.seats.map(\.handle)))).font(.system(size: 12)).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    Button { model.replyTo = nil } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 13) }.buttonStyle(.plain).help("Close")
                }
                .foregroundStyle(Look.ink2)
            }
            if !model.files.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(model.files, id: \.self) { path in
                        HStack(spacing: 6) {
                            if let image = RoomPictures.thumb(path) {
                                Image(nsImage: image).resizable().aspectRatio(contentMode: .fill).frame(width: 28, height: 28).clipped()
                                    .framed(Look.line, radius: 0).onTapGesture { model.preview(file: path) }
                            } else {
                                LookGlyph(glyph: "⎘", symbol: "paperclip", size: 12)
                            }
                            Text((path as NSString).lastPathComponent).mono(12).lineLimit(1).truncationMode(.middle).help(path)
                            Button { model.detach(path) } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 12) }.buttonStyle(.plain).help("Remove")
                        }
                        .foregroundStyle(Look.ink2)
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                if model.onThisMac {
                    Button { model.pickFiles() } label: {
                        LookGlyph(glyph: "+", symbol: "plus", size: 15).foregroundStyle(Look.ink2).frame(width: 30, height: look.isClassic ? 30 : 34).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Attach Files")
                }
                ComposeField(text: $model.draft, height: $model.draftHeight, focusRequests: model.focusRequests, insert: model.insert, label: "Message",
                             placeholder: "Message — @ to mention", onKey: { model.key($0) },
                             onSubmit: { model.send() }, onFiles: { model.attach(urls: $0) }, onPasteAttachments: { model.pasteFromClipboard() }, onFocus: { _ in })
                    .frame(height: min(max(model.draftHeight, ComposeField.minHeight), ComposeField.maxHeight))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .grounded(Look.raised, radius: 17)
                    .framed(Look.line, radius: 17)
                Button { model.send() } label: {
                    Group {
                        if model.sending { BrailleSpinner() }
                        else if look.isClassic { Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)) }
                        else { Text("Send").font(.system(size: 12, weight: .semibold, design: .monospaced)) }
                    }
                    .foregroundStyle(model.canSend ? (look.isClassic ? Color.white : Look.ground) : Look.faint)
                    .padding(.horizontal, look.isClassic ? 0 : 10)
                    .frame(width: look.isClassic ? 30 : nil, height: look.isClassic ? 30 : 34)
                    .background(sendGround)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!model.canSend)
                .help(ClassicWords.help("Send ↩", in: look))
            }
            HStack(spacing: 12) {
                Text("只有 @ 才唤醒对方")
                if room.room.paused { Text("Paused") }
            }
            .font(.system(size: 11.5))
            .foregroundStyle(Look.faint)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
        // The names stand over the box, their foot on its top edge: hung from a line of no height there, so that
        // nothing depends on an alignment guide (one set before the padding was lost, and the names lay over the box).
        .overlay(alignment: .top) {
            Color.clear.frame(maxWidth: .infinity).frame(height: 0)
                .overlay(alignment: .bottomLeading) {
                    if !model.offered.isEmpty { names.padding(.leading, 14).padding(.bottom, 4) }
                }
        }
    }

    @ViewBuilder
    private var sendGround: some View {
        if look.isClassic {
            Circle().fill(model.canSend ? Color.signal : Look.raised)
        } else {
            Rectangle().fill(model.canSend ? Look.ink : Look.line)
        }
    }

    /// The members whose name begins with what is typed after `@`, and `all`.
    private var names: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.offered.enumerated()), id: \.element) { index, handle in
                let on = index == model.offeredIndex
                let seat = room.seat(handle)
                Button { model.take(handle) } label: {
                    HStack(spacing: 9) {
                        if let state = seat?.state { SeatStateMark(state: state) } else { Color.clear.frame(width: 10, height: 10) }
                        Text("@\(handle)").mono(12.5)
                        Text(note(seat)).font(.system(size: 12)).opacity(0.7).lineLimit(1)
                        Spacer(minLength: 4)
                        if let color = seat?.card?.profileColor { ProfileDot(color: color) }
                    }
                    .foregroundStyle(on && !look.isClassic ? Look.ground : Look.ink)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).fill(on ? (look.isClassic ? Look.raised : Look.ink) : Color.clear))
                    .padding(.horizontal, look.isClassic ? 4 : 0)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .frame(width: 300)
        .roomFloat()
    }

    private func note(_ seat: RoomSeat?) -> String {
        guard let seat else { return "全体，只有你能用" }
        return [seat.card.map { HarnessName.display($0.agent) }, seat.state.map { ClassicWords.word($0.word, in: look) }].compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - the members

private struct RoomMembers: View {
    @Bindable var model: RoomsModel
    let room: Room
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                PartLabel("Members")
                Spacer()
                Text("\(room.sessions.count + 1)").mono(11.5).foregroundStyle(Look.ink2)
                Button { model.open(.add) } label: { BracketLabel(word: "Add") }.buttonStyle(BracketButtonStyle(size: 12))
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            HairRule(color: Look.line)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(room.sessions) { seat in
                        RoomMemberRow(seat: seat) { model.card = model.card == seat.handle ? nil : seat.handle }
                    }
                    if room.sessions.isEmpty {
                        Text("还没有会话。").font(.system(size: 12)).foregroundStyle(Look.faint).padding(.horizontal, 12).padding(.top, 10)
                    }
                }
                .padding(.top, 4)
                .padding(.bottom, 10)
            }
        }
        .background(look.isClassic ? Look.sidebar : Look.ground)
    }
}

// MARK: - the pinned notes

/// The room's pinned notes (§9): one text every member reads and writes whole — what was agreed. The user edits it
/// here; a session writes it with its tool. Who wrote it last and when stands under the title.
private struct RoomNotesSheet: View {
    @Bindable var model: RoomsModel
    @State private var text = ""
    @Environment(\.interfaceLook) private var look

    private var notes: RoomNotes? { model.room?.notes }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Notes").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                if let notes { Text("\(notes.who) · \(TimeText.at(notes.date))").mono(11.5).foregroundStyle(Look.faint) }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            VStack(alignment: .leading, spacing: 8) {
                Text("房间里的成员都能读、能改的一份文本：约定、接口、待办。保存会整份替换。").font(.system(size: 12)).foregroundStyle(Look.faint)
                TextEditor(text: $text)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Look.ink)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .frame(height: 300)
                    .grounded(Look.raised, radius: Look.controlRadius)
                    .framed(Look.line, radius: Look.controlRadius)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Cancel", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
                Button { model.saveNotes(text) } label: { BracketLabel(word: "Save", key: "⌘↩") }
                    .buttonStyle(BracketButtonStyle(role: .primary)).keyboardShortcut(.return, modifiers: .command).disabled(text == (notes?.text ?? ""))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(width: 600)
        .roomFloat()
        .onAppear { text = notes?.text ?? "" }
    }
}

// MARK: - a room made, sessions added, a room's name changed

private struct RoomSheet: View {
    @Bindable var model: RoomsModel
    let kind: RoomsModel.Sheet
    @State private var name = ""
    @State private var topic = ""
    @State private var picked: [String] = []
    /// The search over the sessions to pick (2026-11-23, user: 和终端那里的搜索功能一样): by name, agent, model,
    /// profile and folder at once, and by what was said in them once typing pauses.
    @State private var query = ""
    @State private var said: [String: String] = [:]
    @State private var saidFor = ""
    @Environment(\.interfaceLook) private var look

    private var title: String {
        switch kind {
        case .new: "New Room"
        case .add: "Add Sessions"
        case .edit: "Edit Room"
        case .notes: "Notes"
        case .tasks: "Tasks"
        case .files: "Files"
        case .models: "Models"
        }
    }

    /// The sessions that can be seated: running on this node, and not in the room already.
    private var candidates: [TerminalInfo] {
        let seated = kind == .add ? Set(model.room?.sessions.compactMap(\.terminal) ?? []) : []
        let all = model.terminals.filter { !seated.contains($0.id) }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return all }
        return all.filter { t in
            TerminalSearch.match(q, in: Self.searched(t)) != nil || (saidFor == q.lowercased() && saidOf(t) != nil)
        }
    }

    /// What a row is searched by, besides what was said in it.
    private static func searched(_ t: TerminalInfo) -> String {
        [t.name, HarnessName.display(t.harness), t.model.map(ModelName.display), t.model, t.profileName, t.workdir].compactMap { $0 }.joined(separator: "  ")
    }

    private func saidOf(_ t: TerminalInfo) -> String? {
        guard let session = t.agentSessionId else { return nil }
        return said["\(t.harness):\(session)"]
    }

    /// What was said, asked of the service once typing pauses; an answer to an older query is dropped.
    private func searchSaid(_ q: String) async {
        let q = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { said = [:]; saidFor = ""; return }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, let hits = await model.searchSaid(q), !Task.isCancelled,
              query.trimmingCharacters(in: .whitespacesAndNewlines) == q else { return }
        said = hits
        saidFor = q.lowercased()
    }

    private var ready: Bool {
        switch kind {
        case .new, .edit: !name.trimmingCharacters(in: .whitespaces).isEmpty
        case .add: !picked.isEmpty
        case .notes, .tasks, .files, .models: false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                .padding(.horizontal, 16).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            VStack(alignment: .leading, spacing: 12) {
                if kind != .add {
                    field("Name") { RoomField(prompt: "Room Name", text: $name) }
                    field("Topic") { RoomField(prompt: "进来的成员先读到的一句话", text: $topic) }
                }
                if kind != .edit {
                    if kind == .new { HairRule(color: Look.line) }
                    PartLabel("Running Sessions")
                    if !model.terminals.isEmpty { searchLine }
                    if candidates.isEmpty {
                        Text(!query.trimmingCharacters(in: .whitespaces).isEmpty ? "没有找到匹配的会话。" : kind == .add ? "这个节点上正在运行的会话都已经在房间里了。" : "这个节点上没有正在运行的会话。房间可以先建，之后再拉人。")
                            .font(.system(size: 12)).foregroundStyle(Look.faint)
                    } else {
                        ScrollView {
                            VStack(spacing: 0) { ForEach(candidates, id: \.id) { pick($0) } }
                        }
                        .frame(maxHeight: 240)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if kind == .edit {
                    Button { model.sheet = nil; model.deleting = true } label: { BracketLabel(word: "Delete…") }.buttonStyle(BracketButtonStyle(role: .destructive))
                }
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Cancel", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
                Button { model.finish(name: name, topic: topic, picked: picked) } label: {
                    BracketLabel(word: kind == .new ? "Create" : kind == .add ? "Add" : "Save", key: "↩")
                }
                .buttonStyle(BracketButtonStyle(role: .primary)).keyboardShortcut(.defaultAction).disabled(!ready)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(width: 560)
        .roomFloat()
        .onAppear {
            if kind == .edit, let room = model.room { name = room.room.name; topic = room.room.topic }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 10) {
            Text(label).mono(12.5).foregroundStyle(Look.ink2).frame(width: 66, alignment: .leading)
            content()
        }
    }

    /// `/ Search`, as on the Terminals page.
    private var searchLine: some View {
        HStack(spacing: look.isClassic ? 6 : 4) {
            if look.isClassic {
                Image(systemName: "magnifyingglass").font(.system(size: 11.5)).foregroundStyle(Look.faint)
            } else {
                Text("/").font(.system(size: 12.5, weight: .bold, design: .monospaced)).foregroundStyle(Color.signal)
            }
            PlainField(text: $query, placeholder: "Search",
                       font: look.isClassic ? .systemFont(ofSize: 13) : .monospacedSystemFont(ofSize: 12.5, weight: .regular),
                       takesFocusAtFirst: kind == .add,
                       onCancel: { if query.isEmpty { model.sheet = nil } else { query = "" } })
        }
        .padding(.horizontal, look.isClassic ? 8 : 6)
        .frame(height: look.isClassic ? 28 : 26)
        .background(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).fill(look.isClassic ? Look.ink.opacity(0.07) : Color.clear))
        .overlay(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).strokeBorder(look.isClassic ? Color.clear : Look.line, lineWidth: 1))
        .task(id: query) { await searchSaid(query) }
    }

    private func pick(_ terminal: TerminalInfo) -> some View {
        let on = picked.contains(terminal.id)
        // The rooms it sits in already are said beside it; it can sit in this one too.
        let held = model.roomHolding(terminal.id, besides: kind == .add ? model.selected : nil)
        return Button {
            if on { picked.removeAll { $0 == terminal.id } } else { picked.append(terminal.id) }
        } label: {
            HStack(spacing: 10) {
                LookChoice(on: on, multi: true, size: 12.5).foregroundStyle(on ? (look.isClassic ? Color.signal : Look.ink) : Look.ink2)
                SeatStateMark(state: terminal.status == "working" ? .busy : terminal.status == "waiting" ? .waiting : .idle)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ListLook.marked(terminal.name, query: query, classic: look.isClassic)).mono(12.5).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.tail)
                    if let words = saidOf(terminal), saidFor == query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), TerminalSearch.match(query, in: terminal.name) == nil {
                        Text(ListLook.marked(words, query: query, classic: look.isClassic)).font(.system(size: 11)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.middle)
                    }
                }
                Text([HarnessName.display(terminal.harness), terminal.model.map(ModelName.display)].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1)
                Spacer(minLength: 4)
                if let held { Text("In " + held.name).mono(11.5).foregroundStyle(Look.faint).lineLimit(1).truncationMode(.middle) }
                if let color = terminal.profileColor { ProfileDot(color: color) }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(held.map { "已经在房间「\($0.name)」里；也能再进这一个。" } ?? "")
    }
}
