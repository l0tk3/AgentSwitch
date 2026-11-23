import AgentSwitchKit
import PhotosUI
import SwiftUI

/// One room (docs/chatroom-v0.md §10): its timeline and the box the user writes in; its members from the bar. The
/// timeline is a chat's: one head per speaker — face, name, time — with what they say next under it; the message a
/// reply answers above it; under a message, one small line only while it has not reached someone. The room is read
/// again every few seconds while the page is on screen, and what is in it is then seen.
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
    @State private var files = false
    /// A file of the shared folder's sheet asked for on the Files page (`Show in Files`): shown there once the sheet is gone.
    @State private var fileToShow: String?
    /// The reader is at the timeline's end; `unseen`: a message came while they were not.
    @State private var atEnd = true
    @State private var unseen = false
    @State private var visibleHeight: CGFloat = 0
    @FocusState private var writing: Bool

    struct MembersRequest: Identifiable {
        let id = UUID()
        var card: String?
    }

    init(id: String, detail: RoomDetail? = nil) { _model = State(initialValue: RoomPageModel(id: id, detail: detail)) }

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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(detail?.room.name ?? "Room").font(.headline).lineLimit(1)
                    if let detail {
                        let n = detail.sessions.count
                        Text("\(n) \(n == 1 ? "Session" : "Sessions")\(detail.room.paused ? " · Paused" : "")").mono(11).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
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
                    Button(detail.map { $0.openTasks > 0 ? "Tasks · \($0.openTasks)" : "Tasks" } ?? "Tasks", systemImage: "checklist") { tasks = true }
                    Button("Files", systemImage: "folder") { files = true }
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
            RoomTasksSheet(model: model, addingAtOpen: Self.sampleScreen == "roomtaskadd").followsLook()
        }
        .sheet(isPresented: $files, onDismiss: { if let path = fileToShow { fileToShow = nil; showFile(path) } }) {
            RoomFilesSheet(room: model.id, folder: detail?.folder ?? "") { fileToShow = $0 }.followsLook()
        }
        #if DEBUG
        // The sample screens' sheets, as taps would open them.
        .onAppear {
            guard DemoRooms.isDemo else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                switch DemoRooms.screen {
                case "roommembers": members = MembersRequest()
                case "roomcard": members = MembersRequest(card: "android")
                case "roomadd": adding = true
                case "roomnotes": notes = true
                case "roomtasks", "roomtaskadd": tasks = true
                case "roomfiles": files = true
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
        let rows = RoomRow.rows(detail.messages)
        let handles = RoomText.handles(of: detail.seats)
        return ScrollViewReader { proxy in
            ScrollView {
                if rows.isEmpty {
                    empty(detail)
                } else {
                    // Not lazy (2026-11-24, user: 白屏bug): a lazy stack guesses the heights of rows it has not drawn,
                    // and a jump to its end as the keyboard came up landed past what was drawn — an empty screen
                    // until it was dragged. A room holds a few hundred messages at most: laid out whole, the end is
                    // where it is.
                    VStack(alignment: .leading, spacing: 0) {
                        if !detail.room.topic.isEmpty {
                            Text(detail.room.topic).font(.system(size: 12.5)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 10)
                        }
                        ForEach(rows) { row in
                            RoomMessageRow(row: row, detail: detail, handles: handles,
                                           forMe: row.message.to.contains(RoomSeat.you) && row.message.seq > (model.seenAtOpen ?? .max),
                                           openCard: { members = MembersRequest(card: $0) },
                                           reply: { model.replyTo = row.message.seq; writing = true },
                                           mention: { mention($0) },
                                           openFile: { showFile($0) })
                                .id(row.id)
                        }
                        Color.clear.frame(height: 8).id("end").reportsListEnd(in: "roomTimeline")
                    }
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
            .onChange(of: detail.messages.last?.seq) {
                if atEnd || detail.messages.last?.from == RoomSeat.you { withAnimation(nil) { proxy.scrollTo("end", anchor: .bottom) } } else { unseen = true }
            }
            .onChange(of: writing) { _, on in if on && atEnd { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { proxy.scrollTo("end", anchor: .bottom) } } }
            .overlay(alignment: .bottom) {
                if !atEnd && !rows.isEmpty {
                    LatestButton(unseen: unseen) { unseen = false; withAnimation(.snappy(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) } }
                }
            }
        }
    }

    private func empty(_ detail: RoomDetail) -> some View {
        let first = detail.sessions.first?.handle
        return VStack(spacing: 10) {
            Text("这个房间里还没有消息。").font(.system(size: 14)).foregroundStyle(.secondary)
            if let first {
                Text("写一句并用 @ 指定收件人，例如：\n@\(first) 现在在做什么").font(.system(size: 13)).foregroundStyle(Theme.inkDim).multilineTextAlignment(.center)
            } else {
                Text("房间里还没有会话。点右上角 ⋯ 里的 Add Sessions，把正在运行的会话拉进来。").font(.system(size: 13)).foregroundStyle(Theme.inkDim).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 40)
        .padding(.top, 120)
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

/// One message of the timeline.
private struct RoomMessageRow: View {
    let row: RoomRow
    let detail: RoomDetail
    let handles: Set<String>
    /// It names the user and came after what the user had seen: marked amber (amber is what waits for you).
    let forMe: Bool
    let openCard: (String) -> Void
    let reply: () -> Void
    let mention: (String) -> Void
    /// A file a message came with, by where it is on the node.
    let openFile: (String) -> Void
    @Environment(\.interfaceLook) private var look

    private static let faceSide: CGFloat = 26

    var body: some View {
        let m = row.message
        let seat = detail.seat(m.from)
        VStack(alignment: .leading, spacing: 0) {
            if row.newDay { day(m.date) }
            HStack(alignment: .top, spacing: 10) {
                if row.continues {
                    Color.clear.frame(width: Self.faceSide, height: 1)
                } else {
                    Button { openCard(m.from) } label: { RoomFaceView(face: seat?.face, you: m.from == RoomSeat.you, side: Self.faceSide) }
                        .buttonStyle(.plain).allowsHitTesting(m.from != RoomSeat.you).padding(.top, 1)
                }
                VStack(alignment: .leading, spacing: 2) {
                    if let quoted = row.quoted { quote(quoted) }
                    if !row.continues { head(m, seat) }
                    Text(RoomWords.text(m.text, handles: handles, look: look))
                        .font(.system(size: 15)).foregroundStyle(Theme.ink).lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    if !m.files.isEmpty { RoomMessageFiles(room: detail.room.id, folder: detail.folder, paths: m.files, showInFiles: openFile) }
                    receipts(m)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, row.continues ? 1 : 9)
            .padding(.bottom, 3)
            .background(forMe && look.isClassic ? Theme.waiting.opacity(0.09) : Color.clear)
            .overlay(alignment: .leading) { if forMe { Theme.waiting.frame(width: 3) } }
            .contentShape(Rectangle())
            .contextMenu {
                Button("Reply", systemImage: "arrowshape.turn.up.left") { reply() }
                if m.from != RoomSeat.you, seat?.here == true { Button("Mention", systemImage: "at") { mention(m.from) } }
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = m.text }
            }
        }
    }

    private func day(_ date: Date) -> some View {
        HStack(spacing: 10) {
            HairRule()
            Text(RoomWords.day(date)).mono(11.5).foregroundStyle(Theme.inkDim).fixedSize()
            HairRule()
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    /// Who and when, nothing more (2026-11-22, user: 聊天中的信息展示能不能精简一些): the agent is the picture beside the
    /// name; the model, the folder and the mode are on the card.
    private func head(_ m: RoomMessage, _ seat: RoomSeat?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button { openCard(m.from) } label: {
                Text(RoomWords.who(m.from)).font(.system(size: look.isClassic ? 15 : 14, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.ink).lineLimit(1)
            }
            .buttonStyle(.plain).allowsHitTesting(m.from != RoomSeat.you)
            if let agent = seat?.card?.agent, !agent.isEmpty { RoomAgentMark(agent: agent) }
            Text(RoomWords.time(m.date)).mono(11.5).foregroundStyle(Theme.inkDim)
        }
    }

    private func quote(_ quoted: RoomMessage) -> some View {
        HStack(spacing: 6) {
            if !look.isClassic { Text("┌─").font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.inkDim) }
            Text(RoomWords.who(quoted.from)).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary).fixedSize()
            Text(RoomRow.quote(quoted.text)).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.leading, look.isClassic ? 8 : 0)
        .overlay(alignment: .leading) { if look.isClassic { Theme.line.frame(width: 2) } }
        .padding(.bottom, 1)
    }

    /// Said only while it matters: who it has not reached, and where it is; one that can not be handed over, in red.
    @ViewBuilder private func receipts(_ m: RoomMessage) -> some View {
        let lines = RoomReceiptLine.lines(m, in: detail)
        if !lines.isEmpty {
            lines.enumerated().reduce(Text("")) { line, item in
                let one = Text("\(item.element.tick) \(RoomWords.who(item.element.handle)) · \(ClassicWords.word(item.element.word, in: look))")
                    .foregroundColor(item.element.failed ? Theme.failed : Theme.inkDim)
                return line + Text(item.offset == 0 ? "" : "   ") + one
            }
            .mono(11.5)
            .padding(.top, 1)
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
            HStack(alignment: .bottom, spacing: Theme.Space.s) {
                Button { pickingPhotos = true } label: {
                    if look.isClassic { Image(systemName: "photo").font(.system(size: 16, weight: .medium)) } else { PixelSprite(rows: RoomArt.picture, pixel: 2, color: Theme.secondaryInk) }
                }
                .buttonStyle(SquareIconButtonStyle(active: false))
                .disabled(model.sending || model.preparing || model.attachmentRoom == 0)
                .opacity(model.attachmentRoom == 0 ? 0.4 : 1)
                .accessibilityLabel("Add Photos")
                TextField("Message", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused(writing)
                    .padding(.horizontal, look.isClassic ? 14 : 12)
                    .padding(.vertical, 9)
                    .grounded(look.isClassic ? Theme.panel : Color.clear, radius: Theme.Radius.bubble)
                    .framed(Theme.line, radius: Theme.Radius.bubble)
                Button(action: send) {
                    if model.sending {
                        BrailleSpinner(color: Theme.base)
                    } else if look.isClassic {
                        Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                    } else {
                        Text("↑").font(.system(size: 18, weight: .bold, design: .monospaced))
                    }
                }
                .buttonStyle(SquareIconButtonStyle(active: model.canSend || model.sending))
                .disabled(!model.canSend)
                .accessibilityLabel("Send")
            }
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

    private func replying(_ n: Int) -> some View {
        HStack(spacing: 8) {
            if look.isClassic { Image(systemName: "arrowshape.turn.up.left").font(.system(size: 12)) } else { PixelSprite(rows: RoomArt.reply, pixel: 2, color: Theme.secondaryInk) }
            Text("Reply to \(RoomWords.who(model.detail?.message(n)?.from ?? "#\(n)"))").mono(12).lineLimit(1)
            Spacer(minLength: 0)
            Button { model.replyTo = nil } label: { LookGlyph(glyph: "×", symbol: "xmark", size: 15) }
                .buttonStyle(.plain).accessibilityLabel("Close")
        }
        .foregroundStyle(.secondary)
    }

    /// The members the `@name` being typed may become, the newest-seated last, then `all`.
    private func picker(_ offers: [String]) -> some View {
        VStack(spacing: 0) {
            ForEach(offers.suffix(6), id: \.self) { handle in
                let seat = seats.first { $0.handle == handle }
                Button { model.draft = RoomMention.complete(model.draft, with: handle) } label: {
                    HStack(spacing: 10) {
                        if handle == RoomSeat.all { Color.clear.frame(width: 10, height: 10) } else { SeatStateMark(state: seat?.state).frame(width: 10) }
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
