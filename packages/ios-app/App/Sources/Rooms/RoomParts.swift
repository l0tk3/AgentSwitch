import AgentSwitchKit
import SwiftUI

// The pieces a room is drawn with (docs/chatroom-v0.md §1 头像, §6.1, §10): a seat's face, its state's mark and word,
// a message's text with its `@names`, and the pictures Chat Room adds.

/// A seat's face: its 5 × 5 pattern in its colour — square cells in the pixel look, round dots in the classic one. The
/// user is a fixed `YOU`.
struct RoomFaceView: View {
    let face: RoomFace?
    var you = false
    /// The side of the box; the cells are a fifth of what is left inside it.
    var side: CGFloat = 26
    @Environment(\.interfaceLook) private var look

    private static let fallback = RoomFace(rows: ["#.#.#", ".###.", "##.##", ".###.", "#.#.#"], color: 5)

    var body: some View {
        if you { youMark } else { pattern(face ?? Self.fallback) }
    }

    private var youMark: some View {
        Text("YOU")
            .font(.system(size: side * 0.38, weight: .bold, design: look.isClassic ? .default : .monospaced))
            .foregroundStyle(look.isClassic ? Color.white : Theme.base)
            .frame(width: side, height: side)
            .background(look.isClassic ? Theme.signal : Theme.ink, in: RoundedRectangle(cornerRadius: look.isClassic ? side * 0.3 : 0, style: .continuous))
            .accessibilityLabel("You")
    }

    private func pattern(_ face: RoomFace) -> some View {
        let color = Color(light: face.rgb(dark: false), dark: face.rgb(dark: true))
        let classic = look.isClassic
        // Whole points per cell; the classic look's dots stand a point apart.
        let cell = max(1, ((side - 4) / 5).rounded(.down) - (classic ? 1 : 0)), step = cell + (classic ? 1 : 0)
        let drawn = step * 5 - (classic ? 1 : 0)
        return Canvas { context, size in
            let origin = CGPoint(x: ((size.width - drawn) / 2).rounded(), y: ((size.height - drawn) / 2).rounded())
            for c in face.cells {
                let rect = CGRect(x: origin.x + CGFloat(c.x) * step, y: origin.y + CGFloat(c.y) * step, width: cell, height: cell)
                context.fill(classic ? Path(roundedRect: rect, cornerRadius: cell * 0.35) : Path(rect), with: .color(color))
            }
        }
        .frame(width: side, height: side)
        .background {
            if classic { RoundedRectangle(cornerRadius: side * 0.3, style: .continuous).fill(color.opacity(0.2)) }
        }
        .overlay {
            if !classic { Rectangle().strokeBorder(color.opacity(0.45), lineWidth: 1) }
        }
        .accessibilityHidden(true)
    }
}

/// A seat's state as a mark (§6.1). Amber is what needs the user's hands, red what went wrong; what mends itself has
/// no colour — a spinner while it tries again, a dim key while it only waits. Never the colour alone: the word stands
/// beside it.
struct SeatStateMark: View {
    let state: SeatState?
    @Environment(\.interfaceLook) private var look

    var body: some View {
        switch state?.mark {
        case .spinner: BrailleSpinner(color: state == .reconnecting ? Theme.secondaryInk : Theme.busy)
        case .amber:
            if look.isClassic { ClassicWaitingDot() } else { PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.waiting).waitingBlink() }
        case .ready: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.done)
        case .red: PixelSprite(rows: PixelArt.square, pixel: 2, color: Theme.failed)
        case .held: PixelSprite(rows: look.isClassic ? PixelArt.square : RoomArt.dither, pixel: 2, color: Theme.secondaryInk).opacity(look.isClassic ? 0.45 : 1)
        case .ended, nil: PixelSprite(rows: PixelArt.hollow, pixel: 2, color: Theme.inkDim)
        }
    }
}

extension SeatState {
    /// The colour its word is written in beside the mark: only what needs the user or went wrong has one.
    var wordColor: Color {
        switch mark {
        case .amber: return Theme.waiting
        case .red: return Theme.failed
        default: return Theme.secondaryInk
        }
    }
}

/// Chat Room's own 1-bit pictures (the concept page's): the room's speech box, people, a reply's arrow, the Files
/// folder of the Terminals page's top bar, and the dithered key of a seat that only waits.
enum RoomArt {
    static let people = ["..##...##", "..##...##", ".####.###", ".####.###"]
    static let reply = ["..#....", ".##....", "#######", ".##...#", "..#...#"]
    static let files = ["####.....", "#...#####", "#.......#", "#.......#", "#.......#", "#.......#", "#########"]
    static let dither = ["#.#.", ".#.#", "#.#.", ".#.#"]

    static func agentName(_ harness: String) -> String {
        NewTerminalSheet.agents.first { $0.id == harness }?.name ?? harness
    }
}

extension ShadedSprite {
    /// The Rooms tab's picture in the pixel look (the app's own): a speech box raised off the ground — a light edge
    /// above and left, a dark one below and right — two lines written in it, its tail below.
    static let rooms = ShadedSprite([
        "WWWWWWWWWWWWWWW#", "W##############m", "W##############m", "W##kkkkkkkkk###m", "W##############m", "W##kkkkkk######m",
        "W##############m", "W##############m", "#mmmW##mmmmmmmmd", "....W#m.........", "....W#d.........", "....#d..........",
    ])
}

/// An agent's mark at a line's size, dim: beside a name, in a member's row.
struct RoomAgentMark: View {
    let agent: String
    var pixel: CGFloat = 2

    var body: some View {
        PixelSprite(rows: PixelArt.agents[agent] ?? PixelArt.square, pixel: pixel, color: .secondary, strength: 0.9, shadow: false)
            .accessibilityLabel(RoomArt.agentName(agent))
    }
}

enum RoomWords {
    /// A message's time in its head: the hour and minute.
    static func time(_ date: Date) -> String { date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }

    /// The day written above the first message of a day.
    static func day(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let parts = calendar.dateComponents([.month, .day], from: date)
        return "\(parts.month ?? 0)/\(parts.day ?? 0)"
    }

    static func who(_ handle: String) -> String { handle == RoomSeat.you ? "You" : handle }

    /// A message's text as it is drawn: `@names` of seats firm (the classic look: in the accent), the user's own on a
    /// ground, `code` in the code font.
    static func text(_ text: String, handles: Set<String>, look: InterfaceLook) -> AttributedString {
        var out = AttributedString()
        for piece in RoomText.pieces(text, handles: handles) {
            switch piece {
            case .text(let s): out += AttributedString(s)
            case .code(let s):
                var run = AttributedString(s)
                run.font = .system(size: 14, design: .monospaced)
                run.backgroundColor = Theme.code
                out += run
            case .mention(let name):
                let me = name == RoomSeat.you
                var run = AttributedString(me ? " @\(name) " : "@\(name)")
                if look.isClassic {
                    run.font = .system(size: 15, weight: .medium)
                    run.foregroundColor = me ? .white : Theme.signal
                    if me { run.backgroundColor = Theme.signal }
                } else {
                    run.font = .system(size: 14, weight: .semibold, design: .monospaced)
                    run.foregroundColor = me ? Theme.base : Theme.ink
                    if me { run.backgroundColor = Theme.ink }
                }
                out += run
            }
        }
        return out
    }
}
