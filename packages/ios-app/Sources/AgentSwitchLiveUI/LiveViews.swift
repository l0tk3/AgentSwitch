import AgentSwitchLive
import SwiftUI

/// The Live Activity's views (assistant-v0 §4), in a package so the Mac can render them in tests (LiveRenderTests);
/// the widget extension places them in the Dynamic Island's regions and on the lock screen. Everything is drawn for a
/// black background: the island is always black and the lock screen card gets a dark tint, so white text reads on any
/// wallpaper. The corners of the island clip, so nothing sits in them.
public enum LiveLook {
    public static let text = Color.white
    public static let secondary = Color.white.opacity(0.72)
    public static let faint = Color.white.opacity(0.5)
    public static let background = Color.black.opacity(0.82)

    /// docs/ui-v0.md §7.3's status colours (dark set: the island and the card are dark): waiting amber, busy cyan, ok
    /// green, failed red.
    public static let waiting = Color(red: 1, green: 0.69, blue: 0)
    public static let busy = Color(red: 0.18, green: 0.9, blue: 1)
    public static let ok = Color(red: 0.61, green: 0.89, blue: 0.18)
    public static let failed = Color(red: 1, green: 0.29, blue: 0.24)

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

    /// A tap opens the task that matters most: the one waiting for you, the newest, or the one that ended last.
    public static func link(_ state: LiveState) -> URL? {
        (state.lead?.id ?? state.ended?.taskId).map(LiveLink.task)
    }

    /// "+2 more" when the island shows one of several.
    public static func others(_ state: LiveState) -> String? {
        let more = state.running + state.waiting - 1
        return more > 0 ? "+\(more) more" : nil
    }
}

/// The status in pixels (§7.2.4: static places show the spinner's first frame): ⠋ while busy, a square otherwise, in
/// the status colour. The compact and minimal island, and the leading corner.
public struct StatusGlyph: View {
    let state: LiveState
    let size: CGFloat

    public init(state: LiveState, size: CGFloat = 22) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        Group {
            if state.phase == .running {
                Text("⠋").font(.system(size: size * 0.8, weight: .bold, design: .monospaced))
            } else {
                Rectangle().frame(width: size * 0.4, height: size * 0.4)
            }
        }
        .foregroundStyle(LiveLook.tint(state))
        .frame(width: size, height: size)
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

/// Expanded island, leading corner: the glyph and one word of status.
public struct IslandLeading: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        HStack(spacing: 6) {
            StatusGlyph(state: state, size: 24)
            Text(LiveLook.word(state)).font(.system(size: 14, weight: .semibold, design: .monospaced)).foregroundStyle(LiveLook.tint(state))
                .lineLimit(1).fixedSize()
        }
        .padding(.leading, 6)
    }
}

/// Expanded island, trailing corner: how long the leading task has run.
public struct IslandTrailing: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        if let lead = state.lead {
            LiveClock(since: lead.startedAt, width: 58).font(.system(size: 17, weight: .semibold)).foregroundStyle(LiveLook.text)
                .padding(.trailing, 8)
        }
    }
}

/// Expanded island, under the camera: the title.
public struct IslandCenter: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        Text(state.lead?.title ?? state.ended?.title ?? "AgentSwitch")
            .font(.system(size: 17, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
    }
}

/// Expanded island, the wide bottom: what it is doing (or asks), then the model and how many more; a way in when it
/// waits for you.
public struct IslandBottom: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let lead = state.lead {
                Text(lead.step).font(.system(size: 15)).foregroundStyle(lead.needsYou ? LiveLook.text : LiveLook.secondary)
                    .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 8) {
                    if let model = lead.model { Chip(text: model) }
                    if let others = LiveLook.others(state) { Text(others).font(.system(size: 12, design: .monospaced)).foregroundStyle(LiveLook.faint) }
                    Spacer(minLength: 0)
                    if lead.needsYou {
                        Link(destination: LiveLink.task(lead.id)) {
                            Text("[ open ]").font(.system(size: 14, weight: .semibold, design: .monospaced)).foregroundStyle(.black)
                                .padding(.horizontal, 10).padding(.vertical, 6).background(LiveLook.waiting)
                        }
                    }
                }
            } else if let ended = state.ended {
                Text(ended.line).font(.system(size: 15)).foregroundStyle(LiveLook.secondary).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
    }
}

/// Compact island, right of the camera: the count when several run, else the one task's clock.
public struct IslandCompactTrailing: View {
    let state: LiveState
    public init(state: LiveState) { self.state = state }

    public var body: some View {
        let count = state.running + state.waiting
        if count > 1 {
            Text("\(count)").font(.system(size: 14, weight: .bold)).foregroundStyle(LiveLook.tint(state)).frame(minWidth: 20)
        } else if let lead = state.lead {
            LiveClock(since: lead.startedAt, width: 40).font(.system(size: 13, weight: .semibold)).foregroundStyle(LiveLook.tint(state))
        } else {
            StatusGlyph(state: state, size: 18)
        }
    }
}

struct Chip: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(LiveLook.secondary).lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(Rectangle().strokeBorder(Color.white.opacity(0.25), lineWidth: 1))
    }
}

/// The lock screen: a header with the status and counts, then up to three tasks (the one waiting for you first, its
/// question in orange), or the last conclusion.
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
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusGlyph(state: state, size: 22)
                Text(LiveLook.word(state)).font(.system(size: 15, weight: .semibold, design: .monospaced)).foregroundStyle(LiveLook.tint(state))
                Text("AgentSwitch · \(mac)").font(.system(size: 13)).foregroundStyle(LiveLook.faint).lineLimit(1)
                Spacer(minLength: 4)
                if state.running + state.waiting > 1 {
                    Text("\(state.running + state.waiting) tasks").font(.system(size: 13, weight: .medium, design: .monospaced)).foregroundStyle(LiveLook.secondary)
                }
            }
            if let ended = state.ended, state.rows.isEmpty {
                Text(ended.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                Text(ended.line).font(.system(size: 14)).foregroundStyle(LiveLook.secondary).lineLimit(2)
            }
            ForEach(state.rows) { row in
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(LiveLook.text).lineLimit(1)
                        Text(row.step).font(.system(size: 13)).foregroundStyle(row.needsYou ? LiveLook.waiting : LiveLook.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    LiveClock(since: row.startedAt, width: 52).font(.system(size: 13, weight: .medium)).foregroundStyle(LiveLook.secondary)
                }
            }
            if stale {
                Text("内容可能已过期，打开 AgentSwitch 以刷新。").font(.system(size: 11)).foregroundStyle(LiveLook.faint)
            }
        }
        .padding(16)
    }
}
