import AgentSwitchMacCore
import SwiftUI

// The room's work (docs/chatroom-v0.md §9): the task list — who does what, and how far it is — and the shared folder,
// where members hand each other what is longer than a message. Members write both with their tools; the user here.

// MARK: - the task list

struct RoomTasksSheet: View {
    @Bindable var model: RoomsModel
    @State private var title = ""
    @State private var owner: String?
    @Environment(\.interfaceLook) private var look

    private var room: Room? { model.room }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Tasks").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                if let room, !room.tasks.isEmpty {
                    Text("\(room.tasks(.doing).count) doing · \(room.tasks(.todo).count) to do · \(room.tasks(.done).count) done").mono(11.5).foregroundStyle(Look.faint)
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            VStack(alignment: .leading, spacing: 10) {
                Text("谁在做什么、做到哪了。成员用自己的工具加任务、领任务、标完成；别人正在做的任务，会话领不走。").font(.system(size: 12)).foregroundStyle(Look.faint)
                HStack(spacing: 8) {
                    RoomField(prompt: "New task", text: $title, submit: add)
                    ownerMenu(owner) { owner = $0 }
                    Button(action: add) { BracketLabel(word: "Add", key: "↩") }.buttonStyle(BracketButtonStyle(role: .primary))
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let room {
                            if room.tasks.isEmpty {
                                Text("还没有任务。").font(.system(size: 12.5)).foregroundStyle(Look.faint).padding(.vertical, 24).frame(maxWidth: .infinity)
                            }
                            group("Doing", room.tasks(.doing), in: room)
                            group("To Do", room.tasks(.todo), in: room)
                            group("Done", room.tasks(.done), in: room)
                        }
                    }
                }
                .frame(height: 320)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if let problem = model.problem { Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed).lineLimit(2) }
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Close", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(width: 640)
        .roomFloat()
    }

    private func add() {
        let text = title.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        model.addTask(text, detail: "", owner: owner)
        title = ""
    }

    @ViewBuilder
    private func group(_ name: String, _ tasks: [RoomTask], in room: Room) -> some View {
        if !tasks.isEmpty {
            Text(ClassicWords.word(name, in: look)).mono(11).foregroundStyle(Look.faint).padding(.top, 10).padding(.bottom, 4)
            ForEach(tasks) { task in
                row(task, in: room)
                HairRule(color: Look.line)
            }
        }
    }

    private func row(_ task: RoomTask, in room: Room) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(task.name).mono(12).foregroundStyle(Look.faint).frame(width: 30, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.system(size: 13)).foregroundStyle(task.state == .done ? Look.ink2 : Look.ink)
                    .strikethrough(task.state == .done, color: Look.faint).fixedSize(horizontal: false, vertical: true)
                if let detail = task.detail { Text(detail).font(.system(size: 12)).foregroundStyle(Look.ink2).fixedSize(horizontal: false, vertical: true) }
                let waits = room.waits(task)
                if !waits.isEmpty { Text("Waits for " + waits.map { "T\($0)" }.joined(separator: ", ")).mono(11).foregroundStyle(Color.waiting) }
                if let note = task.note { Text("→ " + note).font(.system(size: 12, design: .monospaced)).foregroundStyle(Look.ink2).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 6)
            ownerMenu(task.owner) { model.setTask(task.n, owner: $0) }
            switch task.state {
            case .done: Button { model.setTask(task.n, state: .todo) } label: { BracketLabel(word: "Reopen") }.buttonStyle(BracketButtonStyle(size: 12))
            default: Button { model.setTask(task.n, state: .done) } label: { BracketLabel(word: "Done") }.buttonStyle(BracketButtonStyle(size: 12))
            }
            Button { model.deleteTask(task.n) } label: { BracketLabel(word: "Delete") }.buttonStyle(BracketButtonStyle(role: .destructive, size: 12))
        }
        .padding(.vertical, 7)
    }

    /// Whose a task is: a member of the room, or nobody.
    private func ownerMenu(_ owner: String?, set: @escaping (String?) -> Void) -> some View {
        Menu {
            Button("Nobody") { set(nil) }
            Divider()
            Button("You") { set(Room.you) }
            ForEach(room?.sessions ?? [], id: \.handle) { seat in
                Button("@\(seat.handle)") { set(seat.handle) }
            }
        } label: {
            Text(owner.map { $0 == Room.you ? "You" : "@\($0)" } ?? "Nobody").mono(12).foregroundStyle(owner == nil ? Look.faint : Look.ink).lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

// MARK: - the shared folder

struct RoomFilesSheet: View {
    @Bindable var model: RoomsModel
    let home = NSHomeDirectory()
    @Environment(\.interfaceLook) private var look

    private var folder: String? { model.shared?.folder ?? model.room?.folder }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Files").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                if let folder {
                    Text(DisplayPath.short(folder, home: home)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Look.faint)
                        .lineLimit(1).truncationMode(.middle).textSelection(.enabled).help(folder)
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            VStack(alignment: .leading, spacing: 10) {
                Text("这个房间的共享文件夹。成员把报告、方案、接口说明这类长内容写成文件放在这里，消息里只放路径和一句结论。你也可以直接往里放文件。").font(.system(size: 12)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let shared = model.shared {
                            if shared.files.isEmpty {
                                Text("文件夹是空的。").font(.system(size: 12.5)).foregroundStyle(Look.faint).padding(.vertical, 24).frame(maxWidth: .infinity)
                            }
                            ForEach(shared.files) { file in
                                Button { if model.onThisMac, let folder { model.preview(file: folder + "/" + file.path) } } label: {
                                    HStack(spacing: 10) {
                                        Text(file.path).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.middle)
                                        Spacer(minLength: 8)
                                        Text(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file)).mono(11.5).foregroundStyle(Look.faint)
                                        Text(TimeText.moment(file.date)).mono(11.5).foregroundStyle(Look.faint).frame(width: 110, alignment: .trailing)
                                    }
                                    .padding(.vertical, 6)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .help(model.onThisMac ? "预览" : file.path)
                                HairRule(color: Look.line)
                            }
                            if shared.more { Text("还有更多文件没有列出。").font(.system(size: 12)).foregroundStyle(Look.faint).padding(.top, 8) }
                        } else {
                            BrailleSpinner().padding(.vertical, 24).frame(maxWidth: .infinity)
                        }
                    }
                }
                .frame(height: 300)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if model.onThisMac { Button { model.revealShared() } label: { BracketLabel(word: "Open Folder") }.buttonStyle(BracketButtonStyle()).disabled(folder == nil) }
                Button { model.loadShared() } label: { BracketLabel(word: "Refresh") }.buttonStyle(BracketButtonStyle())
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Close", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(width: 640)
        .roomFloat()
    }
}

// MARK: - which models admins may use

/// Per profile, the models a session may start a session on (docs/chatroom-v0.md §6.2): the user turns one off, and
/// an admin that asks for it is refused and told the ones it may use. What the user starts is not bound by it.
struct RoomModelsSheet: View {
    @Bindable var model: RoomsModel
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Models for Admins").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            VStack(alignment: .leading, spacing: 10) {
                Text("管理员会话拉起新会话时，每个配置下哪些模型能用。关掉的模型，管理员指定它会被拒绝，并被告知这个配置下能用哪些。只管由会话拉起来的会话；你自己开的不受影响。").font(.system(size: 12)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let all = model.adminModels {
                            ForEach(all.agents.keys.sorted(), id: \.self) { agent in
                                if let of = all.agents[agent], !of.models.isEmpty {
                                    Text(HarnessName.display(agent)).mono(12, weight: .semibold).foregroundStyle(Look.ink).padding(.top, 12).padding(.bottom, 4)
                                    ForEach(of.profiles) { profile in
                                        HStack(alignment: .top, spacing: 10) {
                                            Text(profile.name + (profile.id == of.current ? " · Current" : "")).mono(12).foregroundStyle(Look.ink2).frame(width: 190, alignment: .leading).lineLimit(1).truncationMode(.middle).help(profile.name)
                                            FlowLayout(spacing: 6) {
                                                ForEach(of.models) { one in
                                                    let on = !profile.off.contains(one.id)
                                                    Button { model.setAdminModel(one.id, on: !on, agent: agent, profile: profile) } label: {
                                                        Text((look.isClassic ? "" : (on ? "[x] " : "[ ] ")) + one.name).mono(11.5)
                                                            .foregroundStyle(on ? Look.ink : Look.faint).strikethrough(!on, color: Look.faint)
                                                            .padding(.horizontal, 7).padding(.vertical, 3)
                                                            .grounded(on && look.isClassic ? Look.raised : Color.clear, radius: 6)
                                                            .framed(Look.line, radius: look.isClassic ? 6 : 0)
                                                    }
                                                    .buttonStyle(.plain)
                                                    .help(on ? "管理员可以用。点一下关掉。" : "已关掉，管理员不能用。点一下打开。")
                                                }
                                            }
                                        }
                                        .padding(.vertical, 6)
                                        HairRule(color: Look.line)
                                    }
                                }
                            }
                        } else {
                            BrailleSpinner().padding(.vertical, 24).frame(maxWidth: .infinity)
                        }
                    }
                }
                .frame(height: 340)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if let problem = model.problem { Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed).lineLimit(2) }
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Close", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(width: 720)
        .roomFloat()
    }
}
