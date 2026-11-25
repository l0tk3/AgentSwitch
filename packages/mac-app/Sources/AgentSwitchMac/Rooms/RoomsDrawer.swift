import AgentSwitchMacCore
import SwiftUI
import UniformTypeIdentifiers
import AppKit

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

/// A member's avatar chosen (2026-11-24, user #200, #203): one for the pixel look (a face or a pixel character of the
/// library), one for the classic (an emoji on a ground of a face colour); each goes back to its own with Reset. The
/// session's, in every room.
struct RoomAvatarSheet: View {
    @Bindable var model: RoomsModel
    @State private var classicTab = false
    @State private var bg = 0
    @Environment(\.interfaceLook) private var look

    private var seat: RoomSeat? { model.avatarSeat.flatMap { model.room?.seat($0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("Avatar · @\(model.avatarSeat ?? "")").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                Spacer()
                RoomFaceView(seat: seat, side: 30).environment(\.interfaceLook, .pixel)
                RoomFaceView(seat: seat, side: 30).environment(\.interfaceLook, .classic)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            Picker("", selection: $classicTab) {
                Text("Pixel").tag(false)
                Text("Classic").tag(true)
            }
            .pickerStyle(.segmented).labelsHidden().fixedSize().padding(.horizontal, 16).padding(.top, 12)
            Text(classicTab ? "经典外观用的头像：一个表情，底色可选。" : "像素外观用的头像：小像素脸，或 16×16 的像素人物（DiceBear Pixel Art，CC0）。")
                .font(.system(size: 12)).foregroundStyle(Look.faint).padding(.horizontal, 16).padding(.top, 8)
            ScrollView {
                if let lib = model.avatarLibrary {
                    if classicTab { classic(lib) } else { pixel(lib) }
                } else {
                    BrailleSpinner().padding(.vertical, 24).frame(maxWidth: .infinity)
                }
            }
            .frame(height: 330)
            .padding(.horizontal, 16).padding(.vertical, 10)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if let problem = model.problem { Text(problem).font(.system(size: 12)).foregroundStyle(Color.failed).lineLimit(2) }
                Spacer()
                Button { model.setAvatar([classicTab ? "classic" : "pixel": NSNull()]) } label: { BracketLabel(word: "Reset") }.buttonStyle(BracketButtonStyle())
                    .help(classicTab ? "回到名字的首字母。" : "回到它在房间里自动生成的像素脸。")
                Button { model.sheet = nil } label: { BracketLabel(word: "Done", key: "esc") }.buttonStyle(BracketButtonStyle(role: .primary)).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .frame(width: 620)
        .roomFloat()
        .onAppear { bg = seat?.avatar?.classic?.bg ?? seat?.face?.colorIndex ?? 0 }
    }

    private let columns = [GridItem(.adaptive(minimum: 44, maximum: 52), spacing: 8)]

    private func pixel(_ lib: RoomAvatarLibrary) -> some View {
        let now = seat?.avatar?.pixel?.id
        return VStack(alignment: .leading, spacing: 10) {
            Text("Faces").mono(11.5).foregroundStyle(Look.ink2)
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(lib.faces) { f in
                    cell(now == f.id) { model.setAvatar(["pixel": ["id": f.id]]) } content: {
                        RoomFacePattern(face: RoomFace(rows: f.rows, color: f.color), cell: 6, color: Color.faces[RoomFace(rows: f.rows, color: f.color).colorIndex])
                    }
                }
            }
            Text("Characters").mono(11.5).foregroundStyle(Look.ink2).padding(.top, 4)
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(lib.art) { a in
                    cell(now == a.id) { model.setAvatar(["pixel": ["id": a.id]]) } content: {
                        RoomGridAvatar(pixel: .grid(id: a.id, palette: a.palette.map { UInt32($0, radix: 16) ?? 0 }, rows: a.rows), side: 36)
                    }
                }
            }
        }
    }

    private func classic(_ lib: RoomAvatarLibrary) -> some View {
        let now = seat?.avatar?.classic
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("Ground").mono(11.5).foregroundStyle(Look.ink2)
                ForEach(0..<10, id: \.self) { i in
                    Button { bg = i; if let e = now { model.setAvatar(["classic": ["emoji": e.emoji, "bg": i]]) } } label: {
                        Circle().fill(Color.faces[i]).frame(width: 18, height: 18)
                            .overlay { if bg == i { Circle().strokeBorder(Look.ink, lineWidth: 2) } }
                    }
                    .buttonStyle(.plain)
                }
            }
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(lib.emoji) { e in
                    cell(now?.emoji == e.emoji) { model.setAvatar(["classic": ["id": e.id, "bg": bg]]) } content: {
                        ZStack { Circle().fill(Color.faces[bg].opacity(0.28)); Text(e.emoji).font(.system(size: 22)) }.frame(width: 36, height: 36)
                    }
                }
            }
        }
    }

    private func cell<C: View>(_ on: Bool, action: @escaping () -> Void, @ViewBuilder content: () -> C) -> some View {
        Button(action: action) {
            content()
                .frame(width: 44, height: 44)
                .background(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).fill(on ? Look.raised : Color.clear))
                .overlay { RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0).strokeBorder(on ? Color.signal : Look.line, lineWidth: on ? 2 : 1) }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The room's secrets (2026-11-24, user #194): logins, API keys and command values the members use — sealed here by
/// this Mac's gate the moment they are added, so the service, the members and the room's record only ever have the
/// ciphertext. Add one; fill the template and import it (the plaintext file then goes to the Trash); export the
/// ciphertexts and import them into another room.
struct RoomSecretsSheet: View {
    @Bindable var model: RoomsModel
    @State private var draft = RoomSecretDraft()
    @State private var adding = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("Secrets").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                Spacer()
                Menu {
                    Button("Import Filled Template…") { if let url = open(["csv", "txt"]) { model.importPlain(url) } }
                    Button("Export Template…") { save("secrets-template.csv") { try RoomSecretDraft.template.write(to: $0, atomically: true, encoding: .utf8) } }
                    Divider()
                    Button("Import Ciphertexts…") { if let url = open(["json"]) { model.importTokens(url) } }
                    Button("Export Ciphertexts…") { save("secrets.json") { model.exportTokens(to: $0) } }.disabled(model.secrets?.isEmpty ?? true)
                } label: { Text("Import / Export").font(.system(size: 12)) }
                .menuStyle(.borderlessButton).fixedSize()
                Button { adding.toggle() } label: { BracketLabel(word: adding ? "Cancel" : "Add") }.buttonStyle(BracketButtonStyle(role: adding ? .normal : .primary, size: 12))
                    .disabled(model.sealer == nil)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            Text("成员只看到密文和用法。密码在这台 Mac 上当场封装（房间在别的节点时，封给那台节点的网关），明文不进房间、不进记录。网站登录的密文只能用在填写的网址上。")
                .font(.system(size: 12)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16).padding(.top, 10)
            if adding { form.padding(.horizontal, 16).padding(.top, 10) }
            if let file = model.plainFile {
                HStack(spacing: 10) {
                    BlinkingSquare()
                    Text("明文文件 \(file.lastPathComponent) 还在磁盘上。").font(.system(size: 12.5)).foregroundStyle(Look.ink)
                    Spacer()
                    Button { model.keepPlain() } label: { BracketLabel(word: "Keep") }.buttonStyle(BracketButtonStyle(size: 12))
                    Button { model.trashPlain() } label: { BracketLabel(word: "Move to Trash") }.buttonStyle(BracketButtonStyle(role: .primary, size: 12))
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(Color.waiting.opacity(0.1))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let list = model.secrets {
                        if list.isEmpty { Text("这个房间还没有密钥。").font(.system(size: 12.5)).foregroundStyle(Look.ink2).padding(.vertical, 16) }
                        ForEach(list) { s in row(s); HairRule(color: Look.line) }
                    } else {
                        BrailleSpinner().padding(.vertical, 24).frame(maxWidth: .infinity)
                    }
                }
            }
            .frame(height: adding ? 200 : 320)
            .padding(.horizontal, 16).padding(.vertical, 8)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if let said = model.secretsSaid { Text(said).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(2) }
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Close", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .frame(width: 680)
        .roomFloat()
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField("名称（如 GitHub 登录）", text: $draft.name).textFieldStyle(.roundedBorder)
                Picker("", selection: $draft.kind) { ForEach(RoomSecret.Kind.allCases, id: \.self) { Text($0.word).tag($0) } }.labelsHidden().fixedSize()
            }
            HStack(spacing: 8) {
                if draft.kind != .exec { TextField("网址（https://…）", text: $draft.url).textFieldStyle(.roundedBorder) }
                if draft.kind == .site { TextField("账号", text: $draft.account).textFieldStyle(.roundedBorder) }
                if draft.kind == .exec { TextField("环境变量名（如 OPENAI_API_KEY）", text: $draft.env).textFieldStyle(.roundedBorder) }
            }
            HStack(spacing: 8) {
                SecureField(draft.kind == .site ? "密码" : "密钥", text: $draft.value).textFieldStyle(.roundedBorder)
                Button {
                    let d = draft
                    Task { if await model.addSecrets([d]) { draft = RoomSecretDraft(kind: d.kind); adding = false } else { draft.value = "" } }
                } label: { if model.sealing { BrailleSpinner() } else { BracketLabel(word: "Seal & Add") } }
                .buttonStyle(BracketButtonStyle(role: .primary, size: 12))
                .disabled(draft.problem != nil || model.sealing)
                .help(draft.problem ?? "用这台 Mac 的网关封成密文，加进房间。")
            }
        }
    }

    private func row(_ s: RoomSecret) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(s.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Look.ink)
                    Text(s.kind.word).mono(11).foregroundStyle(Look.ink2)
                }
                Text([s.url, s.account, s.env].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 12)).foregroundStyle(Look.ink2).lineLimit(1)
                Text(s.token.prefix(28) + "…").mono(11).foregroundStyle(Look.faint).textSelection(.enabled).help(s.token)
            }
            Spacer()
            Button { model.removeSecret(s) } label: { BracketLabel(word: "Remove") }.buttonStyle(BracketButtonStyle(size: 12))
        }
        .padding(.vertical, 8)
    }

    private func open(_ types: [String]) -> URL? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = types.compactMap { UTType(filenameExtension: $0) }
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url : nil
    }

    private func save(_ name: String, _ write: (URL) throws -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try write(url) } catch { NSSound.beep() }
    }
}

/// The room's replacement words (docs/model-gate-v0.md; user #343): besides the global ones of Settings › Redaction,
/// the members sitting in this room have these replaced on their way to the model too. Offered while the global switch
/// is on.
struct RoomWordsSheet: View {
    @Bindable var model: RoomsModel
    @State private var value = ""
    @State private var replace = ""
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("Words").mono(look.isClassic ? 14 : 12.5, weight: .semibold).foregroundStyle(Look.ink)
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(look.isClassic ? Color.clear : Look.raised)
            HairRule(color: Look.line)
            Text("坐在这个房间里的成员访问模型时，除了「设置 › Redaction」里的全局替换词，还会替换这里的词：发出去前换成占位符，回来时换回原词。留空「替换成」就用加盐哈希。")
                .font(.system(size: 12)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16).padding(.top, 10)
            HStack(spacing: 8) {
                TextField("", text: $value, prompt: Text("要替换的词")).textFieldStyle(.roundedBorder)
                TextField("", text: $replace, prompt: Text("替换成（留空：加盐哈希）")).textFieldStyle(.roundedBorder)
                Button {
                    let v = value, r = replace
                    Task { if await model.addRoomWord(v, replace: r) { value = ""; replace = "" } }
                } label: { BracketLabel(word: "Add") }
                .buttonStyle(BracketButtonStyle(role: .primary, size: 12))
                .disabled(value.trimmingCharacters(in: .whitespaces).count < 3)
            }
            .labelsHidden()
            .padding(.horizontal, 16).padding(.top, 10)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let list = model.roomWords {
                        if list.isEmpty { Text("这个房间还没有额外的替换词。").font(.system(size: 12.5)).foregroundStyle(Look.ink2).padding(.vertical, 16) }
                        ForEach(list) { w in row(w); HairRule(color: Look.line) }
                    } else {
                        BrailleSpinner().padding(.vertical, 24).frame(maxWidth: .infinity)
                    }
                }
            }
            .frame(height: 260)
            .padding(.horizontal, 16).padding(.vertical, 8)
            HairRule(color: Look.line)
            HStack(spacing: 10) {
                if let said = model.wordsSaid { Text(said).font(.system(size: 12)).foregroundStyle(Color.waiting).lineLimit(3) }
                Spacer()
                Button { model.sheet = nil } label: { BracketLabel(word: "Close", key: "esc") }.buttonStyle(BracketButtonStyle()).keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .frame(width: 600)
        .roomFloat()
    }

    private func row(_ w: RedactWord) -> some View {
        HStack(spacing: 10) {
            Text(w.value).mono(12.5).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.middle)
            Text("→").foregroundStyle(Look.faint)
            Text(w.replace ?? "加盐哈希").font(.system(size: 12.5)).foregroundStyle(w.replace == nil ? Look.ink2 : Look.ink).lineLimit(1)
            if !w.restore { Text("只替换").font(.system(size: 11)).foregroundStyle(Color.waiting) }
            Spacer()
            Button { model.removeRoomWord(w) } label: { BracketLabel(word: "Remove") }.buttonStyle(BracketButtonStyle(size: 12))
        }
        .padding(.vertical, 8)
    }
}
