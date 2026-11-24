import AgentSwitchKit
import QuickLook
import SwiftUI

// A room's work (docs/chatroom-v0.md §9), over its page as the pinned notes are: the task list every member reads and
// takes from, the shared folder members hand each other files in, and — on a member's row and card — which files it
// says it is changing.

/// The room's task list: what is being done, what is to do, what is done. A row says the task's number, its title,
/// whose it is, what it still waits for and what was last said of it. The user adds one, ticks one done or to do
/// again, gives it to another member and takes it off the list.
struct RoomTasksSheet: View {
    let model: RoomPageModel
    /// The sample screens: the new task's page first.
    var addingAtOpen = false
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false
    @State private var deleting: RoomTask?

    var body: some View {
        let detail = model.detail
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let error = model.error {
                        Text(error).font(.footnote).foregroundStyle(Theme.failed).padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.m)
                    }
                    if let detail {
                        if detail.tasks.isEmpty {
                            Text("这个房间还没有任务。点 Add 加一个；成员也可以自己加、自己领。").font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
                        }
                        ForEach([RoomTaskState.blocked, .doing, .todo, .done], id: \.self) { state in
                            let tasks = detail.tasks(state)
                            if !tasks.isEmpty {
                                HStack(alignment: .firstTextBaseline) {
                                    SectionLabel(state.says)
                                    Spacer(minLength: 6)
                                    Text("\(tasks.count)").mono(11.5).foregroundStyle(Theme.inkDim)
                                }
                                .padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.l).padding(.bottom, 6)
                                ForEach(tasks) { task in
                                    RoomTaskRow(task: task, detail: detail, toggle: { toggle(task) }) { actions(task, in: detail) }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, Theme.Space.l)
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(isPresented: $adding) { RoomTaskAddPage(model: model) }
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Tasks").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Done") } else { Text("Done").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { adding = true } label: { if look.isClassic { Image(systemName: "plus") } else { Text("Add").mono(15, weight: .medium) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                        .accessibilityLabel("Add")
                }
            }
            .confirmationDialog("删除 \(deleting?.name ?? "")？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { task in
                Button("Delete", role: .destructive) { Task { await model.run(app.api) { try await $0.deleteRoomTask(task.n, in: model.id) } } }
            } message: { task in
                Text("“\(task.title)”会从任务列表里移除，无法恢复。")
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { if addingAtOpen { adding = true } }
    }

    /// The row's box: one not done is done, one done is to do again. Whose it is stays as it was.
    private func toggle(_ task: RoomTask) {
        Task { await model.run(app.api) { try await $0.setRoomTask(task.n, in: model.id, state: task.state == .done ? .todo : .done) } }
    }

    @ViewBuilder private func actions(_ task: RoomTask, in detail: RoomDetail) -> some View {
        if task.state == .done {
            Button("Mark To Do", systemImage: "arrow.uturn.backward") { toggle(task) }
        } else {
            Button("Mark Done", systemImage: "checkmark") { toggle(task) }
        }
        Menu {
            ForEach(detail.sessions) { seat in
                Button { owner(task, .seat(seat.handle)) } label: {
                    if task.owner == seat.handle { Label("@\(seat.handle)", systemImage: "checkmark") } else { Text("@\(seat.handle)") }
                }
            }
            if task.owner != nil { Section { Button("Nobody") { owner(task, .nobody) } } }
        } label: { Label("Owner", systemImage: "person") }
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = "\(task.name) \(task.title)" }
        Section { Button("Delete…", systemImage: "trash", role: .destructive) { deleting = task } }
    }

    private func owner(_ task: RoomTask, _ owner: RoomTaskOwner) {
        guard owner != task.owner.map(RoomTaskOwner.seat) else { return }
        Task { await model.run(app.api) { try await $0.setRoomTask(task.n, in: model.id, owner: owner) } }
    }
}

/// One task of the list.
private struct RoomTaskRow<Actions: View>: View {
    let task: RoomTask
    let detail: RoomDetail
    let toggle: () -> Void
    @ViewBuilder let actions: () -> Actions
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let done = task.state == .done
        HStack(alignment: .top, spacing: 10) {
            Button(action: toggle) { box }
                .buttonStyle(.plain)
                .accessibilityLabel(done ? "Mark To Do" : "Mark Done")
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(task.name).mono(12, weight: .medium).foregroundStyle(.secondary).fixedSize()
                    Text(task.title).font(.system(size: 15)).foregroundStyle(done ? Theme.secondaryInk : Theme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                }
                if let detail = task.detail, !done {
                    Text(detail).font(.system(size: 12.5)).foregroundStyle(.secondary).lineLimit(3)
                }
                let waits = detail.waitsWord(task)
                if task.owner != nil || waits != nil {
                    HStack(spacing: 6) {
                        if let owner = task.owner {
                            RoomFaceView(face: detail.seat(owner)?.face, you: owner == RoomSeat.you, side: 16)
                            Text(owner == RoomSeat.you ? "You" : "@\(owner)").foregroundStyle(Theme.secondaryInk)
                        }
                        if let waits {
                            if task.owner != nil { Text("·").foregroundStyle(Theme.inkDim) }
                            Text(waits).foregroundStyle(Theme.waiting)
                        }
                    }
                    .mono(11.5).lineLimit(1)
                }
                if let note = task.note {
                    let stuck = task.state == .blocked
                    Text(stuck ? "卡在：" + note : note).font(.system(size: 12.5)).foregroundStyle(stuck ? Theme.waiting : .secondary).lineLimit(4)
                        .padding(.leading, 8)
                        .overlay(alignment: .leading) { (stuck ? Theme.waiting : Theme.line).frame(width: 2) }
                }
                if let stats = detail.taskStats[task.n], !stats.isEmpty {
                    Text(stats.line).mono(10.5).foregroundStyle(Theme.inkDim).lineLimit(1)
                }
            }
            Menu { actions() } label: {
                LookGlyph(glyph: "⋯", symbol: "ellipsis", size: 17, weight: .regular, scale: 0.9)
                    .foregroundStyle(Theme.secondaryInk).frame(width: 30, height: 26).contentShape(Rectangle())
            }
            .accessibilityLabel("More")
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { HairRule().padding(.leading, look.isClassic ? 46 : 0) }
        .contentShape(Rectangle())
        .contextMenu { actions() }
    }

    /// Empty while it is to do, half while it is being done, ticked when done.
    @ViewBuilder private var box: some View {
        if look.isClassic {
            Image(systemName: task.state == .done ? "checkmark.circle.fill" : task.state == .blocked ? "exclamationmark.triangle.fill" : task.state == .doing ? "circle.lefthalf.filled" : "circle")
                .font(.system(size: 20)).foregroundStyle(task.state == .done ? Theme.done : task.state == .blocked ? Theme.waiting : task.state == .doing ? Theme.busy : Theme.inkDim)
        } else {
            Text(task.state == .done ? "[x]" : task.state == .blocked ? "[!]" : task.state == .doing ? "[~]" : "[ ]")
                .font(.system(size: 14, design: .monospaced)).foregroundStyle(task.state == .todo ? Theme.inkDim : task.state == .blocked ? Theme.waiting : Theme.ink)
                .padding(.top, 1)
        }
    }
}

/// A new task: its title, what more there is to say of it, and whose it is — one of the sessions sitting in the room,
/// or nobody's yet.
private struct RoomTaskAddPage: View {
    let model: RoomPageModel
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var detail = ""
    @State private var owner: String?
    @State private var working = false

    var body: some View {
        let seats = model.detail?.sessions ?? []
        Form {
            Section(label: "Task") {
                TextField("Title", text: $title).autocorrectionDisabled()
                TextField("Detail", text: $detail, prompt: Text("可不填：要做到什么程度、注意什么"), axis: .vertical).lineLimit(2...6).autocorrectionDisabled()
            }
            Section {
                Picker("Owner", selection: $owner) {
                    Text("Nobody").tag(String?.none)
                    ForEach(seats) { seat in Text("@\(seat.handle)").tag(String?.some(seat.handle)) }
                }
            } footer: {
                Text("任务先放在 To Do 里；不指定的话，成员可以自己领。")
            }
            if let error = model.error { Section { Text(error).font(.footnote).foregroundStyle(Theme.failed) } }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { Text("New Task").font(.headline) }
            ToolbarItem(placement: .confirmationAction) {
                Button { Task { await add() } } label: { if look.isClassic { Text("Add").fontWeight(.semibold) } else { Text("Add").mono(15, weight: .medium) } }
                    .tint(look.isClassic ? Theme.signal : Theme.ink)
                    .disabled(working || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func add() async {
        working = true
        defer { working = false }
        let done = await model.run(app.api) {
            try await $0.addRoomTask(model.id, title: title.trimmingCharacters(in: .whitespaces), detail: detail.trimmingCharacters(in: .whitespacesAndNewlines), owner: owner)
        }
        if done { dismiss() }
    }
}

/// The room's shared folder: where it is on the Mac and what is in it, the newest first. A tap on a file opens it
/// whole with the system's Quick Look, as a file a message came with is opened; `Show in Files` shows the folder it
/// is in on the Files page.
struct RoomFilesSheet: View {
    let room: String
    /// Where the folder is, as the room said it; what the listing says comes in its place.
    let folder: String
    /// A file by where it is on the Mac (`Show in Files`): the sheet closes and the Files page shows it.
    let open: (String) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.interfaceLook) private var look
    @Environment(\.dismiss) private var dismiss
    @State private var files: RoomFiles?
    @State private var error: String?
    @State private var preview: URL?
    /// The file being fetched for the viewer, by where it is under the folder.
    @State private var opening: String?

    private var place: String { files.map(\.folder).flatMap { $0.isEmpty ? nil : $0 } ?? folder }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !place.isEmpty {
                        SectionLabel("Shared Folder").padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.l).padding(.bottom, 6)
                        Text(app.files.home.map { MacPath.short(place, home: $0) } ?? MacPath.tilde(place))
                            .code(12).foregroundStyle(Theme.ink).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Theme.Space.l).padding(.bottom, 10)
                            .contextMenu { Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = place } }
                        HairRule()
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.failed).padding(.horizontal, Theme.Space.l).padding(.top, Theme.Space.m) }
                    if let files {
                        if files.files.isEmpty {
                            Text("共享文件夹里还没有文件。成员把要交给别人的文件（报告、截图、补丁）放在这里。").font(.subheadline).foregroundStyle(.secondary).padding(Theme.Space.l)
                        }
                        ForEach(files.files) { file in
                            Button { show(file, in: files.folder) } label: { row(file) }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("Open Preview", systemImage: "eye") { show(file, in: files.folder) }
                                    Button("Show in Files", systemImage: "folder") { dismiss(); open(RoomFiles.whole(file.path, in: files.folder)) }
                                    Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = RoomFiles.whole(file.path, in: files.folder) }
                                }
                        }
                        if files.more {
                            Text("文件很多，这里只列出一部分。").font(.footnote).foregroundStyle(.secondary).padding(Theme.Space.l)
                        }
                    } else if error == nil {
                        HStack(spacing: 8) { BrailleSpinner(color: Theme.secondaryInk); Text("Loading").mono(12).foregroundStyle(.secondary) }.padding(Theme.Space.l)
                    }
                }
                .padding(.bottom, Theme.Space.l)
            }
            .background { Theme.base.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("Files").font(.headline) }
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { if look.isClassic { Text("Done") } else { Text("Done").mono(15) } }
                        .tint(look.isClassic ? Theme.signal : Theme.ink)
                }
            }
            .refreshable { await load() }
            .quickLookPreview($preview)
            .onChange(of: preview) { old, new in if new == nil, let old { RoomFileStore.forget(old) } }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    /// The file whole, for the system's viewer; one too big for the room's route is said so.
    private func show(_ file: RoomFile, in folder: String) {
        guard opening == nil else { return }
        guard file.size <= RoomFiles.maxFileBytes else { error = "文件超过 25 MB，手机上不预览。"; return }
        opening = file.path
        Task {
            defer { opening = nil }
            let ref = RoomFileRef(room: room, path: RoomFiles.whole(file.path, in: folder), folder: folder)
            do {
                preview = try await RoomFileStore.shared.file(ref, api: app.api, files: app.fileSource)
                error = nil
            } catch {
                self.error = RoomFileStore.sentence(error, mac: app.profile?.name ?? "Mac")
            }
        }
    }

    private func row(_ file: RoomFile) -> some View {
        HStack(spacing: 12) {
            if look.isClassic { Image(systemName: FileIcon.symbol(for: file.path)).font(.system(size: 17)).foregroundStyle(.secondary).frame(width: 22) } else { PixelSprite(rows: RoomArt.file, pixel: 2, color: Theme.secondaryInk).frame(width: 22) }
            VStack(alignment: .leading, spacing: 2) {
                Text(file.path).code(13).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Text("\(FileSize.short(file.size)) · \(file.modified.relative)").mono(11.5).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            if opening == file.path { BrailleSpinner(color: Theme.secondaryInk) } else { LookGlyph.onward().foregroundStyle(Theme.inkDim) }
        }
        .padding(.horizontal, Theme.Space.l)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { HairRule().padding(.leading, look.isClassic ? 50 : 0) }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        #if DEBUG
        if DemoRooms.isDemo { files = DemoRooms.files; return }
        #endif
        guard let api = app.api else { error = "未连接 Mac。"; return }
        do { files = try await api.roomFiles(room); error = nil } catch { self.error = error.localizedDescription }
    }
}

/// What a member says it is changing, in one small line: the files by name and when that ends by itself.
struct RoomClaimLine: View {
    let claim: RoomClaim

    var body: some View {
        // One name and how many more: the row is narrow, the card has them all.
        Text("Changing \(claim.names(limit: 1)) · \(claim.untilWord())")
            .mono(11.5).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            .accessibilityLabel("Changing \(claim.paths.joined(separator: ", ")), \(claim.untilWord())")
    }
}
