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

/// A seat's face (§1 头像), as its session chose it (2026-11-24, user #203: 像素风格的时候像素风头像，classic 风格的时候
/// 正常头像): in the pixel look its pixel avatar — a face of the library or drawn, or a 16 × 16 character — else the
/// seat's own face; in the classic look its emoji on a round ground, else its initials on the face's colour. The user is
/// a fixed `YOU`.
struct RoomFaceView: View {
    let seat: RoomSeat?
    /// The box's side; the cell is a fifth of what is left inside it.
    var side: CGFloat = 26
    var cell: CGFloat = 4
    @Environment(\.interfaceLook) private var look

    var body: some View {
        let classic = look.isClassic
        Group {
            if seat?.isUser == true {
                Text("YOU").font(.system(size: side * 0.38, weight: .bold, design: classic ? .default : .monospaced))
                    .foregroundStyle(classic ? Color.white : Look.ground)
                    .frame(width: side, height: side)
                    .background(classic ? Color.signal : Look.ink)
            } else if classic {
                RoomClassicAvatar(seat: seat, side: side)
            } else if case .grid = seat?.avatar?.pixel {
                RoomGridAvatar(pixel: seat!.avatar!.pixel!, side: side)
                    .overlay { Rectangle().strokeBorder(Look.line, lineWidth: 1) }
            } else if let face = seat.flatMap({ s in if case .face(_, let f)? = s.avatar?.pixel { return f } else { return s.face } }), !face.cells.isEmpty {
                let color = Color.faces[face.colorIndex]
                RoomFacePattern(face: face, cell: cell, color: color)
                    .frame(width: side, height: side)
                    .overlay { Rectangle().strokeBorder(color.opacity(0.45), lineWidth: 1) }
            } else {
                Text(String(seat?.handle.prefix(1) ?? "?").uppercased()).mono(side * 0.45, weight: .semibold).foregroundStyle(Look.ink2)
                    .frame(width: side, height: side)
                    .overlay { Rectangle().strokeBorder(Look.line, lineWidth: 1) }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: classic ? side / 2 : 0, style: .continuous))
        // Taken back on Claude's safeguard (user #288): marked until the user has seen it on its card.
        .overlay(alignment: .topTrailing) {
            if let r = seat?.rewound, r.marked {
                Text("↺").font(.system(size: max(side * 0.32, 8), weight: .bold)).foregroundStyle(.white)
                    .frame(width: max(side * 0.44, 11), height: max(side * 0.44, 11))
                    .background(Circle().fill(Color.orange))
                    .offset(x: side * 0.16, y: -side * 0.16)
                    .help(r.says)
            }
        }
        .accessibilityLabel(seat.map { $0.isUser ? "You" : "@\($0.handle)" + ($0.rewound?.marked == true ? "，已退回" : "") } ?? "")
    }
}

/// A 5 × 5 face: squares that touch.
struct RoomFacePattern: View {
    let face: RoomFace
    var cell: CGFloat = 4
    let color: Color

    var body: some View {
        let cells = face.cells
        Canvas { context, _ in
            var path = Path()
            for c in cells { path.addRect(CGRect(x: CGFloat(c.x) * cell, y: CGFloat(c.y) * cell, width: cell, height: cell)) }
            context.fill(path, with: .color(color))
        }
        .frame(width: 5 * cell, height: 5 * cell)
    }
}

/// A 16 × 16 pixel character, each cell its colour, filling the box.
struct RoomGridAvatar: View {
    let pixel: RoomAvatar.Pixel
    let side: CGFloat

    var body: some View {
        let cells = pixel.cells
        Canvas { context, size in
            let step = size.width / 16
            for c in cells {
                context.fill(Path(CGRect(x: CGFloat(c.x) * step, y: CGFloat(c.y) * step, width: step + 0.3, height: step + 0.3)), with: .color(Color(red: Double((c.rgb >> 16) & 0xFF) / 255, green: Double((c.rgb >> 8) & 0xFF) / 255, blue: Double(c.rgb & 0xFF) / 255)))
            }
        }
        .frame(width: side, height: side)
        .background(Look.raised)
    }
}

/// The classic look's avatar: its emoji, or its initials, on a round ground of a face colour.
struct RoomClassicAvatar: View {
    let seat: RoomSeat?
    let side: CGFloat

    var body: some View {
        let chosen = seat?.avatar?.classic
        let bg = Color.faces[((chosen?.bg ?? seat?.face?.colorIndex ?? 0) % 10 + 10) % 10]
        ZStack {
            Circle().fill(chosen == nil ? bg : bg.opacity(0.28))
            if let chosen {
                Text(chosen.emoji).font(.system(size: side * 0.58))
            } else {
                Text(Self.initials(seat?.handle ?? "?")).font(.system(size: side * 0.4, weight: .semibold)).foregroundStyle(Color.white)
            }
        }
        .frame(width: side, height: side)
    }

    /// `mac-app` → `MA`, `daemon` → `DA`, `ios2` → `IO`.
    static func initials(_ handle: String) -> String {
        let words = handle.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." }).filter { !$0.isEmpty }
        if words.count >= 2 { return words.prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased() }
        return String(handle.prefix(2)).uppercased()
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
    /// Opens a message's file in a preview (Quick Look); a room on another node's: fetched from there first.
    var preview: ((String) -> Void)?
    /// A room on another node: a message's file fetched from there into Downloads and opened (a click on it).
    var open: ((String) -> Void)?
    /// A room on another node: a message's file fetched from there and saved where the user says.
    var saveAs: ((String) -> Void)?
    /// A room on another node: a picture a message comes with, fetched from there (nil until it has come).
    var picture: ((String) -> NSImage?)?
    /// The timeline narrowed to a task's messages (its label clicked).
    var task: (Int) -> Void = { _ in }
    /// Brings a message into view (its quote clicked).
    var jump: (Int) -> Void = { _ in }
    /// The timeline shows one task: its messages' task labels say nothing and are not drawn.
    var inTask = false
    /// Lit for a moment: the message just gone to.
    var lit = false
    /// 戳一下: what waits for these members is given to them now.
    var poke: ([String]) -> Void = { _ in }
    /// 删除消息 (user #278): asks first.
    var delete: ((RoomMessage) -> Void)?
}

/// One message (§10): the speaker's face, name and the time on the first of a run; the quoted one above a reply; the
/// text with its `@names`; and, while anything is still on its way, one small line saying to whom.
struct RoomMessageRow: View {
    let row: RoomRow
    let room: Room
    let actions: RoomRowActions
    @State private var hovering = false
    /// A long message opened whole (user #280: 发送的消息太长的话可以折叠).
    @State private var expanded = false
    @Environment(\.interfaceLook) private var look

    private var message: RoomMessage { row.message }
    private var handles: Set<String> { Set(room.seats.map(\.handle)) }
    /// Folded to this many lines when longer.
    private static let foldLines = 12
    private var long: Bool { RoomText.isLong(message.text, lines: Self.foldLines) }

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
                if message.deleted {
                    Text("这条消息已删除").font(.system(size: Look.scaled(13))).italic().foregroundStyle(Look.faint)
                } else {
                    Text(RoomRich.text(message.text, handles: handles, look: look))
                        .font(.system(size: Look.scaled(13.5)))
                        .lineSpacing(4)
                        .foregroundStyle(Look.ink)
                        .textSelection(.enabled)
                        .lineLimit(long && !expanded ? Self.foldLines : nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .opacity(message.rewound ? 0.55 : 1)
                    if message.rewound {
                        Text("已退回 · 它退回到这之前了，不记得说过这条").font(.system(size: 11.5)).foregroundStyle(Look.faint)
                    }
                    if long {
                        Button { expanded.toggle() } label: {
                            Text(expanded ? "收起" : "展开全文").font(.system(size: 12)).foregroundStyle(Color.signal)
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 2)
                    }
                }
                if !message.files.isEmpty, !message.deleted { files }
                failures
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.top, row.continues ? 1 : 9)
        .padding(.bottom, 3)
        .background(actions.lit ? Color.signal.opacity(0.14) : row.forYou && look.isClassic ? Color.waiting.opacity(0.09) : hovering ? Look.hover : Color.clear)
        // For the user and not yet seen: amber, the colour of what waits for you.
        .overlay(alignment: .leading) { if row.forYou { Rectangle().fill(Color.waiting).frame(width: 3) } }
        .overlay(alignment: .bottomTrailing) { readCount.padding(.trailing, 14).padding(.bottom, 3) }
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
            if !message.deleted {
                Button("Reply") { actions.reply(message.seq) }
                Button("Copy") { Clipboard.copy(message.text) }
                ForEach(Array(RoomText.links(message.text).prefix(3)), id: \.self) { link in
                    Button("Copy Link  \(link.count > 48 ? String(link.prefix(48)) + "…" : link)") { Clipboard.copy(link) }
                }
                if long { Button(expanded ? "Collapse" : "Expand") { expanded.toggle() } }
                if let delete = actions.delete {
                    Divider()
                    Button("Delete Message…", role: .destructive) { delete(message) }
                }
            }
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
            if let n = message.task, !actions.inTask { RoomTaskLabel(n: n, title: room.tasks.first { $0.n == n }?.title) { actions.task(n) } }
        }
        .lineLimit(1)
    }

    /// The message answered, on one line above (2026-11-24, user: 引用标识里的内容加上 md 解析): its author and its first
    /// words drawn as the message is (bold, code); a click goes to it.
    private func quote(_ quoted: RoomMessage) -> some View {
        Button { actions.jump(quoted.seq) } label: {
            HStack(spacing: 6) {
                if look.isClassic {
                    Rectangle().fill(Look.line).frame(width: 2, height: 13)
                } else {
                    Text("┌─").code(12).foregroundStyle(Look.faint)
                }
                Text(quoted.from == Room.you ? "You" : quoted.from).font(.system(size: 12, weight: .medium))
                if quoted.deleted {
                    Text("已删除").font(.system(size: 12)).italic().foregroundStyle(Look.faint)
                } else {
                    Text(RoomRich.text(RoomText.quoteHead(quoted.text, handles: handles), handles: handles, look: look, size: 12)).truncationMode(.tail)
                }
            }
            .lineLimit(1)
            .foregroundStyle(Look.ink2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("跳到 #\(quoted.seq)")
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
                    Button { if let open = actions.open { open(path) } else { actions.preview?(path) } } label: {
                        if let image = actions.picture?(path) ?? RoomPictures.thumb(path) {
                            Image(nsImage: image).resizable().interpolation(.medium).aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 320, maxHeight: 200, alignment: .leading)
                                .clipShape(RoundedRectangle(cornerRadius: look.isClassic ? 8 : 0))
                                .framed(Look.line, radius: look.isClassic ? 8 : 0)
                        } else {
                            HStack(spacing: 9) {
                                Image(nsImage: RoomPictures.icon(path)).resizable().frame(width: 30, height: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((path as NSString).lastPathComponent).font(.system(size: 12.5)).foregroundStyle(Look.ink).lineLimit(1).truncationMode(.middle)
                                    Text(actions.open == nil ? RoomPictures.note(path) : "在另一台节点上 · 点开下载").mono(11).foregroundStyle(Look.faint).lineLimit(1)
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
                    .help(actions.open == nil ? path : "点开：下载到「下载」文件夹并打开\n\(path)")
                    .contextMenu {
                        if actions.open != nil { Button("Download and Open") { actions.open?(path) } }
                        Button("Quick Look") { actions.preview?(path) }
                        if actions.reveal != nil { Button("Show in Finder") { actions.reveal?(path) } }
                        if actions.saveAs != nil { Button("Save As…") { actions.saveAs?(path) } }
                        Button("Copy Path") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(path, forType: .string) }
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    /// How many of those the user's message was for have read it (user #191: 回执只显示几个已读，停上去看是谁):
    /// `2/3 已读` at the message's foot, the names and where each stands when the pointer rests on it. On the user's
    /// own messages that were for someone only.
    @ViewBuilder
    private var readCount: some View {
        let who = room.readers(of: message)
        let total = who.read.count + who.unread.count
        if message.from == Room.you, total > 0 {
            HStack(spacing: 8) {
                // Still on its way to someone busy (user #236): 戳一下 gives it now.
                let waiting = room.receipts(of: message.seq).filter { $0.receipt == .sent || $0.receipt == .queued }.map(\.handle)
                if !waiting.isEmpty {
                    Button { actions.poke(waiting) } label: { Text("戳一下").mono(11).foregroundStyle(Color.signal) }
                        .buttonStyle(.plain)
                        .help("现在就送到 \(waiting.map { "@" + $0 }.joined(separator: " "))：先打断它手上的事（Esc），再把消息打进它的终端")
                }
                Text("\(who.read.count)/\(total) 已读").mono(11).foregroundStyle(who.unread.isEmpty ? Look.faint : Look.ink2)
                    .help(readHelp(who))
            }
        }
    }

    private func readHelp(_ who: (read: [String], unread: [String])) -> String {
        let open = Dictionary(room.receipts(of: message.seq).map { ($0.handle, $0.receipt) }, uniquingKeysWith: { a, _ in a })
        let lines = who.read.map { "✓ \($0) 已读" } + who.unread.map { handle in
            open[handle].map { RoomText.receipt($0, to: room.seat(handle), handle: handle, classic: true) } ?? "○ \(handle) 未读"
        }
        return lines.joined(separator: "\n")
    }

    /// What could not be given: said under the message, in red, whoever wrote it — the one thing of a receipt that
    /// asks something of the user.
    @ViewBuilder
    private var failures: some View {
        let failed = room.receipts(of: message.seq).filter { RoomText.failed($0.receipt) }
        if !failed.isEmpty {
            HStack(spacing: 12) {
                ForEach(failed, id: \.handle) { item in
                    Text(RoomText.receipt(item.receipt, to: room.seat(item.handle), handle: item.handle, classic: look.isClassic)).foregroundStyle(Color.failed)
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
    static func text(_ text: String, handles: Set<String>, look: InterfaceLook, size base: CGFloat = 13.5) -> AttributedString {
        var out = AttributedString()
        let size = Look.scaled(base)
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
            // An e-mail address is words, not a link to open (user #282: 这种邮箱就不要出现超链接).
            for r in run.runs where r.link?.scheme == "mailto" { run[r.range].link = nil }
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
    /// Its avatar chosen (one for each look).
    var avatar: (() -> Void)? = nil
    /// The mark of its last rewind seen; its files put back to before it (退代码, user #290).
    var rewindSeen: (() -> Void)? = nil
    var filesBack: (() -> Void)? = nil
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
                if let r = seat.rewound {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(r.says).font(.system(size: 12)).foregroundStyle(r.marked ? Color.orange : Look.faint).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            if let filesBack { wide("Rewind Files…", help: "把它自己改过的文件也退回到那一刻。先列出会改哪些文件，确认后再改。", action: filesBack) }
                            if r.marked, let rewindSeen { wide("Got It", help: "去掉头像上的标记。", action: rewindSeen) }
                            Spacer(minLength: 0)
                        }
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
                    if let avatar { wide("Avatar", help: "换它的头像：像素外观一个、经典外观一个，所有房间都一样。", action: avatar) }
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

    static func isPicture(_ path: String) -> Bool { kinds.contains((path as NSString).pathExtension.lowercased()) }

    /// A picture's bytes made small, as `thumb` makes a file's.
    static func thumb(data: Data) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let small = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 720, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        return NSImage(cgImage: small, size: NSSize(width: small.width / 2, height: small.height / 2))
    }

    static func thumb(_ path: String) -> NSImage? {
        guard isPicture(path) else { return nil }
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

    /// A task's state in the user's words.
    static func stateWord(_ state: RoomTask.State) -> String {
        switch state {
        case .todo: "未开始"
        case .doing: "进行中"
        case .blocked: "卡住"
        case .done: "已完成"
        }
    }

    /// `T3 登录接口`, the title cut to what fits beside a name.
    static func word(_ n: Int, _ title: String?) -> String {
        guard let title, !title.isEmpty else { return "T\(n)" }
        return "T\(n) " + (title.count > 20 ? String(title.prefix(19)) + "…" : title)
    }
}
