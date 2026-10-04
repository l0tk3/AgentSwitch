import AgentSwitchLive
import SwiftUI

/// The Live Activity's views (assistant-v0 §4), in a package so the Mac can render them in tests (LiveRenderTests);
/// the widget extension places them in the Dynamic Island's regions and on the lock screen. Drawn in the app's own
/// language (ui-v0 §7, docs/design/implemented/island.html): the pixel mark as the identity and the state, status squares
/// and the spinner's first frame, tree lines and solid rules, short mono words in title case (§7.2.7), a bracket button. Everything is
/// drawn for a black background: the island is always black and the lock screen card gets a dark tint, so white text
/// reads on any wallpaper. The corners of the island clip, so nothing sits in them.
public enum LiveLook {
    public static let text = Color.white
    public static let secondary = Color.white.opacity(0.72)
    public static let faint = Color.white.opacity(0.5)
    /// The compact and minimal island's mark: `LiveMark` draws a cell of three quarters of this, 3 device pixels (every
    /// phone with a Dynamic Island draws at 3x) — the mark with its shadow 17 pt square, clear of the 37 pt circle's edge
    /// (2026-10-01, user: 太大、被圆圈裁切).
    public static let islandPixel: CGFloat = 4.0 / 3.0
    /// Dotted rules.
    static let rule = Color.white.opacity(0.16)
    public static let background = Color.black.opacity(0.82)

    /// docs/ui-v0.md §7.3's status colours (dark set: the island and the card are dark): waiting amber, busy cyan, ok
    /// green, failed red.
    public static let waiting = Color(red: 1, green: 0.69, blue: 0)
    public static let busy = Color(red: 0.18, green: 0.9, blue: 1)
    public static let ok = Color(red: 0.61, green: 0.89, blue: 0.18)
    public static let failed = Color(red: 1, green: 0.29, blue: 0.24)
    /// The open button's lower edge, a key cap's (§7).
    static let waitingEdge = Color(red: 0.64, green: 0.44, blue: 0)

    // The classic look's (docs/ui-v0.md §8): the system's status colours and its blue for what is at work.
    public static func waiting(in classic: Bool) -> Color { classic ? Color(red: 1, green: 0.62, blue: 0.04) : waiting }
    public static func busy(in classic: Bool) -> Color { classic ? Color(red: 0.04, green: 0.52, blue: 1) : busy }
    public static func ok(in classic: Bool) -> Color { classic ? Color(red: 0.19, green: 0.82, blue: 0.35) : ok }
    public static func failed(in classic: Bool) -> Color { classic ? Color(red: 1, green: 0.27, blue: 0.23) : failed }
    /// The card's ground: near black; a dark grey in the classic look.
    public static func background(_ state: LiveState) -> Color {
        state.isClassic ? Color(red: 0.17, green: 0.17, blue: 0.19).opacity(0.86) : background
    }

    public static func tint(_ state: LiveState) -> Color {
        let classic = state.isClassic
        switch state.phase {
        case .needsYou: return waiting(in: classic)
        case .running: return busy(in: classic)
        case .ended: return state.ended?.ok == true ? ok(in: classic) : failed(in: classic)
        }
    }

    /// The status word (§7.2.7, the same as in the app; the classic look's own where it has one).
    public static func word(_ state: LiveState) -> String {
        let classic = state.isClassic
        switch state.phase {
        case .needsYou: return classic ? "Needs You" : "Waiting"
        case .running: return classic ? "Working" : "Busy"
        case .ended: return state.ended?.ok == true ? "Done" : "Incomplete"
        }
    }

    /// A tap opens what matters most: the task or terminal waiting for you, the newest task, or the one that ended last.
    public static func link(_ state: LiveState) -> URL? {
        state.lead?.link ?? state.ended.map { LiveLink.task($0.taskId) }
    }

    /// "+2 More" when the island shows one of several.
    public static func others(_ state: LiveState) -> String? {
        let more = state.running + state.waiting - 1
        return more > 0 ? "+\(more) More" : nil
    }

    /// Short words: monospaced; the system font in the classic look.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular, classic: Bool = false) -> Font {
        .system(size: size, weight: weight, design: classic ? .default : .monospaced)
    }

    /// The app's mark as lines (the classic look): one source switched onto three lanes, the squares rounded and the
    /// steps curved, the lit lane's end in `end`.
    static func drawClassicMark(_ context: inout GraphicsContext, in rect: CGRect, end: Color?) {
        let u = min(rect.width / 14, rect.height / 11)
        let origin = CGPoint(x: rect.midX - 7 * u, y: rect.midY - 5.5 * u)
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * u, y: origin.y + y * u) }
        func block(_ x: CGFloat, _ y: CGFloat) -> Path {
            Path(roundedRect: CGRect(origin: point(x, y), size: CGSize(width: 3 * u, height: 3 * u)), cornerRadius: 0.85 * u, style: .continuous)
        }
        let stroke = StrokeStyle(lineWidth: max(1, 0.95 * u), lineCap: .round)
        func lane(to y: CGFloat) -> Path {
            var path = Path()
            path.move(to: point(3, 5.5))
            path.addCurve(to: point(11, y), control1: point(7.4, 5.5), control2: point(6.6, y))
            return path
        }
        let dim = Color.white.opacity(0.45)
        context.stroke(lane(to: 5.5), with: .color(dim), style: stroke)
        context.stroke(lane(to: 9.5), with: .color(dim), style: stroke)
        context.fill(block(11, 4), with: .color(dim))
        context.fill(block(11, 8), with: .color(dim))
        context.stroke(lane(to: 1.5), with: .color(text), style: stroke)
        context.fill(block(0, 4), with: .color(text))
        context.fill(block(11, 0), with: .color(end ?? text))
    }
}

extension EnvironmentValues {
    /// The classic look, handed from each of the activity's public views to the parts under it.
    @Entry var liveClassic = false
}

/// The app's mark as the activity's identity and its state (ui-v0 §7.3), drawn as the app draws it (§9): the shaded
/// picture — tones of the one ink, a hard shadow a cell down and right — with the state on its nearest lane. Busy puts a
/// cyan block on that lane (a still frame: the island does not animate), waiting turns its end amber, and once all is
/// over the end shows how it went (green done, red not). The compact and minimal island, the expanded island's leading
/// corner, the lock screen's header.
public struct LiveMark: View {
    let state: LiveState
    let pixel: CGFloat
    @Environment(\.displayScale) private var displayScale

    public init(state: LiveState, pixel: CGFloat = 2) {
        self.state = state
        self.pixel = pixel
    }

    public var body: some View {
        if state.isClassic { classicMark } else { pixelMark }
    }

    /// The classic look: the mark as lines, its lit end in the state's colour.
    private var classicMark: some View {
        let end = LiveLook.tint(state)
        return Canvas { context, size in LiveLook.drawClassicMark(&context, in: CGRect(origin: .zero, size: size), end: end) }
            .frame(width: CGFloat(LiveArt.markRows[0].count + 1) * pixel, height: CGFloat(LiveArt.markRows.count + 1) * pixel)
            .accessibilityElement()
            .accessibilityLabel("AgentSwitch · \(LiveLook.word(state))")
    }

    private var pixelMark: some View {
        let end: Color? = switch state.phase {
        case .needsYou: LiveLook.waiting
        case .ended: LiveLook.tint(state)
        case .running: nil
        }
        // A whole number of pixels a cell: 3 in the island (17 pt with the shadow, clear of the 37 pt circle's edge),
        // 4 on the lock screen. The block where the app's mark has it on its fourth beat.
        let cell = CGFloat(ShadedSprite.cell(scale: Double(displayScale), points: Double(pixel) * 0.75))
        let paint = ShadedMarkPaint(depth: true, end: end, block: state.phase == .running ? [(step: LiveMark.stillStep, alpha: 1)] : [])
        let side = (CGFloat(ShadedMark.picture.width + 1) * cell).rounded(.up)
        return Canvas { context, _ in paint.draw(&context, cell: cell) }
            .frame(width: side, height: side, alignment: .topLeading)
            .accessibilityElement()
            .accessibilityLabel("AgentSwitch · \(LiveLook.word(state))")
    }

    static let stillStep = 3
}

/// A status square as a small key (§9): its colour, a light edge above and left, a dark one below and right.
struct LiveKey: View {
    let color: Color
    var side: CGFloat = 7

    var body: some View {
        let side = side
        Canvas { context, _ in
            context.fill(Path(CGRect(x: 0, y: 0, width: side, height: side)), with: .color(color))
            ShadedPaint.keyEdges(in: &context, side: side, edge: 1, raised: true)
        }
        .frame(width: side, height: side)
    }
}

/// An agent's mark: its shaded picture (§9), without the shadow, a little under full strength beside the text.
struct LiveSprite: View {
    let harness: String
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        if let sprite = ShadedSprite.agents[harness] {
            let cell = CGFloat(ShadedSprite.cell(scale: Double(displayScale)))
            Canvas { context, _ in ShadedPaint.draw(sprite, in: &context, cell: cell, dark: true, shadow: false) }
                .frame(width: (CGFloat(sprite.width) * cell).rounded(.up), height: (CGFloat(sprite.height) * cell).rounded(.up), alignment: .topLeading)
                .opacity(0.8)
                .accessibilityHidden(true)
        }
    }
}

/// A row's status (§7.2.4: static places show the spinner's first frame): ⠋ while busy, a square otherwise.
/// In the classic look an open ring while busy, a dot otherwise.
struct RowGlyph: View {
    let color: Color
    let busy: Bool
    @Environment(\.liveClassic) private var classic

    var body: some View {
        Group {
            if busy && classic {
                BusyRing()
            } else if busy {
                Text("⠋").font(LiveLook.mono(13, .bold)).foregroundStyle(LiveLook.busy)
            } else if classic {
                Circle().fill(color).frame(width: 8, height: 8)
            } else {
                LiveKey(color: color)
            }
        }
        .frame(width: 12)
    }
}

/// At work, in the classic look: a still open ring in the accent (the island does not animate).
struct BusyRing: View {
    var body: some View {
        Circle().trim(from: 0.1, to: 0.8).stroke(LiveLook.busy(in: true), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            .rotationEffect(.degrees(-60))
            .frame(width: 9, height: 9)
    }
}

/// Counts up from `since` on its own, also while the app is suspended. A timer text reserves room for its longest
/// form, so it gets a fixed width and trailing alignment rather than growing into a clipped corner.
public struct LiveClock: View {
    let since: Date
    let width: CGFloat

    public init(since: Date, width: CGFloat = 52) {
        self.since = since
        self.width = width
    }

    public var body: some View {
        Text(timerInterval: since...Date.distantFuture, countsDown: false)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .frame(width: width, alignment: .trailing)
    }
}

/// How many wait and how many run, by their marks (■ 1 ⠋ 2): tasks and terminals together.
struct Tally: View {
    let state: LiveState

    var body: some View {
        let classic = state.isClassic
        HStack(spacing: 10) {
            if state.waiting > 0 {
                HStack(spacing: 4) {
                    if classic { Circle().fill(LiveLook.waiting(in: true)).frame(width: 8, height: 8) } else { LiveKey(color: LiveLook.waiting) }
                    Text("\(state.waiting)")
                }
            }
            if state.running > 0 {
                HStack(spacing: 3) {
                    if classic { BusyRing() } else { Text("⠋").fontWeight(.bold).foregroundStyle(LiveLook.busy) }
                    Text("\(state.running)")
                }
            }
        }
        .font(LiveLook.mono(12, .medium, classic: classic))
        .foregroundStyle(LiveLook.secondary)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([state.waiting > 0 ? "\(state.waiting) waiting" : nil, state.running > 0 ? "\(state.running) busy" : nil]
            .compactMap { $0 }.joined(separator: ", "))
    }
}

/// `└─` and what it is doing, what it asks (amber), or how it ended.
struct StepLine: View {
    let text: String
    let asks: Bool
    let lines: Int
    var size: CGFloat = 14
    @Environment(\.liveClassic) private var classic

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            // The tree's corner is the pixel look's; the classic one says the step plainly.
            if !classic { Text("└─").font(LiveLook.mono(size - 1)).foregroundStyle(LiveLook.faint) }
            Text(text).font(.system(size: size)).foregroundStyle(asks ? LiveLook.waiting(in: classic) : LiveLook.secondary)
                .lineLimit(lines).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// One point high, solid (2026-10-03, user: 分割线也别弄虚线了，改成实线吧，看着累人; two on, two off before).
struct HairRule: View {
    var body: some View {
        LiveLook.rule.frame(height: 1).accessibilityHidden(true)
    }
}

/// Who works on the lead row: a terminal's agent by its mark and name, a task's model by its short name, as its maker
/// writes it (Sonnet 4.6, DeepSeek Flash); `Routing` before the router has picked one.
struct Worker: View {
    let row: LiveState.Row

    var body: some View {
        HStack(spacing: 6) {
            if row.kind == .terminal, let model = row.model, let harness = LiveArt.harness(named: model) {
                LiveSprite(harness: harness)
            }
            Text(row.model ?? "Routing").lineLimit(1)
        }
    }
}

/// The way in when something waits for you: a bracket button on amber with a key cap's darker lower edge. `linked`
/// false draws it without its link, for a picture of the island (a renderer cannot draw a link).
struct OpenButton: View {
    let link: URL
    var linked = true
    @Environment(\.liveClassic) private var classic

    var body: some View {
        Group {
            if linked { Link(destination: link) { face } } else { face }
        }
        .padding(.bottom, 3)
    }

    /// `[ Open ]` on amber with a key's lower edge; a round button in the accent in the classic look.
    @ViewBuilder private var face: some View {
        if classic {
            Text("Open").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 5)
                .background(Capsule().fill(LiveLook.busy(in: true)))
        } else {
            pixelFace
        }
    }

    private var pixelFace: some View {
        Text("[ Open ]").font(LiveLook.mono(13, .semibold)).foregroundStyle(.black)
            .padding(.horizontal, 10).padding(.vertical, 5)
            // Square (§7: hard edges), drawn as rectangles: a plain colour background comes out rounded here.
            .background {
                ZStack {
                    Rectangle().fill(LiveLook.waitingEdge).offset(y: 3)
                    Rectangle().fill(LiveLook.waiting)
                }
            }
    }
}

// MARK: - the island

/// Compact island, left of the camera; also the minimal island.
public struct IslandCompactLeading: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        LiveMark(state: state, pixel: LiveLook.islandPixel).padding(.leading, 4).environment(\.liveClassic, state.isClassic)
    }
}

/// Minimal island (beside another app's activity): the mark alone, small enough to sit clear of the circle's edge.
public struct IslandMinimal: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        LiveMark(state: state, pixel: LiveLook.islandPixel)
    }
}

/// Compact island, right of the camera: what the one task or terminal is doing in a word (amber while it waits for you;
/// 2026-10-01, user: 这个计时有点没用，换成更实用点的信息 — the clock stays in the expanded island), the counts when
/// several run, or how it ended.
public struct IslandCompactTrailing: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        let classic = state.isClassic
        Group {
            if state.phase == .ended {
                if classic { Circle().fill(LiveLook.tint(state)).frame(width: 8, height: 8) } else { LiveKey(color: LiveLook.tint(state), side: 8) }
            } else if state.running + state.waiting > 1 {
                Tally(state: state)
            } else if let lead = state.lead {
                Text(lead.doing ?? (lead.needsYou ? (classic ? "Needs You" : "Waiting") : (classic ? "Working" : "Busy")))
                    .font(LiveLook.mono(13, .medium, classic: classic)).lineLimit(1).fixedSize()
                    .foregroundStyle(lead.needsYou ? LiveLook.waiting(in: classic) : LiveLook.secondary)
            }
        }
        .padding(.trailing, 4)
        .environment(\.liveClassic, classic)
    }
}

/// Expanded island, left of the camera: the mark alone (a word would run under the camera).
public struct IslandLeading: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        LiveMark(state: state).padding(.leading, 8).padding(.top, 2).environment(\.liveClassic, state.isClassic)
    }
}

/// Expanded island, right of the camera: the status word and how long the lead has run (a terminal: has waited).
public struct IslandTrailing: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        let classic = state.isClassic
        HStack(spacing: 8) {
            Text(LiveLook.word(state)).font(LiveLook.mono(13, .semibold, classic: classic)).foregroundStyle(LiveLook.tint(state)).lineLimit(1).fixedSize()
            if let lead = state.lead {
                LiveClock(since: lead.startedAt, width: 44).font(LiveLook.mono(13, .medium, classic: classic)).foregroundStyle(LiveLook.secondary)
            }
        }
        .padding(.trailing, 8).padding(.top, 2)
        .environment(\.liveClassic, classic)
    }
}

/// Expanded island, the wide bottom, aligned left: the title, `└─` what it is doing or asks, then under a rule
/// who works on it, how many more, and `[ Open ]` when it waits for you; or how it ended.
public struct IslandBottom: View {
    let state: LiveState
    let linked: Bool
    /// `linked` false: the open button without its link, for a picture of the island (LiveRenderTests).
    public init(state: LiveState, linked: Bool = true) {
        self.state = state
        self.linked = linked
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let lead = state.lead {
                Text(lead.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                StepLine(text: lead.step, asks: lead.needsYou, lines: 2).padding(.top, 3)
                HairRule().padding(.top, 12).padding(.bottom, 10)
                HStack(spacing: 8) {
                    Worker(row: lead)
                    if let others = LiveLook.others(state) { Text("· \(others)").lineLimit(1) }
                    Spacer(minLength: 4)
                    if lead.needsYou { OpenButton(link: lead.link, linked: linked) }
                }
                .font(LiveLook.mono(12, classic: state.isClassic))
                .foregroundStyle(LiveLook.faint)
                .frame(minHeight: 26)
            } else if let ended = state.ended {
                Text(ended.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                StepLine(text: ended.line, asks: false, lines: 2).padding(.top, 3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
        .environment(\.liveClassic, state.isClassic)
    }
}

// MARK: - the lock screen

/// The lock screen: the mark, `AgentSwitch · <Mac>` and the counts (or the word); a rule; then up to three
/// rows — tasks and terminals waiting for you first, their question in amber, then tasks in progress — or the last
/// conclusion.
public struct LockScreenCard: View {
    let state: LiveState
    let mac: String
    let stale: Bool

    public init(state: LiveState, mac: String, stale: Bool) {
        self.state = state
        self.mac = mac
        self.stale = stale
    }

    public var body: some View {
        let classic = state.isClassic
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                LiveMark(state: state)
                Text("AgentSwitch").font(LiveLook.mono(classic ? 13 : 12, .semibold, classic: classic)).foregroundStyle(LiveLook.text)
                Text("· \(mac)").font(LiveLook.mono(12, classic: classic)).foregroundStyle(LiveLook.faint).lineLimit(1)
                Spacer(minLength: 4)
                if state.running + state.waiting > 1 {
                    Tally(state: state)
                } else {
                    Text(LiveLook.word(state)).font(LiveLook.mono(13, .semibold, classic: classic)).foregroundStyle(LiveLook.tint(state)).fixedSize()
                }
            }
            HairRule().padding(.top, 11).padding(.bottom, 9)
            if let ended = state.ended, state.rows.isEmpty {
                HStack(spacing: 8) {
                    RowGlyph(color: LiveLook.tint(state), busy: false)
                    Text(ended.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                }
                StepLine(text: ended.line, asks: false, lines: 2, size: 13).padding(.leading, 20).padding(.top, 1)
            }
            VStack(alignment: .leading, spacing: 9) {
                ForEach(state.rows) { row in
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 8) {
                            RowGlyph(color: LiveLook.waiting(in: classic), busy: !row.needsYou)
                            Text(row.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                            Spacer(minLength: 4)
                            if row.kind == .terminal, let model = row.model, let harness = LiveArt.harness(named: model) {
                                LiveSprite(harness: harness)
                            }
                            LiveClock(since: row.startedAt, width: 48).font(LiveLook.mono(13, .medium, classic: classic)).foregroundStyle(LiveLook.secondary)
                        }
                        StepLine(text: row.step, asks: row.needsYou, lines: 1, size: 13).padding(.leading, 20)
                    }
                }
            }
            if stale {
                Text("内容可能已过期，打开 AgentSwitch 以刷新。").font(.system(size: 11)).foregroundStyle(LiveLook.faint).padding(.top, 10)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .environment(\.liveClassic, classic)
    }
}
