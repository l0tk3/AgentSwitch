import AgentSwitchKit
import PhotosUI
import SwiftUI

/// One room (docs/chatroom-v0.md §10; its second version, design-room-ui-v2): its timeline and the box the user writes
/// in. The timeline reads as a chat's: one head per speaker — face, name, agent, time — with what they say under it,
/// no frames; a reply's quote in one line; on the user's own message for others, how many have read it. Each task of
/// the room's list is like a channel: the title (`T3 登录接口 ▾`) or a swipe from the left pulls out the task drawer,
/// and a task picked narrows the timeline to it. ⌕ searches, 👥 opens the members. The room is read again every few
/// seconds while the page is on screen, and what is in it is then seen.
struct RoomPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var model: RoomPageModel
    /// The members sheet; with a handle, that member's card first.
    @State private var members: MembersRequest?
    @State private var adding = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var notes = false
    @State private var tasks = false
    /// The tasks sheet opens on a new task (`+ 新任务` in the drawer).
    @State private var newTask = false
    @State private var files = false
    @State private var secrets = false
    @State private var drawer = false
    @State private var searching = false
    /// A file of the shared folder's sheet asked for on the Files page (`Show in Files`): shown there once the sheet is gone.
    @State private var fileToShow: String?
    /// The reader is at the timeline's end; `unseen`: a message came while they were not.
    @State private var atEnd = true
    @State private var unseen = false
    @State private var visibleHeight: CGFloat = 0
    /// A message marked for a moment, once brought into view.
    @State private var flash: Int?
    /// Where the page was asked to open (等你处理): a task, a message, a member's card; taken once.
    @State private var opening: RoomRoute.Open?
    @FocusState private var writing: Bool

    struct MembersRequest: Identifiable {
        let id = UUID()
        var card: String?
    }

    init(id: String, detail: RoomDetail? = nil, open: RoomRoute.Open? = nil) {
        _model = State(initialValue: RoomPageModel(id: id, detail: detail))
        _opening = State(initialValue: open)
    }

    var body: some View {
        let detail = model.detail
        VStack(spacing: 0) {
            HairRule()
            if let detail, detail.room.paused { pausedBanner } else if let n = detail?.room.rounds { roundsBanner(n) }
            if let error = model.error {
                ErrorText(message: Binding(get: { model.error }, set: { model.error = $0 }))
                    .padding(.horizontal, Theme.Space.l).padding(.vertical, 6).id(error)
            }
            if let detail { timeline(detail) } else { Spacer(minLength: 0) }
        }
        .background { ZStack { Theme.base; if !look.isClassic { Scanlines() } }.ignoresSafeArea() }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let detail {
                RoomWriter(model: model, seats: detail.seats, writing: $writing) { Task { await model.send(app.api) } }
            }
        }
        .overlay {
            if drawer {
                RoomTaskDrawer(model: model, close: { withAnimation(.easeOut(duration: 0.2)) { drawer = false } },
                               newTask: { withAnimation(.easeOut(duration: 0.2)) { drawer = false }; newTask = true; tasks = true })
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) { titleButton(detail) }
            ToolbarItem(placement: .primaryAction) {
                Button { searching = true } label: {
                    if look.isClassic { Image(systemName: "magnifyingglass") } else { Text("⌕").font(.system(size: 19, weight: .medium, design: .monospaced)).foregroundStyle(Theme.ink) }
                }
                .accessibilityLabel("搜索")
                .disabled(detail == nil)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { members = MembersRequest() } label: {
                    if look.isClassic { Image(systemName: "person.2") } else { PixelSprite(rows: RoomArt.people, pixel: 2, color: Theme.ink) }
                }
                .accessibilityLabel("Members")
                .disabled(detail == nil)
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if detail?.room.paused == true {
                        Button("Resume", systemImage: "play") { Task { await model.run(app.api) { try await $0.updateRoom(model.id, paused: false) } } }
                    } else {
                        Button("Pause", systemImage: "pause") { Task { await model.run(app.api) { try await $0.updateRoom(model.id, paused: true) } } }
                    }
                    Button(detail?.notes == nil ? "Notes" : "Notes ·", systemImage: "pin") { notes = true }
                    Button(detail.map { $0.openTasks > 0 ? "Tasks · \($0.openTasks)" : "Tasks" } ?? "Tasks", systemImage: "checklist") { newTask = false; tasks = true }
                    Button("Files", systemImage: "folder") { files = true }
                    Button(detail.map { $0.secrets > 0 ? "Secrets · \($0.secrets)" : "Secrets" } ?? "Secrets", systemImage: "key") { secrets = true }
                    Button("Add Sessions…", systemImage: "plus") { adding = true }
                    Button("Rename…", systemImage: "pencil") { editing = true }
                    Section { Button("Delete Room…", systemImage: "trash", role: .destructive) { confirmDelete = true } }
                } label: { LookGlyph.more }
                .tint(look.isClassic ? Theme.signal : Theme.ink)
                .accessibilityLabel("More")
                .disabled(detail == nil)
            }
        }
        .task(id: app.connection.endpoint) {
            while !Task.isCancelled {
                await model.refresh(app.api)
                try? await Task.sleep(for: RoomPageModel.pollInterval)
            }
        }
        // Asked to open somewhere (等你处理): once the room is there.
        .onChange(of: model.detail != nil, initial: true) { _, here in if here { openAsked() } }
        // Deleted, here or from another screen: back to the list.
        .onChange(of: model.gone) { _, gone in if gone { Task { await app.rooms.refresh(app.api) }; dismiss() } }
        .onDisappear { Task { await app.rooms.refresh(app.api) } }
        .sheet(item: $members) { asked in
            RoomMembersSheet(model: model, opening: asked.card, add: { adding = true }, mention: { mention($0) }).followsLook()
        }
        .sheet(isPresented: $adding) {
            RoomSessionsSheet(purpose: .add(room: model.id, seated: Set(detail?.sessions.compactMap(\.terminal) ?? []))) { _ in
                Task { await model.run(app.api) { _ in } }
            }
            .followsLook()
        }
        .sheet(isPresented: $editing) {
            RoomEditSheet(name: detail?.room.name ?? "", topic: detail?.room.topic ?? "") { name, topic in
                await model.run(app.api) { try await $0.updateRoom(model.id, name: name, topic: topic) }
            }
            .followsLook()
        }
        .sheet(isPresented: $notes) {
            RoomNotesSheet(notes: detail?.notes) { text in
                await model.run(app.api) { try await $0.setRoomNotes(model.id, text: text) }
            }
            .followsLook()
        }
        .sheet(isPresented: $tasks) {
            RoomTasksSheet(model: model, addingAtOpen: newTask || Self.sampleScreen == "roomtaskadd").followsLook()
        }
        .sheet(isPresented: $files, onDismiss: { if let path = fileToShow { fileToShow = nil; showFile(path) } }) {
            RoomFilesSheet(room: model.id, folder: detail?.folder ?? "") { fileToShow = $0 }.followsLook()
        }
        .sheet(isPresented: $secrets) { RoomSecretsSheet(model: model).followsLook() }
        .sheet(isPresented: $searching) {
            RoomSearchPage(model: model, initial: Self.sampleScreen == "roomsearch" ? "接口" : "") { seq in
                Task { await model.reveal(seq, api: app.api) }
            }
            .followsLook()
        }
        #if DEBUG
        // The sample screens' sheets, as taps would open them.
        .onAppear {
            guard DemoRooms.isDemo else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                switch DemoRooms.screen {
                case "roommembers": members = MembersRequest()
                case "roomcard": members = MembersRequest(card: "android")
                case "roomavatar", "roomavatarclassic": members = MembersRequest(card: "daemon")
                case "roomadd": adding = true
                case "roomnotes": notes = true
                case "roomtasks", "roomtaskadd": tasks = true
                case "roomfiles": files = true
                case "roomsecrets": secrets = true
                case "roomdrawer": withAnimation { drawer = true }
                case "roomsearch": searching = true
                case "roomtask": model.taskFilter = 4
                default: break
                }
            }
        }
        #endif
        .pixelBox(isPresented: $confirmDelete) {
            PixelBox(head: "Delete Room", tone: .red, message: "删除“\(detail?.room.name ?? "")”？房间里的消息一并删除，无法恢复。成员的会话不受影响。",
                     actions: [.init(label: "Delete", role: .destructive) { Task { await model.delete(app.api) } }])
        }
    }

    /// What is being looked at — the task (`T3 登录接口 ▾`, its owner and state under it) or the room — and the way to
    /// the drawer.
    private func titleButton(_ detail: RoomDetail?) -> some View {
        let task = model.taskFilter.flatMap { n in detail?.tasks.first { $0.n == n } }
        return Button { withAnimation(.easeOut(duration: 0.2)) { drawer.toggle() } } label: {
            VStack(spacing: 1) {
                HStack(spacing: 4) {
                    Text(model.taskFilter.map { RoomMessage.taskWord($0, task?.title) } ?? detail?.room.name ?? "Room")
                        .font(.headline).foregroundStyle(Theme.ink).lineLimit(1)
                    LookGlyph.fold(open: drawer, size: 11).foregroundStyle(Theme.secondaryInk)
                }
                if let task {
                    HStack(spacing: 0) {
                        Text((task.owner.map { $0 == RoomSeat.you ? "你" : "@" + $0 } ?? "没人认领") + " · ")
                            .foregroundStyle(.secondary)
                        Text(task.state.says).foregroundStyle(task.state == .blocked ? Theme.waiting : .secondary)
                    }
                    .mono(11).lineLimit(1)
                } else if let detail {
                    let n = detail.sessions.count
                    Text("\(n) \(n == 1 ? "Session" : "Sessions")\(detail.room.paused ? " · Paused" : "")").mono(11).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("任务")
        .accessibilityHint("拉出任务列表")
    }

    /// Messages are written and not handed over (§2 暂停).
    private var pausedBanner: some View {
        HStack(spacing: 10) {
            SeatStateMark(state: .waiting)
            Text("房间已暂停。消息照写，不投递。").font(.system(size: 13)).foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .leading)
            Button { Task { await model.run(app.api) { try await $0.updateRoom(model.id, paused: false) } } } label: { ButtonWord("Resume") }
                .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 8)
        .background(Theme.waiting.opacity(0.14))
        .overlay(alignment: .bottom) { HairRule() }
    }

    /// Sessions have gone back and forth this many times with no word from the user (§7; 2026-11-22, user: 多轮没我的
    /// 参与就提醒我一下就行不用中断他们): told, with `OK` to count again from here and `Pause` to stop the handing over.
    private func roundsBanner(_ n: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                SeatStateMark(state: .waiting)
                Text(RoomInfo.roundsSays(n)).font(.system(size: 13)).foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Theme.Space.s) {
                Spacer(minLength: 0)
                Button { Task { await model.run(app.api) { try await $0.updateRoom(model.id, paused: true) } } } label: { ButtonWord("Pause") }
                    .buttonStyle(SquareButtonStyle(expand: false))
                Button { Task { await model.run(app.api) { try await $0.roundsSeen(model.id) } } } label: { ButtonWord("OK") }
                    .buttonStyle(SquareButtonStyle(prominent: true, expand: false))
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 8)
        .background(Theme.waiting.opacity(0.14))
        .overlay(alignment: .bottom) { HairRule() }
    }

    private func timeline(_ detail: RoomDetail) -> some View {
        let messages = model.shown
        let rows = RoomRow.rows(messages)
        let handles = RoomText.handles(of: detail.seats)
        let task = model.taskFilter.flatMap { n in detail.tasks.first { $0.n == n } }
        // The room's beginning is on the page: its first message, or none yet.
        let atStart = model.taskFilter == nil && (messages.first.map { $0.seq <= 1 } ?? true)
        return ScrollViewReader { proxy in
            ScrollView {
                // Not lazy (2026-11-24, user: 白屏bug): a lazy stack guesses the heights of rows it has not drawn,
                // and a jump to its end as the keyboard came up landed past what was drawn — an empty screen
                // until it was dragged. A room holds a few hundred messages at most: laid out whole, the end is
                // where it is.
                VStack(alignment: .leading, spacing: 0) {
                    if let task {
                        RoomTaskCard(task: task, detail: detail)
                    } else if atStart {
                        RoomOpening(detail: detail)
                    }
                    if rows.isEmpty { empty(detail) }
                    ForEach(rows) { row in
                        RoomMessageRow(row: row, detail: detail, handles: handles,
                                       quoted: row.message.replyTo.flatMap { model.message($0) },
                                       forMe: row.message.to.contains(RoomSeat.you) && row.message.seq > (model.seenAtOpen ?? .max),
                                       tagTask: model.taskFilter == nil,
                                       flashing: flash == row.id,
                                       openCard: { members = MembersRequest(card: $0) },
                                       reply: { model.replyTo = row.message.seq; writing = true },
                                       mention: { mention($0) },
                                       openFile: { showFile($0) },
                                       openTask: { n in withAnimation(.easeOut(duration: 0.15)) { model.taskFilter = n } },
                                       jump: { seq in Task { await model.reveal(seq, api: app.api) } })
                            .id(row.id)
                    }
                    Color.clear.frame(height: 8).id("end").reportsListEnd(in: "roomTimeline")
                }
            }
            .coordinateSpace(name: "roomTimeline")
            .background(GeometryReader { g in Color.clear.onAppear { visibleHeight = g.size.height }.onChange(of: g.size.height) { _, h in visibleHeight = h } })
            .onPreferenceChange(ListEndY.self) { endY in
                let now = visibleHeight == 0 || endY <= visibleHeight + 40
                if now != atEnd { withAnimation(.easeOut(duration: 0.15)) { atEnd = now } }
                if now { unseen = false }
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            // A swipe to the right from the page's left part pulls out the task drawer (the very edge is the way back).
            .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { drag in
                guard drag.startLocation.x < 140, drag.translation.width > 70, abs(drag.translation.height) < 50 else { return }
                withAnimation(.easeOut(duration: 0.2)) { drawer = true }
            })
            .onChange(of: messages.last?.seq) {
                if atEnd || messages.last?.from == RoomSeat.you { withAnimation(nil) { proxy.scrollTo("end", anchor: .bottom) } } else { unseen = true }
            }
            .onChange(of: model.taskFilter) { DispatchQueue.main.async { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: model.focus) { _, seq in
                guard let seq else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.snappy(duration: 0.25)) { proxy.scrollTo(seq, anchor: .center) }
                    flash = seq
                    model.focus = nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { withAnimation(.easeOut(duration: 0.4)) { if flash == seq { flash = nil } } }
                }
            }
            .onChange(of: writing) { _, on in if on && atEnd { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { proxy.scrollTo("end", anchor: .bottom) } } }
            .overlay(alignment: .bottomTrailing) {
                if !atEnd && !rows.isEmpty {
                    LatestButton(unseen: unseen) { unseen = false; withAnimation(.snappy(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) } }
                        .padding(.trailing, Theme.Space.l)
                }
            }
        }
    }

    private func empty(_ detail: RoomDetail) -> some View {
        let first = detail.sessions.first?.handle
        return VStack(spacing: 10) {
            if model.taskFilter != nil {
                Text("这个任务里还没有消息。在这里发的消息都属于它。").font(.system(size: 13)).foregroundStyle(Theme.inkDim).multilineTextAlignment(.center)
            } else if let first {
                Text("写一句并用 @ 指定收件人，例如：\n@\(first) 现在在做什么").font(.system(size: 13)).foregroundStyle(Theme.inkDim).multilineTextAlignment(.center)
            } else {
                Text("房间里还没有会话。点右上角 ⋯ 里的 Add Sessions，把正在运行的会话拉进来。").font(.system(size: 13)).foregroundStyle(Theme.inkDim).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 40)
        .padding(.vertical, 24)
    }

    /// Where 等你处理 asked the page to open, once.
    private func openAsked() {
        guard let open = opening else { return }
        opening = nil
        if let task = open.task { model.taskFilter = task }
        if let seq = open.seq { Task { await model.reveal(seq, api: app.api) } }
        if let card = open.card { members = MembersRequest(card: card) }
    }

    /// A file by where it is on the Mac — one a message came with from outside the shared folder, or any `Show in
    /// Files`: the folder it is in, on the Files page.
    private func showFile(_ path: String) { app.showInFiles(MacPath.parent(path) ?? path) }

    /// The sample screen asked for; nil with a real Mac.
    private static var sampleScreen: String? {
        #if DEBUG
        return DemoRooms.isDemo ? DemoRooms.screen : nil
        #else
        return nil
        #endif
    }

    /// `@name` put at the end of what is being written.
    private func mention(_ handle: String) {
        guard handle != RoomSeat.you else { return }
        let draft = model.draft
        model.draft = draft + (draft.isEmpty || draft.hasSuffix(" ") || draft.hasSuffix("\n") ? "" : " ") + "@\(handle) "
        writing = true
    }
}

/// One message of the timeline (design v2): face, name, agent, time — and in `# 全部` its task's tag — on one line;
/// the quote of what it answers; what it says, whole, in Markdown; and on the user's own message for others, how
/// many have read it.
private struct RoomMessageRow: View {
    let row: RoomRow
    let detail: RoomDetail
    let handles: Set<String>
    /// The message it answers, wherever the page has it.
    let quoted: RoomMessage?
    /// It names the user and came after what the user had seen: marked amber (amber is what waits for you).
    let forMe: Bool
    /// `# 全部`: a message about a task says which (`T3`) after the name.
    let tagTask: Bool
    /// Just brought into view (a search's hit, a quote tapped): marked for a moment.
    let flashing: Bool
    let openCard: (String) -> Void
    let reply: () -> Void
    let mention: (String) -> Void
    /// A file a message came with, by where it is on the node.
    let openFile: (String) -> Void
    /// The timeline narrowed to a task's messages (its tag tapped).
    let openTask: (Int) -> Void
    /// The message a quote stands for, brought into view.
    let jump: (Int) -> Void
    @Environment(\.interfaceLook) private var look

    private static let faceSide: CGFloat = 30

    var body: some View {
        let m = row.message
        let seat = detail.seat(m.from)
        VStack(alignment: .leading, spacing: 0) {
            if row.newDay { day(m.date) }
            HStack(alignment: .top, spacing: 10) {
                if row.continues {
                    Color.clear.frame(width: Self.faceSide, height: 1)
                } else {
                    Button { openCard(m.from) } label: { RoomFaceView(seat: seat, handle: m.from, side: Self.faceSide) }
                        .buttonStyle(.plain).allowsHitTesting(m.from != RoomSeat.you).padding(.top, 2)
                }
                VStack(alignment: .leading, spacing: 3) {
                    if !row.continues { head(m, seat) }
                    if let n = m.replyTo { quote(n) }
                    Text(RoomWords.text(m.text, handles: handles, look: look))
                        .font(.system(size: 15)).foregroundStyle(Theme.ink).lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    if !m.files.isEmpty { RoomMessageFiles(room: detail.room.id, folder: detail.folder, paths: m.files, showInFiles: openFile) }
                    readers(m)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, row.continues ? 2 : 12)
            .padding(.bottom, 2)
            .background(flashing ? Theme.signal.opacity(0.14) : forMe && look.isClassic ? Theme.waiting.opacity(0.09) : Color.clear)
            .overlay(alignment: .leading) { if forMe { Theme.waiting.frame(width: 3) } }
            .contentShape(Rectangle())
            .contextMenu {
                Button("Reply", systemImage: "arrowshape.turn.up.left") { reply() }
                if m.from != RoomSeat.you, seat?.here == true { Button("Mention", systemImage: "at") { mention(m.from) } }
                if tagTask, let n = m.task { Button("只看 T\(n)", systemImage: "number") { openTask(n) } }
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = m.text }
            }
        }
    }

    /// A line across with the day in it: `今天`, `昨天`, `11月24日`.
    private func day(_ date: Date) -> some View {
        HStack(spacing: 10) {
            HairRule()
            Text(RoomWords.day(date)).mono(11.5).foregroundStyle(Theme.inkDim).fixedSize()
            HairRule()
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 0)
    }

    /// Who and when, nothing more (2026-11-22, user: 聊天中的信息展示能不能精简一些): the agent is the picture beside the
    /// name; the model, the folder and the mode are on the card.
    private func head(_ m: RoomMessage, _ seat: RoomSeat?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Button { openCard(m.from) } label: {
                Text(RoomWords.who(m.from)).font(.system(size: look.isClassic ? 15 : 14, weight: .semibold, design: look.isClassic ? .default : .monospaced))
                    .foregroundStyle(nameColor(seat)).lineLimit(1)
            }
            .buttonStyle(.plain).allowsHitTesting(m.from != RoomSeat.you)
            if let agent = seat?.card?.agent, !agent.isEmpty { RoomAgentMark(agent: agent) }
            if tagTask, let n = m.task { taskTag(n) }
            Text(RoomWords.time(m.date)).mono(11.5).foregroundStyle(Theme.inkDim)
        }
    }

    /// The name in the face's colour in the classic look (as a chat's names are); ink in the pixel one.
    private func nameColor(_ seat: RoomSeat?) -> Color {
        guard look.isClassic else { return Theme.ink }
        // The ground of its chosen emoji, else its face's.
        if let classic = seat?.avatar?.classic { return Color(light: classic.rgb(dark: false), dark: classic.rgb(dark: true)) }
        guard let face = seat?.face else { return Theme.ink }
        return Color(light: face.rgb(dark: false), dark: face.rgb(dark: true))
    }

    /// A message's task in `# 全部`: a small `T3`; a tap shows that task alone.
    private func taskTag(_ n: Int) -> some View {
        Button { openTask(n) } label: {
            Text("T\(n)").mono(10.5, weight: .medium).foregroundStyle(Theme.secondaryInk).lineLimit(1)
                .padding(.horizontal, 4).padding(.vertical, 0.5)
                .grounded(look.isClassic ? Theme.panel : Color.clear, radius: 4)
                .framed(Theme.line, radius: look.isClassic ? 4 : 0)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("只看 T\(n) " + (detail.tasks.first { $0.n == n }?.title ?? ""))
    }

    /// What it answers in one line: its author and its first words, as Markdown; a tap brings it into view.
    private func quote(_ n: Int) -> some View {
        Button { jump(n) } label: {
            HStack(spacing: 6) {
                if look.isClassic { Theme.line.frame(width: 2, height: 14) } else { Text("┌").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.inkDim) }
                if let quoted {
                    (Text(RoomWords.who(quoted.from) + "：").font(.system(size: 12.5, weight: .semibold)) + Text(RoomWords.inline(RoomRow.quoteLine(quoted.text), size: 12.5)))
                        .foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Text("#\(n)").mono(12).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("回复 \(quoted.map { RoomWords.who($0.from) } ?? "#\(n)")")
    }

    /// On the user's own message for others: `2/3 已读`, at its foot on the right; a long press says who has and who
    /// has not, and where the message stands for each.
    @ViewBuilder private func readers(_ m: RoomMessage) -> some View {
        let who = RoomReaders.of(m, in: detail)
        if who.total > 0 {
            let lines = Dictionary(RoomReceiptLine.lines(m, in: detail).map { ($0.handle, $0) }, uniquingKeysWith: { a, _ in a })
            let failed = who.unread.contains { lines[$0]?.failed == true }
            HStack {
                Spacer(minLength: 0)
                Text(who.word).mono(11).foregroundStyle(failed ? Theme.failed : who.unread.isEmpty ? Theme.inkDim : Theme.secondaryInk)
                    .padding(.vertical, 2).padding(.leading, 12)
                    .contentShape(Rectangle())
                    .contextMenu {
                        ForEach(who.read, id: \.self) { h in Text("✓ \(h) 已读") }
                        ForEach(who.unread, id: \.self) { h in
                            if let line = lines[h] { Text("\(line.tick) \(h) · \(ClassicWords.word(line.word, in: look))") } else { Text("○ \(h) 未读") }
                        }
                    }
                    .accessibilityLabel(who.word)
            }
        }
    }
}

/// The box the user writes in: the `@name` being typed offers the members, a reply says what it answers. Beside it,
/// the pictures of this phone: picked in the system's picker, they wait above the box and go with the message.
private struct RoomWriter: View {
    let model: RoomPageModel
    let seats: [RoomSeat]
    var writing: FocusState<Bool>.Binding
    let send: () -> Void
    @Environment(\.interfaceLook) private var look
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        @Bindable var model = model
        let offers = RoomMention.query(model.draft).map { RoomMention.offers($0, seats: seats) } ?? []
        VStack(alignment: .leading, spacing: 6) {
            if !offers.isEmpty { picker(offers) }
            if let n = model.replyTo { replying(n) }
            if model.sendError != nil { ErrorText(message: $model.sendError) }
            RoomAttachmentStrip(model: model)
            HStack(alignment: .bottom, spacing: 6) {
                Button { pickingPhotos = true } label: {
                    LookGlyph(glyph: "+", symbol: "plus", size: 19, weight: .medium, scale: 0.95)
                        .foregroundStyle(Theme.secondaryInk).frame(width: 34, height: 34).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.sending || model.preparing || model.attachmentRoom == 0)
                .opacity(model.attachmentRoom == 0 ? 0.4 : 1)
                .accessibilityLabel("Add Photos")
                TextField(placeholder, text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused(writing)
                    .padding(.vertical, 7)
                Button(action: send) {
                    if model.sending {
                        BrailleSpinner(color: Theme.base)
                    } else if look.isClassic {
                        Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                    } else {
                        Text("→").font(.system(size: 16, weight: .bold, design: .monospaced))
                    }
                }
                .buttonStyle(SquareIconButtonStyle(active: model.canSend || model.sending, side: 34))
                .disabled(!model.canSend)
                .accessibilityLabel("Send")
            }
            .padding(.leading, 4)
            .padding(.trailing, 3)
            .padding(.vertical, 3)
            .grounded(look.isClassic ? Theme.panel : Color.clear, radius: look.isClassic ? 21 : 0)
            .framed(Theme.line, radius: look.isClassic ? 21 : 0)
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, Theme.Space.s)
        .background(alignment: .top) {
            VStack(spacing: 0) { Theme.line.frame(height: 1); Theme.base }.ignoresSafeArea(.container, edges: .bottom)
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: max(1, model.attachmentRoom), matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await model.attach(await PickedFiles.photos(items)) }
        }
    }

    /// Where what is written goes: `发消息到 T3 登录接口…`, or to the room.
    private var placeholder: String {
        if let n = model.taskFilter { return "发消息到 " + RoomMessage.taskWord(n, model.detail?.tasks.first { $0.n == n }?.title) + "…" }
        // The dispatch desk: what the user says is for the dispatch, with no `@`.
        if model.detail?.room.desk == true { return "跟调度说要做什么…" }
        return "发消息到 \(model.detail?.room.name ?? "房间")…"
    }

    private func replying(_ n: Int) -> some View {
        HStack(spacing: 8) {
            if look.isClassic { Image(systemName: "arrowshape.turn.up.left").font(.system(size: 12)) } else { PixelSprite(rows: RoomArt.reply, pixel: 2, color: Theme.secondaryInk) }
            Text("回复 \(RoomWords.who(model.message(n)?.from ?? "#\(n)"))").mono(12).lineLimit(1)
            Spacer(minLength: 0)
            Button { model.replyTo = nil } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 15) }
                .buttonStyle(.plain).accessibilityLabel("Close")
        }
        .foregroundStyle(.secondary)
    }

    /// The members the `@name` being typed may become, the newest-seated last, then `all`.
    private func picker(_ offers: [String]) -> some View {
        VStack(spacing: 0) {
            Text("只有被 @ 的成员会被唤醒").mono(11).foregroundStyle(Theme.inkDim)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.top, 7).padding(.bottom, 3)
            ForEach(offers.suffix(6), id: \.self) { handle in
                let seat = seats.first { $0.handle == handle }
                Button { model.draft = RoomMention.complete(model.draft, with: handle) } label: {
                    HStack(spacing: 10) {
                        if handle == RoomSeat.all { Color.clear.frame(width: 10, height: 10) } else { SeatStateMark(state: seat?.state).frame(width: 10) }
                        if handle == RoomSeat.all { Color.clear.frame(width: 20, height: 20) } else { RoomFaceView(seat: seat, handle: handle, side: 20) }
                        Text("@\(handle)").font(.system(size: 14, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.ink)
                        Text(handle == RoomSeat.all ? "全体，只有你能用"
                             : [seat?.card.map { RoomArt.agentName($0.agent) }, seat?.state?.word(in: look)].compactMap { $0 }.joined(separator: " · "))
                            .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 0)
                        if let color = seat?.card?.color { ProfileDot(color: color) }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if handle != offers.suffix(6).last { HairRule() }
            }
        }
        .grounded(Theme.panel, radius: Theme.Radius.card)
        .framed(look.isClassic ? Theme.line : Theme.ink, radius: Theme.Radius.card)
    }
}
