import AgentSwitchKit
import SwiftUI

// What comes up over a room (docs/chatroom-v0.md §10): its members and a member's card, the sessions to bring in (and
// a new room's name with them), and its name and topic.

/// The members, by the node they run on: face with the state at its corner, `@name`, the state's word, the agent's
/// mark, the profile's dot. A tap opens the card. `Add` brings in sessions that run on the Mac.
struct RoomMembersSheet: View {
    let model: RoomPageModel
    /// A member whose card is shown first (a tap on a face or a name in the timeline).
    let opening: String?
    let add: () -> Void
    let mention: (String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var path: [String]

    init(model: RoomPageModel, opening: String?, add: @escaping () -> Void, mention: @escaping (String) -> Void) {
        self.model = model
        self.opening = opening
        self.add = add
        self.mention = mention
        _path = State(initialValue: opening.map { [$0] } ?? [])
    }

    var body: some View {
        let seats = model.detail?.sessions ?? []
        // The Mac shown first, then the other nodes by name.
        let nodes = Dictionary(grouping: seats) { $0.card?.node ?? "" }.sorted { $0.key < $1.key }
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if seats.isEmpty {
                        Text("房间里还没有会话。点 Add 把正在运行的会话拉进来。").font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
                    }
                    ForEach(nodes, id: \.key) { node, seats in
                        SectionLabel(node.isEmpty ? (app.profile?.name ?? "Mac") : node)
                            .padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.l).padding(.bottom, 6)
                        ForEach(seats) { seat in
                            NavigationLink(value: seat.handle) { RoomMemberRow(seat: seat, claim: model.detail?.claim(of: seat.handle)) }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { handle in
                SeatCardPage(model: model, handle: handle, mention: { dismiss(); mention($0) }, close: { dismiss() })
            }
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Members").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Done") } else { Text("Done").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { dismiss(); add() } label: { if look.isClassic { Image(systemName: "plus") } else { Text("Add").mono(15, weight: .medium) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                        .accessibilityLabel("Add")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct RoomMemberRow: View {
    let seat: RoomSeat
    /// What it says it is changing (§9), while that holds.
    var claim: RoomClaim?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        HStack(spacing: 12) {
            RoomFaceView(face: seat.face, side: 26)
                .overlay(alignment: .bottomTrailing) {
                    SeatStateMark(state: seat.state).frame(width: 12, height: 12)
                        .background(Theme.base, in: RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0))
                        .offset(x: 5, y: 5)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text("@\(seat.handle)").font(.system(size: 15, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.ink).lineLimit(1)
                HStack(spacing: 0) {
                    Text(seat.state?.word(in: look) ?? "—").foregroundStyle(seat.state?.wordColor ?? Theme.secondaryInk)
                    if seat.canAdd { Text(" · Admin").foregroundStyle(.secondary) }
                    // Its session has no Chatroom Kit (§6): it needs the user to resume it once.
                    if seat.needsResume { Text(" · No Kit").foregroundStyle(Theme.waiting) }
                }
                .mono(11.5).lineLimit(1)
                if let claim { RoomClaimLine(claim: claim) }
            }
            Spacer(minLength: 6)
            if let agent = seat.card?.agent, !agent.isEmpty { RoomAgentMark(agent: agent) }
            if let color = seat.card?.color { ProfileDot(color: color) }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 11)
        .overlay(alignment: .bottom) { HairRule().padding(.leading, look.isClassic ? 54 : 0) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A member's card (§1 名片): its agent, model, profile, node, folder, how it asks, its state and who seated it; the
/// Chatroom Kit's one switch (§6), off for good for a session another session started; and what can be done with it.
private struct SeatCardPage: View {
    let model: RoomPageModel
    let handle: String
    let mention: (String) -> Void
    let close: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemove = false
    @State private var busy = false

    var body: some View {
        let seat = model.detail?.seat(handle)
        Form {
            if let seat {
                Section {
                    HStack(spacing: 12) {
                        RoomFaceView(face: seat.face, side: 36)
                        Text("@\(seat.handle)").font(.system(size: 17, weight: .semibold, design: look.isClassic ? .default : .monospaced))
                        Spacer(minLength: 6)
                        SeatStateMark(state: seat.state)
                        if let color = seat.card?.color { ProfileDot(color: color) }
                    }
                    if let error = model.error { Text(error).font(.footnote).foregroundStyle(Theme.failed) }
                }
                Section {
                    if let card = seat.card {
                        line("Agent", RoomArt.agentName(card.agent))
                        line("Model", card.model.map(ModelName.display) ?? "Default")
                        line("Profile", card.profile ?? "Default")
                        line("Node", card.node ?? app.profile?.name ?? "Mac")
                        line("Folder", app.files.home.map { MacPath.short(card.cwd, home: $0) } ?? MacPath.tilde(card.cwd), code: true)
                        if let mode = card.mode { line("Mode", ClassicWords.word(mode, in: look)) }
                    }
                    LabeledContent("State") {
                        Text(seat.left != nil ? "Left" : seat.state?.word(in: look) ?? "—").foregroundStyle(seat.left != nil ? Theme.secondaryInk : seat.state?.wordColor ?? Theme.secondaryInk)
                    }
                    line("Seated By", RoomWords.who(seat.addedBy))
                } footer: {
                    if seat.left == nil, let says = seat.state?.says { Text(says) }
                }
                // Which files it says it is changing (§9): a word to the others, not a lock.
                if seat.left == nil, let claim = model.detail?.claim(of: handle) {
                    Section {
                        ForEach(claim.paths, id: \.self) { path in Text(path).code(13).lineLimit(1).truncationMode(.middle) }
                    } header: {
                        SectionLabel("Changing · \(claim.untilWord())")
                    } footer: {
                        if let why = claim.why { Text(why) }
                    }
                }
                if seat.needsResume {
                    Section {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            SeatStateMark(state: .waiting)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("No Kit").font(.system(size: 14, weight: .semibold, design: look.isClassic ? .default : .monospaced)).foregroundStyle(Theme.waiting)
                                Text(RoomSeat.noKitSays).font(.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                if seat.left == nil {
                    Section {
                        Toggle("Admin", isOn: Binding(get: { seat.canAdd }, set: { on in
                            Task { busy = true; await model.run(app.api) { try await $0.setSeat(handle, in: model.id, canAdd: on) }; busy = false }
                        }))
                        .disabled(seat.byAgent || busy)
                    } footer: {
                        Text(seat.byAgent ? "由别的会话拉起来的会话不能再拉人。" : "打开后，这个会话可以新建房间、拉会话进来，并读取拉人要用的清单。")
                    }
                    Section {
                        Button("Mention") { mention(handle) }
                        if let terminal = seat.terminal, app.terminals.terminals.contains(where: { $0.id == terminal }) {
                            Button("Open Terminal") { close(); app.openTerminal(terminal) }
                        }
                        Button("Remove", role: .destructive) { confirmRemove = true }.disabled(busy)
                    }
                }
            } else {
                Text("这个成员已不在房间里。").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("@\(handle)")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("把 @\(handle) 移出房间？", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    busy = true
                    let done = await model.run(app.api) { try await $0.unseat(handle, in: model.id) }
                    busy = false
                    if done { dismiss() }
                }
            }
        } message: {
            Text("它的会话不受影响；还没交到它手上的消息不再投递。")
        }
    }

    private func line(_ label: String, _ value: String, code: Bool = false) -> some View {
        LabeledContent(label) {
            Group { if code { Text(value).code(13) } else { Text(value) } }
                .lineLimit(1).truncationMode(.middle)
        }
    }
}

/// The sessions running on the Mac shown, to seat: with a name and a topic first for a new room (`New`), or the ones
/// not seated yet for a room there is (`Add Sessions`). One that has ended can not be seated and is not listed.
struct RoomSessionsSheet: View {
    enum Purpose {
        case create
        case add(room: String, seated: Set<String>)
    }

    let purpose: Purpose
    /// The room's id, once made or added to.
    let done: (String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var topic = ""
    @State private var picked: Set<String> = []
    /// The search over the sessions to pick: by name, agent, model, profile and folder (RoomSessionSearch).
    @State private var query = ""
    @State private var working = false
    @State private var error: String?

    private var creating: Bool { if case .create = purpose { return true } else { return false } }

    private var terminals: [TerminalInfo] {
        var seated: Set<String> = []
        if case .add(_, let already) = purpose { seated = already }
        return app.terminals.terminals.filter { $0.isRunning && !seated.contains($0.id) }
            .sorted { max($0.lastOutputAt, $0.createdAt) > max($1.lastOutputAt, $1.createdAt) }
    }

    /// The ones the search leaves; picked ones the search hides stay picked.
    private var shown: [TerminalInfo] { RoomSessionSearch.filter(terminals, query: query) }

    private var ready: Bool {
        !working && (creating ? !name.trimmingCharacters(in: .whitespaces).isEmpty : !picked.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                if creating {
                    Section(label: "Room") {
                        TextField("Name", text: $name).autocorrectionDisabled()
                        TextField("Topic", text: $topic, prompt: Text("一句话，进来的成员先读到"), axis: .vertical).lineLimit(1...3)
                    }
                }
                Section {
                    if !terminals.isEmpty { searchLine }
                    if shown.isEmpty {
                        Text(!terminals.isEmpty ? "没有找到匹配的会话。" : creating ? "没有开着的终端。可以先建房间，之后再拉会话。" : "没有可以拉进来的会话：开着的终端都已在房间里。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(shown) { t in
                        Button { if !picked.insert(t.id).inserted { picked.remove(t.id) } } label: { row(t) }.buttonStyle(.plain)
                    }
                } header: {
                    SectionLabel("Running Sessions")
                } footer: {
                    Text("进了房间的会话可以收发房间消息；只有 @ 才唤醒它。")
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(Theme.failed) } }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text(creating ? "New Room" : "Add Sessions").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Cancel") } else { Text("Cancel").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await go() } } label: {
                        let word = creating ? "Create" : picked.count > 1 ? "Add \(picked.count)" : "Add"
                        if look.isClassic { Text(word).fontWeight(.semibold) } else { Text(word).mono(15, weight: .medium) }
                    }
                    .tint(look.isClassic ? Theme.signal : Theme.ink)
                    .disabled(!ready)
                }
            }
        }
        .presentationDetents(creating ? [.large] : [.medium, .large])
        .task { await app.refreshTerminals() }
    }

    /// `/ Search`, as on the Terminals page.
    private var searchLine: some View {
        HStack(spacing: 8) {
            if look.isClassic {
                Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Theme.inkDim)
            } else {
                Text("/").font(.system(size: 15, weight: .bold, design: .monospaced)).foregroundStyle(Theme.signal)
            }
            TextField("Search", text: $query).autocorrectionDisabled().textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button { query = "" } label: { LookGlyph(glyph: "×", symbol: "xmark.circle.fill", size: 15) }
                    .buttonStyle(.plain).foregroundStyle(Theme.inkDim).accessibilityLabel("Clear")
            }
        }
    }

    private func row(_ t: TerminalInfo) -> some View {
        let on = picked.contains(t.id)
        return HStack(spacing: 12) {
            if look.isClassic {
                Image(systemName: on ? "checkmark.circle.fill" : "circle").font(.system(size: 20)).foregroundStyle(on ? Theme.signal : Theme.inkDim)
            } else {
                Text(on ? "[x]" : "[ ]").font(.system(size: 14, design: .monospaced)).foregroundStyle(on ? Theme.ink : Theme.inkDim)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(t.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text(app.files.home.map { MacPath.short(t.workdir, home: $0) } ?? MacPath.tilde(t.workdir)).code(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 6)
            RoomAgentMark(agent: t.harness)
            if let color = t.profile?.color { ProfileDot(color: color) }
            TerminalStatusMark(status: t.permissions.isEmpty ? t.status : .waiting)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func go() async {
        guard let api = app.api else { error = "未连接 Mac。"; return }
        working = true
        defer { working = false }
        do {
            switch purpose {
            case .create:
                let made = try await api.createRoom(name: name.trimmingCharacters(in: .whitespaces), topic: topic.trimmingCharacters(in: .whitespacesAndNewlines),
                                                    terminals: terminals.map(\.id).filter(picked.contains))
                await app.rooms.refresh(api)
                // The room is made; a session that could not be seated is said on the Rooms page, not lost.
                if !made.problems.isEmpty { app.banner = made.problems.joined(separator: "\n") }
                dismiss()
                done(made.room.id)
            case .add(let room, _):
                var problems: [String] = []
                for id in terminals.map(\.id) where picked.contains(id) {
                    do { try await api.seat(id, in: room); picked.remove(id) } catch { problems.append(error.localizedDescription) }
                }
                done(room)
                if problems.isEmpty { dismiss() } else { error = problems.joined(separator: "\n") }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A room's name and its topic.
struct RoomEditSheet: View {
    @State var name: String
    @State var topic: String
    /// True once the Mac has them.
    let save: (String, String) async -> Bool
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section(label: "Room") {
                    TextField("Name", text: $name).autocorrectionDisabled()
                    TextField("Topic", text: $topic, prompt: Text("一句话，进来的成员先读到"), axis: .vertical).lineLimit(1...3)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Rename Room").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Cancel") } else { Text("Cancel").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { working = true; let done = await save(name.trimmingCharacters(in: .whitespaces), topic.trimmingCharacters(in: .whitespacesAndNewlines)); working = false; if done { dismiss() } }
                    } label: { if look.isClassic { Text("Save").fontWeight(.semibold) } else { Text("Save").mono(15, weight: .medium) } }
                    .tint(look.isClassic ? Theme.signal : Theme.ink)
                    .disabled(working || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// The room's pinned notes (docs/chatroom-v0.md §9): one text every member reads and replaces whole — what was agreed.
/// Shown as written, with who wrote them last and when; `Edit` makes them a box to write in, `Save` puts the whole
/// text in place of what was there.
struct RoomNotesSheet: View {
    let notes: RoomNotes?
    /// True once the Mac has them.
    let save: (String) async -> Bool
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var editing = false
    @State private var working = false
    @FocusState private var writing: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Space.m) {
                    if let notes, !editing {
                        Text("\(RoomWords.who(notes.by)) · \(RoomWords.day(notes.date)) \(RoomWords.time(notes.date))").mono(11.5).foregroundStyle(.secondary)
                    }
                    if editing {
                        TextEditor(text: $text)
                            .font(.system(size: 14, design: .monospaced))
                            .scrollContentBackground(.hidden)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .focused($writing)
                            .frame(minHeight: 260)
                            .padding(8)
                            .grounded(look.isClassic ? Theme.panel : Color.clear, radius: Theme.Radius.card)
                            .framed(Theme.line, radius: Theme.Radius.card)
                        Text("所有成员都能读、能改这份笔记。保存会用这里的全文替换原来的内容。").font(.footnote).foregroundStyle(.secondary)
                    } else if let notes {
                        Text(notes.text).font(.system(size: 14, design: .monospaced)).foregroundStyle(Theme.ink).lineSpacing(3)
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    } else {
                        Text("这个房间还没有置顶笔记。可以把约定、接口、待办写在这里，所有成员都能读、能改。").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(Theme.Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Notes").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { if editing && notes != nil { editing = false } else { dismiss() } } label: {
                        let word = editing ? "Cancel" : "Done"
                        if look.isClassic { Text(word) } else { Text(word).mono(15) }
                    }
                    .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if editing {
                        Button {
                            Task { working = true; let done = await save(text); working = false; if done { dismiss() } }
                        } label: { if look.isClassic { Text("Save").fontWeight(.semibold) } else { Text("Save").mono(15, weight: .medium) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                        .disabled(working || text == (notes?.text ?? ""))
                    } else {
                        Button { text = notes?.text ?? ""; editing = true; writing = true } label: { if look.isClassic { Text("Edit") } else { Text("Edit").mono(15, weight: .medium) } }
                            .tint(look.isClassic ? Theme.signal : Theme.ink)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(editing && text != (notes?.text ?? ""))
    }
}
