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

    public static func tint(_ state: LiveState) -> Color {
        switch state.phase {
        case .needsYou: return .orange
        case .running: return Color(red: 0.35, green: 0.68, blue: 1)
        case .ended: return state.ended?.ok == true ? .green : Color(red: 1, green: 0.4, blue: 0.4)
        }
    }

    public static func symbol(_ state: LiveState) -> String {
        switch state.phase {
        case .needsYou: return "hand.raised.fill"
        case .running: return "bolt.fill"
        case .ended: return state.ended?.ok == true ? "checkmark" : "xmark"
        }
    }

    public static func word(_ state: LiveState) -> String {
        switch state.phase {
        case .needsYou: return "等你处理"
        case .running: return "执行中"
        case .ended: return state.ended?.ok == true ? "完成了" : "没做成"
        }
    }

    /// A tap opens the task that matters most: the one waiting for you, the newest, or the one that ended last.
    public static func link(_ state: LiveState) -> URL? {
        (state.lead?.id ?? state.ended?.taskId).map(LiveLink.task)
    }

    /// "另有 2 个任务" when the island shows one of several.
    public static func others(_ state: LiveState) -> String? {
        let more = state.running + state.waiting - 1
        return more > 0 ? "另有 \(more) 个任务" : nil
    }
}

/// The status symbol in a tinted disc: the compact and minimal island, and the leading corner.
public struct StatusGlyph: View {
    let state: LiveState
    let size: CGFloat

    public init(state: LiveState, size: CGFloat = 22) {
        self.state = state
        self.size = size
    }

    public var body: some View {
        Image(systemName: LiveLook.symbol(state))
            .font(.system(size: size * 0.52, weight: .bold))
            .foregroundStyle(.black)
            .frame(width: size, height: size)
            .background(LiveLook.tint(state), in: Circle())
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
            Text(LiveLook.word(state)).font(.system(size: 14, weight: .semibold)).foregroundStyle(LiveLook.tint(state))
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
                    if let others = LiveLook.others(state) { Text(others).font(.system(size: 12)).foregroundStyle(LiveLook.faint) }
                    Spacer(minLength: 0)
                    if lead.needsYou {
                        Link(destination: LiveLink.task(lead.id)) {
                            Text("去处理").font(.system(size: 14, weight: .semibold)).foregroundStyle(.black)
                                .padding(.horizontal, 14).padding(.vertical, 6).background(.orange, in: Capsule())
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
            Image(systemName: LiveLook.symbol(state)).foregroundStyle(LiveLook.tint(state))
        }
    }
}

struct Chip: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(LiveLook.secondary).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Color.white.opacity(0.14), in: Capsule())
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
                Text(LiveLook.word(state)).font(.system(size: 15, weight: .semibold)).foregroundStyle(LiveLook.tint(state))
                Text("AgentSwitch · \(mac)").font(.system(size: 13)).foregroundStyle(LiveLook.faint).lineLimit(1)
                Spacer(minLength: 4)
                if state.running + state.waiting > 1 {
                    Text("\(state.running + state.waiting) 个任务").font(.system(size: 13, weight: .medium)).foregroundStyle(LiveLook.secondary)
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
                        Text(row.step).font(.system(size: 13)).foregroundStyle(row.needsYou ? .orange : LiveLook.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    LiveClock(since: row.startedAt, width: 52).font(.system(size: 13, weight: .medium)).foregroundStyle(LiveLook.secondary)
                }
            }
            if stale {
                Text("可能不是最新：打开 AgentSwitch 更新").font(.system(size: 11)).foregroundStyle(LiveLook.faint)
            }
        }
        .padding(16)
    }
}
