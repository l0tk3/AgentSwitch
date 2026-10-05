import AgentSwitchMacCore
import SwiftUI

// The Live Activity's two faces (docs/design/implemented/mac-live.html): the capsule among the menu bar's status items —
// the app mark in its state and, right of it, what it is doing in a word, a count or the result — and the card under it, the phone's lock
// screen card (island.html). Always dark, as the island is. The capsule is still (the menu bar never moves, ui-v0
// §7); the card's spinners and mark move like the app's own.
// In the classic look (docs/ui-v0.md §8) both are drawn as a standard app's: the mark as lines, dots for the squares, a
// turning ring for the spinner, the system font, round buttons without brackets, the system's accent and status colours.
// There the ring turns smoothly, in the card and in the capsule too (2026-10-04, user, of the capsule's still ring:
// 这个图标是卡住的; of the card's, stepped ten times a turn: 转圈的动画也一卡一卡的): Core Animation turns it
// (LayerMotion.swift), and nothing of the card or the capsule is drawn again as it does.

/// The fixed palette: the island's, whatever the Mac's appearance; the classic look's status colours and accent when
/// that look is kept (asked at every draw).
enum LiveLook {
    static var classic: Bool { InterfaceLook.current.isClassic }
    static var busy: Color { classic ? Color(nsColor: .controlAccentColor) : Color(red: 0x2E / 255, green: 0xE6 / 255, blue: 1) }
    /// The classic look's ring: its size and line, and its colour for a layer.
    static let ring: CGFloat = 9
    static let ringLine: CGFloat = 1.5
    static var ringColor: NSColor { .controlAccentColor }
    static var waiting: Color { classic ? Color(red: 1, green: 0x9F / 255, blue: 0x0A / 255) : Color(red: 1, green: 0xB0 / 255, blue: 0) }
    static let waitingEdge = Color(red: 0xA3 / 255, green: 0x6F / 255, blue: 0)
    static var done: Color { classic ? Color(red: 0x30 / 255, green: 0xD1 / 255, blue: 0x58 / 255) : Color(red: 0x9B / 255, green: 0xE2 / 255, blue: 0x2D / 255) }
    static var failed: Color { classic ? Color(red: 1, green: 0x45 / 255, blue: 0x3A / 255) : Color(red: 1, green: 0x4A / 255, blue: 0x3D / 255) }
    static let ink = Color.white
    static let ink2 = Color.white.opacity(0.72)
    static let ink3 = Color.white.opacity(0.5)
    static let dim = Color.white.opacity(0.45)
    static var card: Color { classic ? Color(red: 0x2C / 255, green: 0x2C / 255, blue: 0x30 / 255).opacity(0.96) : Color(red: 8 / 255, green: 8 / 255, blue: 10 / 255).opacity(0.94) }

    static func color(_ look: LivePresenter.Look) -> Color {
        switch look {
        case .busy: return busy
        case .waiting: return waiting
        case .done: return done
        case .incomplete: return failed
        }
    }

    static func word(_ look: LivePresenter.Look) -> String {
        let word: String
        switch look {
        case .busy: word = "Busy"
        case .waiting: word = "Waiting"
        case .done: word = "Done"
        case .incomplete: word = "Incomplete"
        }
        return ClassicWords.word(word, in: InterfaceLook.current)
    }

    /// 0:42, 10:40, 1:02:03.
    static func clock(since start: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(start)))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// The app mark as the Live Activity's identity and state (docs/ui-v0.md §10): the front window's title bar in the
/// state's colour — busy with a light block on it, amber while something waits, green or red once it has ended.
/// `frame` moves the block (the card); the capsule keeps frame 3.
struct LiveMark: View {
    let look: LivePresenter.Look
    var frame = 3
    var pixel: CGFloat = 1.5

    var body: some View {
        if LiveLook.classic {
            // The mark as lines; the front window's title bar in the state's colour (the accent while busy).
            Canvas { context, size in
                ClassicMark.draw(&context, in: CGRect(origin: .zero, size: size), lit: LiveLook.ink, dim: LiveLook.dim, end: LiveLook.color(look))
            }
            .frame(width: CGFloat(PixelArt.markWidth) * pixel, height: CGFloat(PixelArt.markHeight) * pixel)
            .accessibilityLabel("AgentSwitch \(LiveLook.word(look))")
        } else {
            // The shaded picture (docs/ui-v0.md §10) on the panel's black: the front window's title bar in the state's
            // colour, a light block on it while busy. 1 pt cells: the capsule is 22 pt high.
            let paint = ShadedMarkPaint(dark: true, end: LiveLook.color(look),
                                        block: look == .busy ? ShadedMarkPaint.block(at: frame, trail: false) : [], busy: .white)
            Canvas { context, _ in paint.draw(&context, cell: Self.cell) }
                .frame(width: CGFloat(ShadedMark.picture.width) * Self.cell, height: CGFloat(ShadedMark.picture.height) * Self.cell)
                .accessibilityLabel("AgentSwitch \(LiveLook.word(look))")
        }
    }

    private static let cell: CGFloat = 1
}

/// A 7 pt status square; a dot in the classic look.
struct LiveSquare: View {
    let color: Color

    var body: some View {
        Group { if LiveLook.classic { Circle().fill(color) } else { KeySquare(color: color, side: 7) } }.frame(width: 7, height: 7)
    }
}

/// At work: the braille spinner at `frame`; in the classic look a ring. `turns`: the ring turns by itself, smoothly (the
/// card in its panel); else it is drawn still — into a picture (the capsule's image, a preview), under Reduce Motion.
/// `slot`: told where the ring is in the capsule, for the turning one laid over the capsule's picture.
struct LiveSpin: View {
    let frame: Int
    var turns = false
    var slot: LiveRingSlot? = nil

    var body: some View {
        if LiveLook.classic {
            Group {
                if turns {
                    TurningRing(color: LiveLook.ringColor, lineWidth: LiveLook.ringLine)
                } else {
                    Circle().trim(from: 0.1, to: 0.8).stroke(LiveLook.busy, style: StrokeStyle(lineWidth: LiveLook.ringLine, lineCap: .round))
                }
            }
            .frame(width: LiveLook.ring, height: LiveLook.ring)
            // On a line of words it stands on the line, turning or still (a view of AppKit's has no baseline of its own).
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
            .background {
                if let slot { GeometryReader { geometry in slot.note(geometry.frame(in: .named(LiveCapsule.space))) } }
            }
        } else {
            Text(BrailleSpinner.frames[frame % BrailleSpinner.frames.count]).fontWeight(.bold).foregroundStyle(LiveLook.busy)
        }
    }
}

/// `└─` before a row's step; nothing in the classic look (the step sits under its title by its indent).
struct LiveTwig: View {
    var body: some View {
        if !LiveLook.classic { Text("└─").mono(12).foregroundStyle(LiveLook.ink3) }
    }
}

/// Where the classic look's ring is in the capsule's picture (points, from its top left): written as the picture is
/// drawn, read by the status item, which lays the turning ring over it there.
final class LiveRingSlot {
    private(set) var frame: CGRect?

    func note(_ frame: CGRect) -> Color {
        self.frame = frame
        return .clear
    }
}

/// ■ 2  ⠋ 1: how many wait for you and how many run. `spin`: the spinner's frame (0 in the capsule).
struct LiveTally: View {
    let waiting: Int
    let running: Int
    var spin = 0
    var turns = false
    var slot: LiveRingSlot? = nil

    var body: some View {
        HStack(spacing: 8) {
            if waiting > 0 {
                HStack(spacing: 3) { LiveSquare(color: LiveLook.waiting); Text("\(waiting)") }
            }
            if running > 0 {
                HStack(spacing: 3) {
                    LiveSpin(frame: spin, turns: turns, slot: slot)
                    Text("\(running)")
                }
            }
        }
        .mono(12, weight: .medium)
        .foregroundStyle(LiveLook.ink2)
    }
}

/// The compact presentation in the menu bar: the mark and, right of it, what the one task or terminal is doing in a word
/// (as the phone's compact island: `Run`, `Edit`, `Allow?` in amber), the tally or the result's square, in a black
/// capsule 22 pt high. Drawn into the status item's image; `minimal` is the mark alone.
struct LiveCapsule: View {
    let look: LivePresenter.Look
    let trail: LivePresenter.Trail?
    var now = Date()
    var minimal = false
    /// Told where the tally's ring is (the classic look), in the capsule's own points.
    var slot: LiveRingSlot? = nil

    static let space = "AgentSwitchLiveCapsule"

    var body: some View {
        HStack(spacing: 7) {
            LiveMark(look: look)
            if !minimal, let trail {
                switch trail {
                case .word(let word, let waiting):
                    Text(ClassicWords.word(word, in: InterfaceLook.current)).mono(12, weight: .medium).lineLimit(1).fixedSize()
                        .foregroundStyle(waiting ? LiveLook.waiting : LiveLook.ink2)
                case .tally(let waiting, let running):
                    LiveTally(waiting: waiting, running: running, slot: slot)
                case .result(let ok):
                    LiveSquare(color: ok ? LiveLook.done : LiveLook.failed)
                }
            }
        }
        .padding(.leading, 8)
        .padding(.trailing, minimal ? 8 : 9)
        .frame(height: 22)
        .background(Capsule().fill(Color.black))
        .coordinateSpace(.named(Self.space))
        .environment(\.colorScheme, .dark)
        // Drawn into an image, outside any window: the look is asked where it is kept.
        .environment(\.interfaceLook, InterfaceLook.current)
    }
}

/// What the card does when something on it is clicked.
struct LiveCardActions {
    var open: (LiveSnapshot.Row) -> Void = { _ in }
    var openEnd: (LiveSnapshot.End) -> Void = { _ in }
    var decide: (LiveSnapshot.Row, Bool) -> Void = { _, _ in }
    var pick: (LiveSnapshot.Row, String) -> Void = { _, _ in }
}

/// The card under the capsule: the lock screen card of the phone — the mark, `AgentSwitch` and the tally over a
/// rule; then up to three rows (the waiting first), each a title, `└─` its step, and what answers it; or the result.
/// It steps every 0.14 s only while something on it spins, else once a second as a row's clock turns, else not at all;
/// and not while it is not seen (ui-v0 §7.4, 2026-10-03). In the classic look nothing on it steps: its rings turn by
/// themselves (`live`), and it is drawn again only as a clock turns.
struct LiveCard: View {
    let presenter: LivePresenter
    var actions = LiveCardActions()
    /// Requests being answered: their buttons wait.
    var pending: Set<String> = []
    /// The card is in its panel, on screen: the classic look's rings turn. A card drawn into a picture has them still.
    var live = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.onScreen) private var onScreen
    /// The look kept in the settings: the card is drawn again when it changes.
    @AppStorage(InterfaceLook.key) private var lookRaw = InterfaceLook.pixel.rawValue

    var body: some View {
        let spins = presenter.cardSpins && !reduceMotion && !ringsTurn
        let clocks = presenter.cardClocks
        Group {
            if spins && onScreen {
                TimelineView(.periodic(from: Motion.epoch, by: Motion.run)) { timeline in
                    content(frame: Motion.step(at: timeline.date, every: Motion.run), now: timeline.date)
                }
            } else if !clocks.isEmpty && onScreen {
                TimelineView(ClockSchedule(origins: clocks)) { timeline in
                    content(frame: spins ? Motion.step(at: timeline.date, every: Motion.run) : 3, now: timeline.date)
                }
                .id(clocks)
            } else {
                let now = Date()
                content(frame: spins ? Motion.step(at: now, every: Motion.run) : 3, now: now)
            }
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 15, trailing: 16))
        .frame(width: 360, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(LiveLook.card))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5))
        .environment(\.colorScheme, .dark)
        .environment(\.interfaceLook, InterfaceLook.load(lookRaw))
        .id(lookRaw)
    }

    /// The classic look's rings turn by themselves: nothing has to step for them.
    private var ringsTurn: Bool { live && InterfaceLook.load(lookRaw).isClassic && presenter.cardSpins && !reduceMotion && onScreen }

    private func content(frame: Int, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(frame: frame)
            HairRule().padding(.top, 11).padding(.bottom, 9)
            if !presenter.cardEnds.isEmpty {
                VStack(alignment: .leading, spacing: 11) {
                    ForEach(presenter.cardEnds, id: \.key) { end in endRow(end) }
                }
                if presenter.moreEnds > 0 {
                    Text("+\(presenter.moreEnds) More").mono(12).foregroundStyle(LiveLook.ink3).padding(.top, 11)
                }
            } else {
                VStack(alignment: .leading, spacing: 11) {
                    ForEach(presenter.cardRows) { row in rowView(row, frame: frame, now: now) }
                }
                if presenter.moreRows > 0 {
                    Text("+\(presenter.moreRows) More").mono(12).foregroundStyle(LiveLook.ink3).padding(.top, 11)
                }
            }
        }
    }

    private func header(frame: Int) -> some View {
        HStack(spacing: 8) {
            LiveMark(look: presenter.look, frame: presenter.look == .busy ? frame : 3)
            Text("AgentSwitch").mono(12, weight: .semibold).foregroundStyle(LiveLook.ink)
            Spacer(minLength: 8)
            if presenter.shownEnd == nil, let s = presenter.snapshot, s.rows.count > 1 {
                LiveTally(waiting: s.waiting, running: s.running, spin: frame, turns: ringsTurn)
            } else {
                Text(LiveLook.word(presenter.look)).mono(12, weight: .semibold).foregroundStyle(LiveLook.color(presenter.look))
            }
        }
    }

    private func rowView(_ row: LiveSnapshot.Row, frame: Int, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Group {
                    if row.needsYou {
                        LiveSquare(color: LiveLook.waiting)
                    } else {
                        LiveSpin(frame: frame, turns: ringsTurn).mono(12, weight: .bold)
                    }
                }
                .frame(width: 12)
                LiveTitle(text: row.title) { actions.open(row) }
                Spacer(minLength: 4)
                if let agent = row.agent, let rows = PixelArt.agents[agent] {
                    PixelSprite(rows: rows, pixel: 2, color: LiveLook.ink2, strength: 0.8, shadow: false, onDark: true).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                }
                Text(LiveLook.clock(since: row.startedAt, now: now)).mono(12.5, weight: .medium).monospacedDigit()
                    .foregroundStyle(row.needsYou ? LiveLook.waiting : LiveLook.ink2)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                LiveTwig()
                stepText(row).lineLimit(row.ask == nil ? 1 : 2).truncationMode(.tail)
            }
            .padding(.leading, 22)
            if case .decide(_, _, _, let place)? = row.ask, !place.isEmpty {
                Text(place).mono(11.5).foregroundStyle(LiveLook.ink3).lineLimit(1).truncationMode(.middle).padding(.leading, 43)
            }
            if row.needsYou {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    buttons(row)
                }
                .padding(.top, 8)
                .padding(.bottom, 3)
                .disabled(pending.contains(row.ask?.id ?? row.id))
            }
        }
    }

    private func stepText(_ row: LiveSnapshot.Row) -> Text {
        switch row.ask {
        case .decide(_, let tool, let target, _)?:
            // The tool as a short word; what it runs on is a command or a path (code in both looks' reading font).
            return (Text(tool + "  ").font(.system(size: 12.5, weight: .semibold, design: LiveLook.classic ? .default : .monospaced)) + Text(target).font(.system(size: 13)))
                .foregroundColor(LiveLook.waiting)
        case .question(_, _, let text, _, _)?:
            return Text(text).font(.system(size: 13)).foregroundColor(LiveLook.waiting)
        case nil:
            return Text(row.step).font(.system(size: 13)).foregroundColor(row.needsYou ? LiveLook.waiting : LiveLook.ink2)
        }
    }

    @ViewBuilder private func buttons(_ row: LiveSnapshot.Row) -> some View {
        switch row.ask {
        case .decide?:
            LiveButton(title: "Deny") { actions.decide(row, false) }
            LiveButton(title: "Allow", primary: true) { actions.decide(row, true) }
        case .question(_, _, _, let options, true)?:
            ForEach(options, id: \.self) { option in LiveButton(title: option) { actions.pick(row, option) } }
        default:
            LiveButton(title: "Open", primary: true) { actions.open(row) }
        }
    }

    private func endRow(_ end: LiveSnapshot.End) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                LiveSquare(color: end.ok ? LiveLook.done : LiveLook.failed).frame(width: 12)
                LiveTitle(text: end.title) { actions.openEnd(end) }
                Spacer(minLength: 4)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                LiveTwig()
                Text(end.line).font(.system(size: 13)).foregroundStyle(LiveLook.ink2).lineLimit(2)
            }
            .padding(.leading, 22)
        }
    }
}

/// A row's title: opens what it names; underlined under the pointer.
private struct LiveTitle: View {
    let text: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(text).font(.system(size: 14, weight: .semibold)).foregroundStyle(LiveLook.ink).underline(hover)
                .lineLimit(1).truncationMode(.tail)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// `[ Allow ]`: a bracketed word; the primary one amber with a key's lower edge, the others ink that inverts under the
/// pointer (terminal.html, island.html).
struct LiveButton: View {
    let title: String
    var primary = false
    let action: () -> Void
    @State private var hover = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        if LiveLook.classic { classicButton } else { pixelButton }
    }

    /// The classic look's button: a round one, the main action in the accent.
    private var classicButton: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
                .background(Capsule().fill(primary ? LiveLook.busy : Color.white.opacity(hover ? 0.26 : 0.18)))
                .opacity(enabled ? (primary && hover ? 0.88 : 1) : 0.5)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 && enabled }
    }

    private var pixelButton: some View {
        Button(action: action) {
            Text("[ \(title) ]").mono(12.5, weight: .semibold)
                .foregroundStyle(primary || hover ? Color.black : LiveLook.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background {
                    if primary {
                        ZStack {
                            Rectangle().fill(LiveLook.waitingEdge).offset(y: 3)
                            Rectangle().fill(hover ? Color(red: 1, green: 0xC2 / 255, blue: 0x33 / 255) : LiveLook.waiting)
                        }
                    } else if hover {
                        Rectangle().fill(LiveLook.ink)
                    }
                }
                .opacity(enabled ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 && enabled }
    }
}
