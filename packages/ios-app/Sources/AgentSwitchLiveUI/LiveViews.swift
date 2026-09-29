import AgentSwitchLive
import SwiftUI

/// The Live Activity's views (assistant-v0 §4), in a package so the Mac can render them in tests (LiveRenderTests);
/// the widget extension places them in the Dynamic Island's regions and on the lock screen. Drawn in the app's own
/// language (ui-v0 §7, docs/design/visual-v1/island.html): the pixel mark as the identity and the state, status squares
/// and the spinner's first frame, tree lines and dotted rules, lowercase mono words, a bracket button. Everything is
/// drawn for a black background: the island is always black and the lock screen card gets a dark tint, so white text
/// reads on any wallpaper. The corners of the island clip, so nothing sits in them.
public enum LiveLook {
    public static let text = Color.white
    public static let secondary = Color.white.opacity(0.72)
    public static let faint = Color.white.opacity(0.5)
    /// The mark's unlit lanes.
    static let dim = Color.white.opacity(0.45)
    /// Dotted rules.
    static let rule = Color.white.opacity(0.28)
    public static let background = Color.black.opacity(0.82)

    /// docs/ui-v0.md §7.3's status colours (dark set: the island and the card are dark): waiting amber, busy cyan, ok
    /// green, failed red.
    public static let waiting = Color(red: 1, green: 0.69, blue: 0)
    public static let busy = Color(red: 0.18, green: 0.9, blue: 1)
    public static let ok = Color(red: 0.61, green: 0.89, blue: 0.18)
    public static let failed = Color(red: 1, green: 0.29, blue: 0.24)
    /// The open button's lower edge, a key cap's (§7).
    static let waitingEdge = Color(red: 0.64, green: 0.44, blue: 0)

    public static func tint(_ state: LiveState) -> Color {
        switch state.phase {
        case .needsYou: return waiting
        case .running: return busy
        case .ended: return state.ended?.ok == true ? ok : failed
        }
    }

    /// The status word (§7.2.7, the same as in the app).
    public static func word(_ state: LiveState) -> String {
        switch state.phase {
        case .needsYou: return "waiting"
        case .running: return "busy"
        case .ended: return state.ended?.ok == true ? "done" : "incomplete"
        }
    }

    /// A tap opens what matters most: the task or terminal waiting for you, the newest task, or the one that ended last.
    public static func link(_ state: LiveState) -> URL? {
        state.lead?.link ?? state.ended.map { LiveLink.task($0.taskId) }
    }

    /// "+2 more" when the island shows one of several.
    public static func others(_ state: LiveState) -> String? {
        let more = state.running + state.waiting - 1
        return more > 0 ? "+\(more) more" : nil
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// The app's mark as the activity's identity and its state (ui-v0 §7.3): the lit lane white, the others dim; busy puts
/// a cyan block on the lit lane (a still frame: the island does not animate), waiting turns its end amber, and once all
/// is over the end shows how it went (green done, red not). The compact and minimal island, the expanded island's
/// leading corner, the lock screen's header.
public struct LiveMark: View {
    let state: LiveState
    let pixel: CGFloat

    public init(state: LiveState, pixel: CGFloat = 2) {
        self.state = state
        self.pixel = pixel
    }

    public var body: some View {
        let end: Color? = switch state.phase {
        case .needsYou: LiveLook.waiting
        case .ended: LiveLook.tint(state)
        case .running: nil
        }
        // The block two cells long, where the web mark's frame 3 has it (pixel.js).
        let block = state.phase == .running ? Set(LiveArt.laneA[3...4].map { "\($0.x),\($0.y)" }) : []
        let pixel = pixel
        Canvas { context, _ in
            for (y, row) in LiveArt.markRows.enumerated() {
                for (x, ch) in row.enumerated() where ch != "." {
                    let color: Color = if block.contains("\(x),\(y)") { LiveLook.busy }
                        else if ch == "A", let end { end }
                        else if "aAS".contains(ch) { LiveLook.text }
                        else { LiveLook.dim }
                    context.fill(Path(CGRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel)), with: .color(color))
                }
            }
        }
        .frame(width: CGFloat(LiveArt.markRows[0].count) * pixel, height: CGFloat(LiveArt.markRows.count) * pixel)
        .accessibilityElement()
        .accessibilityLabel("AgentSwitch · \(LiveLook.word(state))")
    }
}

/// A 1-bit sprite (an agent's mark).
struct LiveSprite: View {
    let rows: [String]
    var pixel: CGFloat = 2
    var color: Color = LiveLook.secondary

    var body: some View {
        let pixel = pixel
        Canvas { context, _ in
            for (y, row) in rows.enumerated() {
                for (x, ch) in row.enumerated() where ch == "#" {
                    context.fill(Path(CGRect(x: CGFloat(x) * pixel, y: CGFloat(y) * pixel, width: pixel, height: pixel)), with: .color(color))
                }
            }
        }
        .frame(width: CGFloat(rows.first?.count ?? 0) * pixel, height: CGFloat(rows.count) * pixel)
        .accessibilityHidden(true)
    }
}

/// A row's status (§7.2.4: static places show the spinner's first frame): ⠋ while busy, a square otherwise.
struct RowGlyph: View {
    let color: Color
    let busy: Bool

    var body: some View {
        Group {
            if busy {
                Text("⠋").font(LiveLook.mono(13, .bold)).foregroundStyle(LiveLook.busy)
            } else {
                Rectangle().fill(color).frame(width: 7, height: 7)
            }
        }
        .frame(width: 12)
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
        HStack(spacing: 10) {
            if state.waiting > 0 {
                HStack(spacing: 4) {
                    Rectangle().fill(LiveLook.waiting).frame(width: 7, height: 7)
                    Text("\(state.waiting)")
                }
            }
            if state.running > 0 {
                HStack(spacing: 3) {
                    Text("⠋").fontWeight(.bold).foregroundStyle(LiveLook.busy)
                    Text("\(state.running)")
                }
            }
        }
        .font(LiveLook.mono(12, .medium))
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

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("└─").font(LiveLook.mono(size - 1)).foregroundStyle(LiveLook.faint)
            Text(text).font(.system(size: size)).foregroundStyle(asks ? LiveLook.waiting : LiveLook.secondary)
                .lineLimit(lines).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Two on, two off, one point high.
struct DottedRule: View {
    var body: some View {
        Canvas { context, size in
            var x: CGFloat = 0
            while x < size.width {
                context.fill(Path(CGRect(x: x, y: 0, width: 2, height: 1)), with: .color(LiveLook.rule))
                x += 4
            }
        }
        .frame(height: 1)
        .accessibilityHidden(true)
    }
}

/// Who works on the lead row: a terminal's agent by its mark and name, a task's model by its short name, lowercase.
struct Worker: View {
    let row: LiveState.Row

    var body: some View {
        HStack(spacing: 6) {
            if row.kind == .terminal, let model = row.model, let harness = LiveArt.harness(named: model), let rows = LiveArt.agents[harness] {
                LiveSprite(rows: rows)
            }
            Text((row.model ?? "routing").lowercased()).lineLimit(1)
        }
    }
}

/// The way in when something waits for you: a bracket button on amber with a key cap's darker lower edge. `linked`
/// false draws it without its link, for a picture of the island (a renderer cannot draw a link).
struct OpenButton: View {
    let link: URL
    var linked = true

    var body: some View {
        Group {
            if linked { Link(destination: link) { face } } else { face }
        }
        .padding(.bottom, 3)
    }

    private var face: some View {
        Text("[ open ]").font(LiveLook.mono(13, .semibold)).foregroundStyle(.black)
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
        LiveMark(state: state).padding(.leading, 4)
    }
}

/// Compact island, right of the camera: the one task's clock, the counts when several run, or how it ended.
public struct IslandCompactTrailing: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        Group {
            if state.phase == .ended {
                Rectangle().fill(LiveLook.tint(state)).frame(width: 8, height: 8)
            } else if state.running + state.waiting > 1 {
                Tally(state: state)
            } else if let lead = state.lead {
                LiveClock(since: lead.startedAt, width: 44).font(LiveLook.mono(13, .medium))
                    .foregroundStyle(lead.needsYou ? LiveLook.waiting : LiveLook.secondary)
            }
        }
        .padding(.trailing, 4)
    }
}

/// Expanded island, left of the camera: the mark alone (a word would run under the camera).
public struct IslandLeading: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        LiveMark(state: state).padding(.leading, 8).padding(.top, 2)
    }
}

/// Expanded island, right of the camera: the status word and how long the lead has run (a terminal: has waited).
public struct IslandTrailing: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        HStack(spacing: 8) {
            Text(LiveLook.word(state)).font(LiveLook.mono(13, .semibold)).foregroundStyle(LiveLook.tint(state)).lineLimit(1).fixedSize()
            if let lead = state.lead {
                LiveClock(since: lead.startedAt, width: 44).font(LiveLook.mono(13, .medium)).foregroundStyle(LiveLook.secondary)
            }
        }
        .padding(.trailing, 8).padding(.top, 2)
    }
}

/// Expanded island, the wide bottom, aligned left: the title, `└─` what it is doing or asks, then under a dotted rule
/// who works on it, how many more, and `[ open ]` when it waits for you; or how it ended.
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
                DottedRule().padding(.top, 12).padding(.bottom, 10)
                HStack(spacing: 8) {
                    Worker(row: lead)
                    if let others = LiveLook.others(state) { Text("· \(others)").lineLimit(1) }
                    Spacer(minLength: 4)
                    if lead.needsYou { OpenButton(link: lead.link, linked: linked) }
                }
                .font(LiveLook.mono(12))
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
    }
}

// MARK: - the lock screen

/// The lock screen: the mark, `agentswitch · <Mac>` and the counts (or the word); a dotted rule; then up to three
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
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                LiveMark(state: state)
                Text("agentswitch").font(LiveLook.mono(12, .semibold)).foregroundStyle(LiveLook.text)
                Text("· \(mac)").font(LiveLook.mono(12)).foregroundStyle(LiveLook.faint).lineLimit(1)
                Spacer(minLength: 4)
                if state.running + state.waiting > 1 {
                    Tally(state: state)
                } else {
                    Text(LiveLook.word(state)).font(LiveLook.mono(13, .semibold)).foregroundStyle(LiveLook.tint(state)).fixedSize()
                }
            }
            DottedRule().padding(.top, 11).padding(.bottom, 9)
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
                            RowGlyph(color: LiveLook.waiting, busy: !row.needsYou)
                            Text(row.title).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                            Spacer(minLength: 4)
                            if row.kind == .terminal, let model = row.model, let harness = LiveArt.harness(named: model), let rows = LiveArt.agents[harness] {
                                LiveSprite(rows: rows)
                            }
                            LiveClock(since: row.startedAt, width: 48).font(LiveLook.mono(13, .medium)).foregroundStyle(LiveLook.secondary)
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
    }
}
