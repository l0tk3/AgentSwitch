import AgentSwitchMacCore
import ImageIO
import SwiftUI

// The Chat Room page's parts (docs/chatroom-v0.md §10; concept `docs/design/concepts/chatroom.html`): a seat's face, a
// state's mark and word, a message's row, a member's row and card. Each is drawn in the look in force: pixels, keys and
// `[ Word ]` in the pixel look; dots, round corners and standard buttons in the classic one.

extension Color {
    /// The ten colours a face comes in, by day and by night.
    static let faces: [Color] = (0..<10).map { Color(nsColor: .dynamic(light: RoomFace.light[$0], dark: RoomFace.dark[$0], name: "AgentSwitchFace\($0)")) }
}

/// A seat's face (§1 头像): its pattern in its colour — squares in the pixel look, round dots in the classic one. The
/// user is a fixed `YOU`. A seat without a face (an older service) is its handle's first letter.
struct RoomFaceView: View {
    let seat: RoomSeat?
    /// The box's side; the cell is a fifth of what is left inside it.
    var side: CGFloat = 26
    var cell: CGFloat = 4
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let classic = look.isClassic
        let color = seat?.face.map { Color.faces[$0.colorIndex] } ?? Look.ink
        Group {
            if seat?.isUser == true {
                Text("YOU").font(.system(size: side * 0.38, weight: .bold, design: classic ? .default : .monospaced))
                    .foregroundStyle(classic ? Color.white : Look.ground)
                    .frame(width: side, height: side)
                    .background(classic ? Color.signal : Look.ink)
            } else if let face = seat?.face, !face.cells.isEmpty {
                pattern(face, color: color, classic: classic)
                    .frame(width: side, height: side)
                    .background(classic ? color.opacity(0.2) : Color.clear)
                    .background(classic ? Look.raised : Color.clear)
                    .overlay { if !classic { Rectangle().strokeBorder(color.opacity(0.45), lineWidth: 1) } }
            } else {
                Text(String(seat?.handle.prefix(1) ?? "?").uppercased()).mono(side * 0.45, weight: .semibold).foregroundStyle(Look.ink2)
                    .frame(width: side, height: side)
                    .overlay { if !classic { Rectangle().strokeBorder(Look.line, lineWidth: 1) } }
                    .background(classic ? Look.raised : Color.clear)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: classic ? side * 0.3 : 0, style: .continuous))
        .accessibilityLabel(seat.map { $0.isUser ? "You" : "@\($0.handle)" } ?? "")
    }

    private func pattern(_ face: RoomFace, color: Color, classic: Bool) -> some View {
        let cells = face.cells
        // The classic look's dots stand a point apart; the pixel look's squares touch.
        let step = classic ? cell + 1 : cell
        let size = classic ? 5 * step - 1 : 5 * cell
        return Canvas { context, _ in
            var path = Path()
            for c in cells {
                let rect = CGRect(x: CGFloat(c.x) * step, y: CGFloat(c.y) * step, width: cell, height: cell)
                if classic { path.addRoundedRect(in: rect, cornerSize: CGSize(width: cell * 0.35, height: cell * 0.35)) } else { path.addRect(rect) }
            }
            context.fill(path, with: .color(color))
        }
        .frame(width: size, height: size)
    }
}

/// A seat's state as a mark (§6.1). Amber is what needs the user's hands, red what went wrong; what mends itself has no
/// colour: a grey spinner while it tries again, a dithered key (a faded dot) while it only waits.
struct SeatStateMark: View {
    let state: SeatState
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Group {
            switch state.tone {
            case .working: BrailleSpinner()
            case .retrying: BrailleSpinner().saturation(0)
            case .needsYou: BlinkingSquare()
            case .ready: StatusMark(level: .ok)
            case .off: StatusMark(level: .off)
            case .failed: StatusMark(level: .error)
            case .held:
                if look.isClassic {
                    Circle().fill(Look.ink2.opacity(0.45)).frame(width: 8, height: 8)
                } else {
                    Canvas { context, _ in
                        var path = Path()
                        for y in 0..<4 { for x in 0..<4 where (x + y) % 2 == 0 { path.addRect(CGRect(x: x * 2, y: y * 2, width: 2, height: 2)) } }
                        context.fill(path, with: .color(Look.ink2))
                    }
                    .frame(width: 8, height: 8)
                }
            }
        }
        .frame(width: 10, height: 10)
        .accessibilityLabel(state.word)
    }
}

extension SeatState {
    /// The word's colour where a state is written out alone (the card): amber and red as the mark, the rest quiet.
    var wordColor: Color {
        switch tone {
        case .needsYou: .waiting
        case .failed: .failed
        case .working, .retrying, .ready, .off, .held: Look.ink
        }
    }
}

// MARK: - a message

/// What a message's row asks of the page.
struct RoomRowActions {
    var card: (String) -> Void = { _ in }
    var reply: (Int) -> Void = { _ in }
    /// Shows a message's file in Finder; nil where the room is another node's (the path is that node's).
    var reveal: ((String) -> Void)?
    /// Opens a message's file in a preview (Quick Look); nil where the room is another node's.
    var preview: ((String) -> Void)?
    /// The timeline narrowed to a task's messages (its label clicked).
    var task: (Int) -> Void = { _ in }
}

/// One message (§10): the speaker's face, name and the time on the first of a run; the quoted one above a reply; the
/// text with its `@names`; and, while anything is still on its way, one small line saying to whom.
struct RoomMessageRow: View {
    let row: RoomRow
    let room: Room
    let actions: RoomRowActions
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    private var message: RoomMessage { row.message }
    private var handles: Set<String> { Set(room.seats.map(\.handle)) }

    var body: some View {
        let seat = room.seat(message.from)
        HStack(alignment: .top, spacing: 12) {
            if row.continues {
                Color.clear.frame(width: 26, height: 1)
            } else {
                Button { actions.card(message.from) } label: { RoomFaceView(seat: seat) }.buttonStyle(.plain).padding(.top, 1)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let quoted = message.replyTo.flatMap({ n in room.messages.first { $0.seq == n } }) { quote(quoted) }
                if !row.continues { head(seat) }
                Text(RoomRich.text(message.text, handles: handles, look: look))
                    .font(.system(size: Look.scaled(13.5)))
                    .lineSpacing(4)
                    .foregroundStyle(Look.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !message.files.isEmpty { files }
                receipts
                readers
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.top, row.continues ? 1 : 9)
        .padding(.bottom, 3)
        .background(row.forYou && look.isClassic ? Color.waiting.opacity(0.09) : hovering ? Look.hover : Color.clear)
        // For the user and not yet seen: amber, the colour of what waits for you.
        .overlay(alignment: .leading) { if row.forYou { Rectangle().fill(Color.waiting).frame(width: 3) } }
        .overlay(alignment: .topTrailing) {
            if hovering {
                HStack(spacing: 8) {
                    Text("#\(message.seq)").mono(11).foregroundStyle(Look.faint)
                    Button { actions.reply(message.seq) } label: { LookGlyph(glyph: "↩", symbol: "arrowshape.turn.up.left", size: 13) }
                        .buttonStyle(.plain).foregroundStyle(Look.ink2).help("Reply")
                }
                .padding(.trailing, 14).padding(.top, row.continues ? 1 : 9)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Reply") { actions.reply(message.seq) }
            Button("Copy") { Clipboard.copy(message.text) }
        }
    }

    private func head(_ seat: RoomSeat?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button { actions.card(message.from) } label: {
                Text(seat?.isUser == true ? "You" : message.from).mono(13, weight: .semibold).foregroundStyle(Look.ink)
            }
            .buttonStyle(.plain)
            if let agent = seat?.card?.agent { AgentSprite(harness: agent).scaleEffect(0.8).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 } }
            Text(TimeText.at(message.date)).mono(11.5).foregroundStyle(Look.faint)
            if let n = message.task { RoomTaskLabel(n: n, title: room.tasks.first { $0.n == n }?.title) { actions.task(n) } }
        }
        .lineLimit(1)
    }

    private func quote(_ quoted: RoomMessage) -> some View {
        HStack(spacing: 6) {
            if look.isClassic {
                Rectangle().fill(Look.line).frame(width: 2, height: 13)
            } else {
                Text("┌─").code(12).foregroundStyle(Look.faint)
            }
            Text(quoted.from == Room.you ? "You" : quoted.from).font(.system(size: 12, weight: .medium))
            Text(RoomText.quote(quoted.text, handles: handles)).font(.system(size: 12)).truncationMode(.tail)
        }
        .lineLimit(1)
        .foregroundStyle(Look.ink2)
    }

    /// The files a message comes with (§3 附件), as in a chat: a picture is shown, any other file is a card with its
    /// icon, name and size. A click opens it in a preview; the menu shows it in Finder. Where the room is another
    /// node's the path is that node's: a name only.
    private var files: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(message.files, id: \.self) { path in
                if actions.preview == nil {
                    HStack(spacing: 6) {
                        LookGlyph(glyph: "⎘", symbol: "paperclip", size: 12)
                        Text((path as NSString).lastPathComponent).mono(12).lineLimit(1).truncationMode(.middle)
                    }
                    .foregroundStyle(Look.ink2)
                    .help(path)
                } else {
                    Button { actions.preview?(path) } label: {
                        if let image = RoomPictures.thumb(path) {
                            Image(nsImage: image).resizable().interpolation(.medium).aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 320, maxHeight: 200, alignment: .leading)
                                .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0))
                                .framed(Look.line, radius: look.isClassic ? 8 : 0)
                        } else {
                            HStack(spacing: 9) {
                                Image(nsImage: RoomPictures.icon(path)).resizable().frame(width: 30, height: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((path as NSString).lastPathComponent).font(.system(size: 12.5)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.middle)
                                    Text(RoomPictures.note(path)).mono(11).foregroundStyle(Look.faint).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .frame(width: 300, alignment: .leading)
                            .grounded(Look.raised, radius: look.isClassic ? 8 : 0)
                            .framed(Look.line, radius: look.isClassic ? 8 : 0)
                            .contentShape(Rectangle())
                        }
                    }
                    .buttonStyle(.plain)
                    .help(path)
                    .contextMenu {
                        Button("Quick Look") { actions.preview?(path) }
                        Button("Show in Finder") { actions.reveal?(path) }
                        Button("Copy Path") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(path, forType: .string) }
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    /// Who of those it was for has read it (user, 2026-11-23): `✓ daemon ios` — and who has not, when nothing else
    /// says so already (a receipt still open says where it is).
    @ViewBuilder
    private var readers: some View {
        let who = room.readers(of: message)
        let waiting = Set(room.receipts(of: message.seq).map(\.handle))
        let unread = who.unread.filter { !waiting.contains($0) }
        if !who.read.isEmpty || !unread.isEmpty {
            HStack(spacing: 12) {
                if !who.read.isEmpty { Text((look.isClassic ? "Read · " : "✓ ") + who.read.joined(separator: " ")).foregroundStyle(Look.faint) }
                if !unread.isEmpty { Text((look.isClassic ? "Unread · " : "○ ") + unread.joined(separator: " ")).foregroundStyle(Look.ink2) }
            }
            .mono(11.5)
            .lineLimit(1)
            .padding(.top, 1)
            .help("已读：这条消息整条送到了它面前，或者它自己读了房间。")
        }
    }

    @ViewBuilder
    private var receipts: some View {
        let open = room.receipts(of: message.seq)
        if !open.isEmpty {
            // Said only while it matters: what everyone has taken says nothing.
            HStack(spacing: 12) {
                ForEach(open, id: \.handle) { item in
                    Text(RoomText.receipt(item.receipt, to: room.seat(item.handle), handle: item.handle, classic: look.isClassic))
                        .foregroundStyle(RoomText.failed(item.receipt) ? Color.failed : item.receipt == .sent ? Look.faint : Look.ink2)
                }
            }
            .mono(11.5)
            .lineLimit(1)
            .padding(.top, 1)
        }
    }
}

enum RoomRich {
    /// A message's text as it is drawn: code in fixed-width letters on a wash, an `@name` bold in the pixel look and in
    /// the accent in the classic one — never a status colour — and the user's own name alone on a ground.
    static func text(_ text: String, handles: Set<String>, look: InterfaceLook) -> AttributedString {
        var out = AttributedString()
        let size = Look.scaled(13.5)
        var lineStart = true
        for piece in RoomText.pieces(text, handles: handles) {
            defer {
                switch piece {
                case .plain(let s), .code(let s): lineStart = s.hasSuffix("\n")
                case .mention: lineStart = false
                }
            }
            switch piece {
            case .plain(let s):
                out += markdown(s, lineStart: lineStart, size: size)
            case .code(let s):
                var run = AttributedString(s)
                run.font = .system(size: size - 1, design: .monospaced)
                run.backgroundColor = Look.code
                out += run
            case .mention(let name):
                var run = AttributedString("@\(name)")
                let me = name == Room.you
                if look.isClassic {
                    run.font = .system(size: size, weight: .medium)
                    run.foregroundColor = me ? .white : Color.signal
                    if me { run.backgroundColor = Color.signal }
                } else {
                    run.font = .system(size: size - 0.5, weight: .semibold, design: .monospaced)
                    run.foregroundColor = me ? Look.ground : Look.ink
                    if me { run.backgroundColor = Look.ink }
                }
                out += run
            }
        }
        return out
    }

    /// The Markdown of a stretch of plain text (2026-11-23, user: md没正确渲染): bold, italic, strikethrough and links
    /// as they read; a heading's line bold; a list's `-` / `*` a bullet. Lines stay as written (no reflowing), and
    /// what does not parse is shown as typed.
    static func markdown(_ s: String, lineStart: Bool, size: CGFloat) -> AttributedString {
        var out = AttributedString()
        let lines = s.components(separatedBy: "\n")
        for (i, raw) in lines.enumerated() {
            if i > 0 { out += AttributedString("\n") }
            var line = Substring(raw)
            var heading = false
            if i > 0 || lineStart {
                if let m = line.firstMatch(of: /^#{1,6}\s+/) { line = line[m.range.upperBound...]; heading = true }
                else if let m = line.firstMatch(of: /^(\s*)[-*+]\s+/) { out += AttributedString(m.output.1 + "• "); line = line[m.range.upperBound...] }
            }
            var run = (try? AttributedString(markdown: String(line), options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(line)
            for r in run.runs where r.inlinePresentationIntent?.contains(.code) == true {
                run[r.range].font = .system(size: size - 1, design: .monospaced)
                run[r.range].backgroundColor = Look.code
            }
            if heading { run.font = .system(size: size, weight: .semibold) }
            out += run
        }
        return out
    }
}

/// The day's line between messages of different days.
struct RoomDayLine: View {
    let day: String

    var body: some View {
        HStack(spacing: 10) {
            HairRule(color: Look.line)
            Text(day).mono(11.5).foregroundStyle(Look.faint).fixedSize()
            HairRule(color: Look.line)
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }
}

// MARK: - members

/// A member in the list: its face with its state's mark off the corner, `@handle` over its state in a word, its agent
/// and its profile's dot at the row's end.
struct RoomMemberRow: View {
    let seat: RoomSeat
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                RoomFaceView(seat: seat, side: 22, cell: 3)
                    .overlay(alignment: .bottomTrailing) {
                        if let state = seat.state {
                            SeatStateMark(state: state).scaleEffect(0.9)
                                .frame(width: 12, height: 12)
                                .background(Look.ground)
                                .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 6 : 0))
                                .offset(x: 4, y: 4)
                        }
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text("@\(seat.handle)").mono(12.5).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.tail)
                    HStack(spacing: 0) {
                        Text(ClassicWords.phrase(sub, in: look)).foregroundStyle(Look.faint)
                        // Without the Kit it must be resumed once (§6): it needs the user, so amber, with its words.
                        if seat.needsResume { Text(sub.isEmpty ? "No Kit" : " · No Kit").foregroundStyle(Color.waiting) }
                    }
                    .mono(11).lineLimit(1)
                }
                Spacer(minLength: 4)
                if let agent = seat.card?.agent { AgentSprite(harness: agent) }
                if let color = seat.card?.profileColor { ProfileDot(color: color).help("配置 \(seat.card?.profile ?? "")") }
            }
            .padding(.horizontal, look.isClassic ? 6 : 12)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: look.isClassic ? 7 : 0).fill(hovering ? Look.hover : Color.clear))
            .padding(.horizontal, look.isClassic ? 6 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    private var sub: String { [seat.state?.word, seat.canAdd ? "Admin" : nil, seat.muted ? "Muted" : nil, seat.unread > 0 ? "\(seat.unread) Unread" : nil].compactMap { $0 }.joined(separator: " · ") }
}

/// A member's card (§1 名片): who it is, where, in what state, who seated it; the Kit's one switch (§6); and what the
/// user can do with it. No account, no address.
struct RoomMemberCard: View {
    let seat: RoomSeat
    let home: String
    /// What it says it is changing now (§9).
    var claim: RoomClaim? = nil
    let setCanAdd: (Bool) -> Void
    let setMuted: (Bool) -> Void
    let resume: () -> Void
    let mention: () -> Void
    let kick: () -> Void
    /// Out of the room and its terminal closed; true: its conversation's record deleted too.
    var end: (Bool) -> Void = { _ in }
    /// Its nickname in this room.
    var rename: (String) -> Void = { _ in }
    /// Its own terminal, on the Terminals page; nil: it has none here.
    var openTerminal: (() -> Void)? = nil
    @State private var renaming = false
    @State private var newName = ""
    @Environment(\.interfaceLook) private var look

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                RoomFaceView(seat: seat)
                Text("@\(seat.handle)").font(.system(size: 14, weight: .semibold)).foregroundStyle(Look.ink).lineLimit(1)
                Spacer(minLength: 4)
                if let state = seat.state { SeatStateMark(state: state) }
                if let color = seat.card?.profileColor { ProfileDot(color: color) }
            }
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
                if let card = seat.card {
                    line("Agent", HarnessName.display(card.agent))
                    if let model = card.model { line("Model", ModelName.display(model)) }
                    line("Profile", card.profile ?? "Default")
                    line("Node", card.node ?? "This Node")
                    line("Folder", DisplayPath.short(card.cwd, home: home), mono: true)
                    if let mode = card.mode { line("Mode", ClassicWords.word(mode, in: look)) }
                }
                if let state = seat.state { line("State", ClassicWords.word(state.word, in: look), color: state.wordColor) }
                if seat.needsResume { line("Kit", "No Kit", color: .waiting) }
                if seat.canAdd { line("Role", "Admin") }
                if seat.muted { line("Muted", "by @" + (seat.mutedBy ?? "?"), color: .waiting) }
                line("Seated By", seat.addedBy == Room.you ? "You" : "@\(seat.addedBy)")
                if seat.here { line("Unread", seat.unread == 0 ? "Read everything" : "\(seat.unread) messages", help: "房间里它还没读过的消息数（它入座之后别人说的）。") }
                if let asks = seat.asks { line("Asks", asks.title, color: .waiting, help: asks.options.joined(separator: "\n")) }
                if let stats = seat.stats { line("Room Cost", stats.says, help: "这个成员在房间里的开销：被唤醒几次、送进去多少字、发了几条消息、调了几次房间工具。花了多少 token 要看它自己的用量。") }
                if let claim { line("Changing", "\(claim.names) → \(claim.untilDate.formatted(date: .omitted, time: .shortened))", mono: true, help: claim.paths.joined(separator: "\n") + (claim.why.map { "\n\($0)" } ?? "")) }
            }
            .padding(.top, 10)
            .padding(.bottom, 12)
            if seat.here {
                HairRule(color: Look.line)
                Button { setCanAdd(!seat.canAdd) } label: {
                    HStack(spacing: 10) {
                        Text("Admin").mono(12.5)
                        Spacer()
                        if look.isClassic {
                            Toggle("", isOn: .constant(seat.canAdd)).labelsHidden().toggleStyle(.switch).controlSize(.mini).allowsHitTesting(false)
                        } else {
                            Text(seat.canAdd ? "[x]" : "[ ]").code(12.5)
                        }
                    }
                    .foregroundStyle(seat.byAgent ? Look.faint : Look.ink)
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(seat.byAgent)
                .help("管理员：可以拉人、恢复已结束的会话、禁言和踢人。")
                HairRule(color: Look.line)
                if seat.needsResume {
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        BlinkingSquare()
                        Text(RoomSeat.needsResumeSays).font(.system(size: 12)).foregroundStyle(Look.ink).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 8)
                }
                if seat.muted {
                    Text("已禁言（@\(seat.mutedBy ?? "?")）。还能读、还能干活，但不能发消息、不能写置顶笔记。").font(.system(size: 12)).foregroundStyle(Look.faint).lineSpacing(3).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
                }
                if let says = seat.byAgent ? "由别的会话拉起来的会话不能再拉人。" : seat.state?.says {
                    Text(says).font(.system(size: 12)).foregroundStyle(Look.faint).lineSpacing(3).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
                }
                if seat.state == .exited {
                    Button(action: resume) { BracketLabel(word: "Resume", key: "↩") }
                        .buttonStyle(BracketButtonStyle(role: .primary))
                        .help("用同一个会话、同一个配置恢复这个成员；席位名字和颜色不变。")
                        .padding(.top, 10)
                }
                // What is done with a member: what goes on with it in two short rows at the left (they fit the card in
                // both looks), then, under a rule and at the right, the three in red that take it out, in the order of
                // how much they undo.
                HStack(spacing: 6) {
                    if let openTerminal, seat.state != .exited {
                        wide("Terminal", role: .primary, help: "跳到它自己的终端。", action: openTerminal)
                    }
                    wide("Mention", help: "在输入框里 @ 它。", action: mention)
                    Spacer(minLength: 0)
                }
                .padding(.top, 10)
                HStack(spacing: 6) {
                    wide("Rename", help: "改它在这个房间里的名字。") { renaming.toggle(); newName = seat.handle }
                    wide(seat.muted ? "Unmute" : "Mute", help: "禁言：还能读、还能干活，但不能发消息、不能写置顶笔记。") { setMuted(!seat.muted) }
                    Spacer(minLength: 0)
                }
                .padding(.top, 6)
                if renaming {
                    HStack(spacing: 6) {
                        RoomField(prompt: "New name in this room", text: $newName, submit: { if !newName.trimmingCharacters(in: .whitespaces).isEmpty { rename(newName) } })
                        Button { rename(newName) } label: { BracketLabel(word: "Save", key: "↩") }
                            .buttonStyle(BracketButtonStyle(role: .primary)).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(.top, 6)
                    Text("只改它在这个房间里的名字（@ 它时用的）；会话自己的名字不变。旧名字仍然能叫到它。").font(.system(size: 11.5)).foregroundStyle(Look.faint).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
                }
                HairRule(color: Look.line).padding(.top, 10)
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    wide("Kick", role: .destructive, help: "移出房间；会话本身继续运行，之后还能再拉进来。", action: kick)
                    wide("End", role: .destructive, help: "移出房间并关掉它的终端；对话记录留着，之后还能恢复。") { end(false) }
                    wide("Delete", role: .destructive, help: "移出房间、关掉终端，并删除它的对话记录。删了就恢复不了。") { end(true) }
                }
                .padding(.top, 10)
            } else {
                Text("已离开房间。").font(.system(size: 12)).foregroundStyle(Look.faint)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(width: 300)
        .roomFloat()
    }

    /// One of the card's buttons.
    private func wide(_ word: String, role: BracketButtonStyle.Role = .normal, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { BracketLabel(word: word) }
            .buttonStyle(BracketButtonStyle(role: role, size: 12))
            .help(help)
    }

    private func line(_ label: String, _ value: String, mono: Bool = false, color: Color = Look.ink, help: String? = nil) -> some View {
        GridRow {
            Text(label).mono(12).foregroundStyle(Look.faint).gridColumnAlignment(.leading)
            Text(value).font(.system(size: 12, design: mono ? .monospaced : .default)).foregroundStyle(color).lineLimit(1).truncationMode(.middle).help(help ?? value)
        }
    }
}

/// Pictures a message comes with, read once each and kept small.
@MainActor
enum RoomPictures {
    private static let kept = NSCache<NSString, NSImage>()
    private static let kinds: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp"]

    static func thumb(_ path: String) -> NSImage? {
        guard kinds.contains((path as NSString).pathExtension.lowercased()) else { return nil }
        if let image = kept.object(forKey: path as NSString) { return image }
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let small = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 720, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        let image = NSImage(cgImage: small, size: NSSize(width: small.width / 2, height: small.height / 2))
        kept.setObject(image, forKey: path as NSString)
        return image
    }

    /// The file's own icon, as Finder shows it.
    static func icon(_ path: String) -> NSImage { NSWorkspace.shared.icon(forFile: path) }

    /// `12 KB · Markdown`, a folder's word, or that the file is not there any more.
    static func note(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey, .localizedTypeDescriptionKey]) else { return "Not Found" }
        if values.isDirectory == true { return "Folder" }
        let size = ByteCountFormatter.string(fromByteCount: Int64(values.fileSize ?? 0), countStyle: .file)
        return [size, values.localizedTypeDescription].compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - what floats

extension View {
    /// What floats over the page: a 1 px ink frame over a dithered hard shadow in the pixel look; a round card with a
    /// soft shadow in the classic one.
    func roomFloat() -> some View { modifier(RoomFloat()) }
}

private struct RoomFloat: ViewModifier {
    @Environment(\.interfaceLook) private var look

    func body(content: Content) -> some View {
        if look.isClassic {
            let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
            content.background(shape.fill(Look.panel)).overlay(shape.strokeBorder(Look.line, lineWidth: 0.5)).clipShape(shape)
                .shadow(color: .black.opacity(0.3), radius: 16, y: 8)
        } else {
            content.background(Look.ground).overlay(Rectangle().strokeBorder(Look.ink, lineWidth: 1))
                .background(Checker().offset(x: 6, y: 6))
        }
    }
}

/// A text field of a sheet: a framed box on the raised ground.
struct RoomField: View {
    let prompt: String
    @Binding var text: String
    var submit: () -> Void = {}

    var body: some View {
        TextField(prompt, text: $text)
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            .foregroundStyle(Look.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .grounded(Look.raised, radius: Look.controlRadius)
            .framed(Look.line, radius: Look.controlRadius)
            .onSubmit(submit)
    }
}

/// A message's task (2026-11-24, user: 给消息加tag): `T3 登录接口`; a click shows that task's messages alone.
struct RoomTaskLabel: View {
    let n: Int
    let title: String?
    var action: () -> Void = {}
    @Environment(\.interfaceLook) private var look

    var body: some View {
        Button(action: action) {
            Text(Self.word(n, title)).mono(11).foregroundStyle(Look.ink2).lineLimit(1)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .grounded(look.isClassic ? Look.raised : Color.clear, radius: 4)
                .framed(Look.line, radius: look.isClassic ? 4 : 0)
        }
        .buttonStyle(.plain)
        .help("只看这个任务的消息")
    }

    /// `T3 登录接口`, the title cut to what fits beside a name.
    static func word(_ n: Int, _ title: String?) -> String {
        guard let title, !title.isEmpty else { return "T\(n)" }
        return "T\(n) " + (title.count > 20 ? String(title.prefix(19)) + "…" : title)
    }
}
