import AgentSwitchMacCore
import QuickLook
import SwiftUI

/// The main window's Chat Room page (docs/chatroom-v0.md §10; concept `docs/design/concepts/chatroom.html`): the rooms
/// of the node the window is on · the room on screen with its timeline and the input · its members. Read again every
/// second or so while the page is the one shown (an unchanged room costs nothing: the service answers 304); while
/// another page is shown only the list is read, slowly, for the rail's mark.
struct RoomsPage: View {
    let state: MainWindowState
    /// The Dispatch page (the new dispatch, 2026-11-24): the 调度台 room alone, no list; while the dispatch is off, the
    /// way to turn it on.
    var desk = false
    /// A made-up page for the design preview.
    var demo: RoomsDemo?
    @Environment(AppModel.self) private var app
    @State private var model = RoomsModel()
    /// The dispatch, as the service tells it (the Dispatch page).
    @State private var dispatch: DispatchDesk?
    @State private var dispatchError: String?
    @State private var turningOn = false

    private var page: MainPage { desk ? .dispatch : .rooms }
    private var shown: Bool { state.page == page && state.windowVisible }

    var body: some View {
        Group {
            if desk && model.pinned == nil && demo == nil {
                DeskOff(dispatch: dispatch, error: dispatchError, turningOn: turningOn, onThisMac: state.nodeId == nil, turnOn: turnOn)
            } else {
                RoomsColumns(model: model, state: state, home: app.paths.userHome.path, list: !desk)
            }
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Look.ground)
            .tint(.brand)
            .followsWindow()
            .quickLookPreview($model.previewing)
            .task(id: "\(shown)|\(state.nodeId ?? "")") {
                let node = state.nodeId
                model.client = { [app] in app.client(on: node) }
                model.onThisMac = node == nil
                model.nodeId = node
                if let demo {
                    model.show(demo: demo.rooms, room: demo.room)
                    if let sheet = RoomsDemo.opens { model.open(sheet) }
                    if let card = RoomsDemo.card { model.card = card }
                    if let draft = RoomsDemo.draft { model.draft = draft }
                    RoomsDemo.setup?(model)
                    tell()
                    return
                }
                while !Task.isCancelled {
                    if desk {
                        // The node shown's own dispatch, this Mac's or another's (user #263).
                        if shown || dispatch == nil { await readDispatch(on: node) }
                        if model.pinned != nil, shown { await model.load() }
                    } else if shown { await model.load() } else if state.windowVisible { await model.loadList() }
                    tell()
                    try? await Task.sleep(for: shown ? .milliseconds(1500) : .seconds(15))
                }
            }
            .onChange(of: state.nodeId) { model.reset(); model.pinned = nil; dispatch = nil }
            .onChange(of: state.newRoomRequests) { if !desk { model.open(.new) } }
    }

    private func readDispatch(on node: String?) async {
        do {
            let now = try await app.client(on: node).dispatchDesk()
            guard node == state.nodeId else { return }
            dispatch = now
            dispatchError = nil
            let room = now.settings.on ? now.room : nil
            if model.pinned != room { model.pinned = room }
        } catch {
            guard node == state.nodeId else { return }
            // An older node keeps its dispatch from other Macs (404): it is updated first.
            dispatchError = node == nil ? "读不到调度：\(error.localizedDescription)" : "读不到那台节点的调度。它要先更新到新版本（那台的 AgentSwitch ›「有新版本 · 安装并重启…」）。\n\(error.localizedDescription)"
        }
    }

    private func turnOn() {
        guard var settings = dispatch?.settings else { return }
        settings.on = true
        turningOn = true
        Task {
            let node = state.nodeId
            do { dispatch = try await app.client(on: node).setDispatchDesk(settings); dispatchError = nil } catch { dispatchError = "没打开：\(error.localizedDescription)" }
            turningOn = false
            await readDispatch(on: node)
        }
    }

    /// The window's bars and rail are told what the page has.
    private func tell() {
        if desk {
            var status: [String] = []
            if let dispatch { status.append(dispatch.state) }
            if let room = model.room, room.room.paused { status.append("Paused") }
            state.deskChanged(status: status, waiting: model.summary?.forYou == true)
            return
        }
        let waiting = model.rooms.filter(\.forYou).count
        var status = [model.rooms.count == 1 ? "1 Room" : "\(model.rooms.count) Rooms"]
        if let room = model.room {
            status.append(room.sessions.count == 1 ? "1 Session Here" : "\(room.sessions.count) Sessions Here")
            if room.room.paused { status.append("Paused") }
        }
        state.roomsChanged(activity: PageActivity(waiting: waiting), status: status, title: model.room?.room.name ?? model.summary?.name)
    }
}

/// The Dispatch page while the dispatch is off (or not read yet): what it is, and `Turn On`.
private struct DeskOff: View {
    let dispatch: DispatchDesk?
    let error: String?
    let turningOn: Bool
    let onThisMac: Bool
    let turnOn: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            if let dispatch, !dispatch.settings.on {
                Text("调度还没打开").font(.system(size: 15, weight: .semibold)).foregroundStyle(Look.ink)
                Text("打开后，调度是一个一直在的会话，在「调度台」等你说话：你说要做什么，它开房间、拉人或开新会话、分任务、向你汇报。")
                    .foregroundStyle(Look.ink2).lineSpacing(4)
                HStack(spacing: 10) {
                    Button(action: turnOn) { BracketLabel(word: turningOn ? "Turning On…" : "Turn On") }
                        .buttonStyle(BracketButtonStyle(role: .primary)).disabled(turningOn)
                    if onThisMac {
                        Button { SettingsOpener.show(.desk) } label: { BracketLabel(word: "Settings…") }.buttonStyle(BracketButtonStyle())
                    }
                }
            } else if error == nil {
                BrailleSpinner()
                if let dispatch { Text(dispatch.state).foregroundStyle(Look.ink2) }
            }
            if let error { Text(error).foregroundStyle(Color.failed) }
        }
        .font(.system(size: 13))
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A made-up room for the design preview.
struct RoomsDemo {
    /// The design preview: what floats over the made-up room when it is drawn.
    @MainActor static var opens: RoomsModel.Sheet?
    @MainActor static var card: String?
    @MainActor static var draft: String?
    /// What else is set on the made-up page before it is drawn (the drawer out, a task shown, a search).
    @MainActor static var setup: ((RoomsModel) -> Void)?
    let rooms: [RoomSummary]
    let room: Room
}

private struct RoomsColumns: View {
    @Bindable var model: RoomsModel
    let state: MainWindowState
    let home: String
    /// The list of rooms on the left (not on the Dispatch page, which has the one room).
    var list = true
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 0) {
            if list {
                RoomsList(model: model).frame(width: 236 + (look.isClassic ? Look.panelGap : 0))
                HairRule(color: look.isClassic ? .clear : Look.line, vertical: true)
            }
            center.frame(maxWidth: .infinity, maxHeight: .infinity)
            if state.roomsMembers, let room = model.room {
                HairRule(color: look.isClassic ? .clear : Look.line, vertical: true)
                RoomMembers(model: model, room: room).frame(width: 232 + (look.isClassic ? 2 * Look.panelGap : 0))
            }
        }
        .overlay { if model.sheet != nil { sheet } }
        .confirmationDialog("删除 #\(model.deletingMessage?.seq ?? 0)？", isPresented: Binding(get: { model.deletingMessage != nil }, set: { if !$0 { model.deletingMessage = nil } }), presenting: model.deletingMessage) { message in
            Button("Delete", role: .destructive) { model.delete(message: message.seq, tell: false) }
            if message.to.contains(where: { $0 != Room.you }) {
                Button("Delete and Tell Members") { model.delete(message: message.seq, tell: true) }
            }
            if message.from != Room.you || message.to.contains(where: { $0 != Room.you }) {
                Button("Recall and Rewind Members") { model.recall(message: message.seq) }
            }
        } message: { message in
            Text(message.to.contains(where: { $0 != Room.you }) || message.from != Room.you
                 ? "文字和附件链接会删掉，原位置留「这条消息已删除」。还没送到的成员不会再收到。「Delete and Tell Members」会发一句让已收到的成员忽略它。「Recall and Rewind Members」会把发它的成员退回到发之前、收到它的成员退回到收到之前（只退对话，代码不动；Claude Code、Codex、pi 会在新终端里接着跑，OpenCode 原地退回），其余的成员发一句让它们忽略。"
                 : "文字和附件链接会删掉，原位置留「这条消息已删除」。")
        }
        .sheet(isPresented: Binding(get: { model.filesBack != nil }, set: { if !$0 { model.filesBack = nil } })) {
            if let back = model.filesBack { FilesBackSheet(handle: back.handle, files: back.files, put: { model.putFilesBack(back.handle, force: $0) }, cancel: { model.filesBack = nil }) }
        }
        .confirmationDialog("解散“\(model.room?.room.name ?? "")”？", isPresented: $model.deleting) {
            Button("Dissolve", role: .destructive) { model.delete() }
        } message: {
            Text("房间、里面的消息和共享文件夹一并删除（文件夹进废纸篓）。为这个房间新开的会话一起结束，对话记录留着可以恢复；原本就在跑的会话不受影响。")
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
            case .avatar: RoomAvatarSheet(model: model)
            case .words: RoomWordsSheet(model: model)
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
                PartLabel("Rooms").lineLimit(1).fixedSize()
                Spacer(minLength: 4)
                Button { model.open(.models) } label: { BracketLabel(word: "Models") }.buttonStyle(BracketButtonStyle(size: 12))
                    .help("管理员会话拉人时，每个配置下哪些模型能用。")
                Button { model.open(.new) } label: { BracketLabel(word: "New") }.buttonStyle(BracketButtonStyle(size: 12)).help("New Room")
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            RoomAttentionEntry(model: model)
            ScrollView {
                LazyVStack(spacing: look.isClassic ? 2 : 0) {
                    ForEach(model.rooms) { room in
                        RoomListRow(room: room, current: room.id == model.selected) { model.selected = room.id }
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .background(look.isClassic ? Color.clear : Look.ground)
        .sideCard(trailing: Look.panelGap)
    }
}

private struct RoomListRow: View {
    let room: RoomSummary
    let current: Bool
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
            // The room's picture, of its members' (user #412); the 调度台 keeps its own mark.
            if !room.desk { RoomPictureView(seats: room.faces, name: room.name) }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    if room.desk {
                        LookGlyph(glyph: "◆", symbol: "person.crop.circle.badge.checkmark", size: 12).foregroundStyle(current ? Color.signal : Look.ink2).help("调度台：你和调度说话的地方")
                    }
                    Text(room.name).mono(13, weight: look.isClassic ? .semibold : .regular).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 4)
                    if room.paused { Text("Paused").mono(11).foregroundStyle(Look.faint) }
                    // Someone in it is at work (user #269).
                    if room.working > 0, !room.paused {
                        HStack(spacing: 3) {
                            BrailleSpinner(size: 11)
                            Text("工作中").font(.system(size: 11))
                        }
                        .foregroundStyle(Color.signal)
                        .help(room.working == 1 ? "1 个成员正在工作" : "\(room.working) 个成员正在工作")
                    }
                    // Sessions went many rounds without the user (§7): the mark of what waits for you, where no count stands.
                    if room.rounds != nil, room.unread == 0, !room.paused { BlinkingSquare().help("会话之间已经往返多次，没有你参与。") }
                    if room.unread > 0 { count }
                }
                Text(room.lastLine).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail)
            }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, look.isClassic ? 10 : 12)
            .padding(.vertical, look.isClassic ? 7 : 8)
            // The room open is plain to see (user #301: 好像没有选中效果？): in the classic look tinted in the signal colour, as
            // the terminals' list marks its own; a row under the pointer only a light wash.
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).fill(current ? (look.isClassic ? Color.signal.opacity(0.2) : Look.raised) : hovering ? Look.hover : Color.clear))
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
    /// The message gone to, lit a moment.
    @State private var lit: Int?

    var body: some View {
        VStack(spacing: 0) {
            if model.searching { RoomSearchBar(model: model) } else { head }
            HairRule(color: Look.line)
            if room.room.paused { banner } else if let rounds = room.room.rounds { told(rounds) }
            needs
            if let said = model.problem ?? model.error { problem(said) }
            if model.searching { RoomSearchResults(model: model, room: room) } else { timeline }
            HairRule(color: Look.line)
            RoomWriter(model: model, room: room)
        }
        .overlay(alignment: .topLeading) { if model.drawer { RoomTaskDrawer(model: model, room: room).padding(.top, 40) } }
        .overlay(alignment: .topTrailing) {
            if let handle = model.card, let seat = room.seat(handle), !seat.isUser {
                ZStack(alignment: .topTrailing) {
                    Color.clear.contentShape(Rectangle()).onTapGesture { model.card = nil }
                    RoomMemberCard(seat: seat, home: home, claim: room.claim(of: handle), setCanAdd: { model.setCanAdd($0, seat: handle) },
                                   setMuted: { model.setMuted($0, seat: handle) }, resume: { model.resume(seat: handle) },
                                   mention: { model.mention(handle) }, kick: { model.kick(seat: handle) }, end: { model.end(seat: handle, delete: $0) }, rename: { model.rename(seat: handle, to: $0) },
                                   openTerminal: seat.terminal.map { id in { model.card = nil; showTerminal(id) } }, avatar: { model.chooseAvatar(handle) },
                                   rewindSeen: { model.rewindSeen(handle) }, filesBack: { model.card = nil; model.lookAtFilesBack(handle) })
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
            // `Always Trust`: the folders on this Mac's list of trusted folders as well, so the next session started
            // in one (or below one) does not ask.
            let folders = Array(Set(asking.compactMap { $0.card?.cwd })).sorted()
            notice("\(asking.map { "@" + $0.handle }.joined(separator: " ")) 在等你确认是否信任它的文件夹，确认之前收不到消息。",
                   help: folders.joined(separator: "\n"), word: asking.count > 1 ? "Trust All" : "Trust",
                   also: folders.isEmpty ? nil : ("Always Trust", { model.trustAll(always: folders) })) { model.trustAll() }
        }
        if !ended.isEmpty {
            notice("\(ended.map { "@" + $0.handle }.joined(separator: " ")) 的会话已经结束。", help: "用同一个会话、同一个目录恢复，席位不变。",
                   word: ended.count > 1 ? "Resume All" : "Resume") { model.resumeAll() }
        }
    }

    private func notice(_ text: String, help: String, word: String, also: (String, () -> Void)? = nil, action: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            BlinkingSquare()
            Text(text).font(.system(size: 12.5)).foregroundStyle(Look.ink).lineLimit(2).help(help)
            Spacer()
            if let also {
                Button(action: also.1) { BracketLabel(word: also.0) }.buttonStyle(BracketButtonStyle(size: 12))
                    .help("以后在这些文件夹及其子文件夹中启动的会话不再询问：\n\(help)")
            }
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

    /// The room's bar (user #191: 一屏只回答一个问题): what is shown — the room, or one task of it — as a title that
    /// pulls the task drawer out; ⌕ to search it; the rest (the task table, files, notes, the room's name, pause) in
    /// one menu. Members are the window bar's 👥.
    private var head: some View {
        let task = model.taskFilter.flatMap { n in room.tasks.first { $0.n == n } }
        return HStack(spacing: 10) {
            Button { model.drawer.toggle() } label: {
                HStack(spacing: 6) {
                    if task == nil, room.room.desk != true { RoomPictureView(seats: Array(room.seats.filter { !$0.isUser && $0.left == nil }.prefix(4)), name: room.room.name, side: 24) }
                    Text(task.map { RoomTaskLabel.word($0.n, $0.title) } ?? (room.room.desk == true ? "# " : "") + room.room.name)
                        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Look.ink).lineLimit(1)
                    LookGlyph(glyph: model.drawer ? "▴" : "▾", symbol: model.drawer ? "chevron.up" : "chevron.down", size: 10).foregroundStyle(Look.ink2)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help("任务：点开选一个任务，只看它的消息（⌘T）")
            .keyboardShortcut("t", modifiers: .command)
            if let task {
                Text(["@" + (task.owner ?? "—"), RoomTaskLabel.stateWord(task.state)].joined(separator: " · ")).mono(12).foregroundStyle(Look.ink2).lineLimit(1)
                if task.state == .blocked, let note = task.note { Text(note).font(.system(size: 12)).foregroundStyle(Color.waiting).lineLimit(1).truncationMode(.tail) }
            } else if room.room.desk != true {
                // 调度台 says nothing under its name (user #227): what it is goes without saying there.
                Text(room.room.topic).font(.system(size: 12.5)).foregroundStyle(Look.ink2).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 8)
            Button { model.searching = true } label: { LookGlyph(glyph: "⌕", symbol: "magnifyingglass", size: 18).foregroundStyle(Look.ink).frame(width: 28, height: 28).contentShape(Rectangle()) }
                .buttonStyle(.plain).help("搜索\(task == nil ? "这个房间" : "这个任务")（⌘F）").keyboardShortcut("f", modifiers: .command)
            Menu {
                Button(room.tasks.isEmpty ? "Tasks…" : "Tasks \(room.tasks(.done).count)/\(room.tasks.count)…") { model.open(.tasks) }
                Button("Files…") { model.open(.files) }
                if model.redactOn { Button("Words…") { model.open(.words) } }
                // The room's own password book, a window of its own (user #416).
                Button("Passwords…") { PasswordsOpener.showRoom(model.nodeId, room.room.id, room.room.name) }
                Button(room.notes == nil ? "Notes…" : "Notes · \(room.notes!.who)…") { model.open(.notes) }
                Divider()
                Button("Edit Room…") { model.open(.edit) }
                Button(room.room.paused ? "Resume Room" : "Pause Room") { model.setPaused(!room.room.paused) }
                // 解散 (user #230); not the 调度台, which goes with the dispatch turned off.
                if room.room.desk != true {
                    Divider()
                    Button("Dissolve Room…", role: .destructive) { model.deleting = true }
                }
            } label: {
                LookGlyph(glyph: "⋯", symbol: "ellipsis", size: 18).foregroundStyle(Look.ink)
            }
            .menuStyle(.borderlessButton)
            .tint(Look.ink)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("任务表、共享文件、置顶笔记、房间设置")
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
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
                        if room.messages.first?.seq == 1 { opening }
                        ForEach(model.rows) { row in
                            if let day = row.day { RoomDayLine(day: day) }
                            RoomMessageRow(row: row, room: room, actions: RoomRowActions(card: { model.card = $0 }, reply: { model.reply(to: $0) }, reveal: model.onThisMac ? { model.reveal($0) } : nil, preview: { model.onThisMac ? model.preview(file: $0) : model.fetch(file: $0, as: .preview) }, open: model.onThisMac ? nil : { model.fetch(file: $0, as: .open) }, saveAs: model.onThisMac ? nil : { model.fetch(file: $0, as: .saveAs) }, picture: model.onThisMac ? nil : { model.picture($0) }, task: { model.taskFilter = $0 },
                                                                                       jump: { model.go(to: $0) }, inTask: model.taskFilter != nil, lit: lit == row.id, poke: { model.poke($0) }, delete: { model.deletingMessage = $0 }))
                                .id(row.id)
                        }
                        Color.clear.frame(height: 1).id("end")
                            .onAppear { atEnd = true; unseen = false }
                            .onDisappear { atEnd = false }
                    }
                    .padding(.top, 10)
                    .padding(.bottom, 14)
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom); if let seq = model.jump { goTo(seq, proxy) } }
                .onChange(of: room.room.id) { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: model.taskFilter) { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: model.jump) { if let seq = model.jump { goTo(seq, proxy) } }
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

    /// A message gone to: brought to the middle and lit a moment.
    private func goTo(_ seq: Int, _ proxy: ScrollViewProxy) {
        model.jump = nil
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            withAnimation(.snappy(duration: 0.25)) { proxy.scrollTo(seq, anchor: .center) }
            lit = seq
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.easeOut(duration: 0.4)) { if lit == seq { lit = nil } }
        }
    }

    /// The room's first words, over its first message (Discord's channel start): its name, its topic, where it begins.
    private var opening: some View {
        let task = model.taskFilter.flatMap { n in room.tasks.first { $0.n == n } }
        return VStack(alignment: .leading, spacing: 6) {
            Text(task.map { RoomTaskLabel.word($0.n, $0.title) } ?? "# " + room.room.name).font(.system(size: 20, weight: .bold)).foregroundStyle(Look.ink)
            let desk = task == nil && room.room.desk == true
            if let detail = task.map({ $0.detail }) ?? (room.room.topic.isEmpty || desk ? nil : room.room.topic) {
                Text(detail).font(.system(size: 13)).foregroundStyle(Look.ink2).fixedSize(horizontal: false, vertical: true)
            }
            if !desk {
                Text(task == nil ? "这是房间「\(room.room.name)」的开始。" : "这是这个任务的消息。在这里发的话都算它的。").font(.system(size: 12.5)).foregroundStyle(Look.faint)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 10)
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
                // `+`: files; in a room with tasks, the task this message is about too (user #438: `Task: —` under the
                // box was in the way — it shows there only once a task is chosen).
                if room.tasks.isEmpty || model.taskFilter != nil {
                    Button { model.pickFiles() } label: { plus }
                        .buttonStyle(.plain)
                        .help(model.uploading > 0 ? "正在上传…" : "Attach Files")
                } else {
                    Menu {
                        Button("Attach Files…") { model.pickFiles() }
                        Menu("Task") { taskChoices }
                    } label: { plus }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help(model.uploading > 0 ? "正在上传…" : "Attach Files, Task")
                }
                ComposeField(text: $model.draft, height: $model.draftHeight, focusRequests: model.focusRequests, insert: model.insert, label: "Message",
                             placeholder: placeholder, replace: model.replace, onKey: { model.key($0) }, onCaret: { model.caretMoved($0, $1) },
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
            if model.taskFilter == nil, model.draftTask != nil || room.room.paused {
                HStack(spacing: 12) {
                    if model.draftTask != nil { taskPicker }
                    if room.room.paused { Text("Paused") }
                }
                .font(.system(size: 11.5))
                .foregroundStyle(Look.faint)
            }
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

    /// Where the message goes, said in the box (user #191): the task shown, or the room.
    private var placeholder: String {
        if room.room.desk == true { return "跟调度说要做什么…" }
        if let n = model.taskFilter { return "发消息到 " + RoomTaskLabel.word(n, room.tasks.first { $0.n == n }?.title) + "…  @ 唤醒成员" }
        return "发消息到 \(room.room.name)…  @ 唤醒成员"
    }

    /// Which task the next message is about (2026-11-24): taken from the message answered or the task the timeline
    /// shows; the user can change it or say none.
    private var plus: some View {
        LookGlyph(glyph: "+", symbol: "plus", size: 15).foregroundStyle(Look.ink2).frame(width: 30, height: look.isClassic ? 30 : 34).contentShape(Rectangle())
    }

    @ViewBuilder private var taskChoices: some View {
        Button("No Task") { model.draftTask = nil }
        Divider()
        ForEach(room.tasks.filter { $0.state != .done || $0.n == model.draftTask }) { task in
            Button(RoomTaskLabel.word(task.n, task.title)) { model.draftTask = task.n }
        }
    }

    private var taskPicker: some View {
        Menu { taskChoices } label: {
            Text(model.draftTask.map { n in "Task: " + RoomTaskLabel.word(n, room.tasks.first { $0.n == n }?.title) } ?? "Task: —")
                .mono(11.5).foregroundStyle(model.draftTask == nil ? Look.faint : Look.ink2)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .tint(model.draftTask == nil ? Look.faint : Look.ink2)
        .fixedSize()
        .help("这条消息属于哪个任务。回复时沿用原消息的任务。")
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
            Text("只有 @ 到的成员会被唤醒").font(.system(size: 11)).foregroundStyle(Look.faint).padding(.horizontal, 10).padding(.top, 2).padding(.bottom, 4)
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
        .background(look.isClassic ? Color.clear : Look.ground)
        .sideCard(leading: Look.panelGap, trailing: Look.panelGap)
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
        case .avatar: "Avatar"
        case .words: "Words"
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
        case .notes, .tasks, .files, .models, .avatar, .words: false
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
                if kind == .edit, model.room?.room.desk != true {
                    Button { model.sheet = nil; model.deleting = true } label: { BracketLabel(word: "Dissolve…") }.buttonStyle(BracketButtonStyle(role: .destructive))
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


/// 退代码 (user #290): what putting a member's files back to before its last rewind would do, asked before it is done.
private struct FilesBackSheet: View {
    let handle: String
    let files: [RewindFile]
    let put: (Bool) -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("把 @\(handle) 的文件退回到它退回的那一刻？").font(.headline)
            Text("只退它自己用 Write/Edit 改过的文件，命令行改的不算。之后又被别人改过的文件，默认不动。").font(.callout).foregroundStyle(.secondary)
            if files.isEmpty {
                Text("它在那之后没有改过文件。").foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(files) { f in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(Self.word(f)).font(.caption.weight(.semibold)).foregroundStyle(Self.tint(f)).frame(width: 52, alignment: .leading)
                                Text(f.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                                if f.changed { Text("之后被改过").font(.caption).foregroundStyle(.orange) }
                            }
                        }
                    }
                }
                .frame(minHeight: 80, maxHeight: 280)
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                if files.contains(where: { $0.changed && $0.unknown != true }) {
                    Button("Restore All, Including Changed") { put(true) }
                }
                Button("Restore") { put(false) }.keyboardShortcut(.defaultAction).disabled(files.allSatisfy { $0.changed || $0.unknown == true })
            }
        }
        .padding(20)
        .frame(width: 560)
    }

    private static func word(_ f: RewindFile) -> String { f.unknown == true ? "无法恢复" : f.action == "remove" ? "删除" : "恢复" }
    private static func tint(_ f: RewindFile) -> Color { f.unknown == true ? .secondary : f.action == "remove" ? .red : .accentColor }
}
