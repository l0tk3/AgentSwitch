import AgentSwitchLive
import SwiftUI
import WidgetKit

/// The widget's colours: the app's (Theme.swift there), in the look the app was in when it wrote the copy.
struct ChannelsPalette {
    let classic: Bool
    let dark: Bool

    private func pick(_ light: UInt32, _ dark: UInt32, _ classicLight: UInt32, _ classicDark: UInt32) -> Color {
        let v = classic ? (self.dark ? classicDark : classicLight) : (self.dark ? dark : light)
        return Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    var ground: Color { pick(0xF3F1EC, 0x121212, 0xFFFFFF, 0x1C1C1E) }
    var raised: Color { pick(0xEAE7E0, 0x1F1F1F, 0xF2F2F7, 0x2C2C2E) }
    var ink: Color { pick(0x151413, 0xE9E6DF, 0x1D1D1F, 0xF2F2F7) }
    var secondary: Color { pick(0x5F5B54, 0x8D8A84, 0x6E6E73, 0xA2A2A8) }
    var dim: Color { pick(0xA29D93, 0x4D4B48, 0xA6A6AB, 0x6C6C72) }
    var line: Color { pick(0xDCD8CF, 0x262524, 0xDCDCE0, 0x38383A) }
    var signal: Color { pick(0xE0106E, 0xFF2E88, 0x007AFF, 0x0A84FF) }
    var waiting: Color { pick(0xC27400, 0xFFB000, 0xFF9500, 0xFF9F0A) }
}

/// One drawing of the widget: the copy the app left, and which of its channels the widget was set up to show.
struct ChannelsEntry: TimelineEntry {
    let date: Date
    let snapshot: ChannelsSnapshot?
    let choice: ChannelsSnapshot.Choice
    let chosen: [String]
    /// Drawn in the classic look.
    let classic: Bool

    func rows(_ limit: Int) -> [ChannelsSnapshot.Channel] {
        snapshot?.pick(choice, chosen: chosen, limit: limit) ?? []
    }
}

struct ChannelsView: View {
    let entry: ChannelsEntry
    /// The family drawn; the system's where nil (the app's sample screen sets it).
    var forced: WidgetFamily? = nil
    @Environment(\.widgetFamily) private var given
    private var family: WidgetFamily { forced ?? given }
    @Environment(\.colorScheme) private var scheme

    private var classic: Bool { entry.classic }
    private var palette: ChannelsPalette { ChannelsPalette(classic: classic, dark: scheme == .dark) }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            case .accessoryInline: inline
            default: home
            }
        }
        .widgetURL(LiveLink.rooms)
    }

    // MARK: Home screen

    private var limit: Int {
        switch family {
        case .systemSmall: return 1
        case .systemMedium: return 3
        default: return 7
        }
    }

    private var home: some View {
        let rows = entry.rows(limit)
        return VStack(alignment: .leading, spacing: 0) {
            head
            if entry.snapshot == nil {
                notice("Open AgentSwitch")
            } else if rows.isEmpty {
                notice(entry.choice == .mentions ? "Nothing for you" : "No channels")
            } else if family == .systemSmall, let one = rows.first {
                ChannelsBig(channel: one, now: entry.date, palette: palette, classic: classic)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                        Link(destination: row.link) {
                            ChannelsRow(channel: row, now: entry.date, palette: palette, classic: classic, large: family == .systemLarge)
                        }
                        if i < rows.count - 1 {
                            palette.line.frame(height: classic ? 0.5 : 1).padding(.leading, classic ? 0 : 0)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, family == .systemSmall ? 12 : 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { palette.ground }
    }

    private var head: some View {
        HStack(spacing: 6) {
            if classic {
                Text("Channels").font(.system(size: 13, weight: .semibold)).foregroundStyle(palette.secondary)
            } else {
                Text("// CHANNELS").font(.system(size: 11.5, weight: .bold, design: .monospaced)).foregroundStyle(palette.signal)
            }
            Spacer(minLength: 4)
            if let waiting = entry.snapshot?.waiting, waiting > 0 {
                ChannelsCount(n: waiting, warm: true, palette: palette, classic: classic, mark: true)
            }
        }
        .padding(.bottom, family == .systemSmall ? 8 : 4)
    }

    private func notice(_ words: String) -> some View {
        Text(words)
            .font(classic ? .system(size: 14, weight: .medium) : .system(size: 13, design: .monospaced))
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Lock screen

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "bubble.left.and.bubble.right.fill").font(.system(size: 13, weight: .semibold))
                Text("\(entry.snapshot?.waiting ?? 0)").font(.system(size: 19, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.6)
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var rectangular: some View {
        let first = entry.snapshot?.pick(.mentions, limit: 1).first ?? entry.rows(1).first
        return VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                Text("\(entry.snapshot?.waiting ?? 0) for you").font(.system(size: 14, weight: .semibold))
            }
            .font(.system(size: 12, weight: .semibold))
            if let first {
                Text(first.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(first.text).font(.system(size: 12)).lineLimit(1).opacity(0.8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }

    private var inline: some View {
        let first = entry.snapshot?.pick(.mentions, limit: 1).first
        return Label {
            Text(first.map { "\(entry.snapshot?.waiting ?? 0) · \($0.name)" } ?? "\(entry.snapshot?.waiting ?? 0) for you")
        } icon: {
            Image(systemName: "bubble.left.and.bubble.right.fill")
        }
        .containerBackground(for: .widget) { Color.clear }
    }
}

/// One channel in a row: its name, who said the last thing and what, when, and how many are not seen yet.
struct ChannelsRow: View {
    let channel: ChannelsSnapshot.Channel
    let now: Date
    let palette: ChannelsPalette
    let classic: Bool
    let large: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                ChannelsName(channel: channel, palette: palette, classic: classic, size: large ? 14.5 : 14.5)
                Spacer(minLength: 4)
                if let at = channel.at {
                    Text(ChannelsTime.short(at, now: now))
                        .font(classic ? .system(size: 12) : .system(size: 11, design: .monospaced))
                        .foregroundStyle(channel.unread > 0 ? palette.ink : palette.secondary)
                }
            }
            HStack(spacing: 6) {
                ChannelsSaid(channel: channel, palette: palette, classic: classic)
                    .font(.system(size: large ? 12.5 : 13))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if channel.attention > 0 { ChannelsCount(n: channel.attention, warm: true, palette: palette, classic: classic, mark: true) }
                if channel.unread > 0 { ChannelsCount(n: channel.unread, warm: channel.forYou, palette: palette, classic: classic, mark: false) }
            }
        }
        .padding(.vertical, large ? 6.5 : 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// The small widget's one channel, given room for what was said.
struct ChannelsBig: View {
    let channel: ChannelsSnapshot.Channel
    let now: Date
    let palette: ChannelsPalette
    let classic: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                ChannelsName(channel: channel, palette: palette, classic: classic, size: 15)
                Spacer(minLength: 2)
                if channel.unread > 0 { ChannelsCount(n: channel.unread, warm: channel.forYou, palette: palette, classic: classic, mark: false) }
            }
            ChannelsSaid(channel: channel, palette: palette, classic: classic)
                .font(.system(size: 13))
                .lineLimit(3)
            Spacer(minLength: 0)
            if let at = channel.at {
                Text(ChannelsTime.short(at, now: now))
                    .font(classic ? .system(size: 12) : .system(size: 11, design: .monospaced))
                    .foregroundStyle(palette.secondary)
            }
        }
        .widgetURL(channel.link)
    }
}

struct ChannelsName: View {
    let channel: ChannelsSnapshot.Channel
    let palette: ChannelsPalette
    let classic: Bool
    let size: CGFloat

    var body: some View {
        HStack(spacing: 5) {
            if channel.desk {
                Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                    .font(.system(size: size - 3, weight: .semibold)).foregroundStyle(palette.signal)
            } else if !classic {
                Text("#").font(.system(size: size - 1, weight: .bold, design: .monospaced)).foregroundStyle(palette.dim)
            }
            Text(channel.name).font(.system(size: size, weight: .semibold)).foregroundStyle(palette.ink).lineLimit(1)
            if channel.paused {
                Image(systemName: "pause.fill").font(.system(size: size - 5)).foregroundStyle(palette.secondary)
            }
        }
    }
}

/// `who: what` — the speaker in ink, what was said in the secondary colour.
struct ChannelsSaid: View {
    let channel: ChannelsSnapshot.Channel
    let palette: ChannelsPalette
    let classic: Bool

    var body: some View {
        if let from = channel.from {
            Text("\(Text(from + ": ").foregroundStyle(palette.ink.opacity(0.85)).fontWeight(.medium))\(Text(channel.text).foregroundStyle(palette.secondary))")
        } else {
            Text(channel.text).foregroundStyle(palette.secondary)
        }
    }
}

/// A count: amber where it waits for the user; a capsule in the classic look, `[n]` in the pixel one.
struct ChannelsCount: View {
    let n: Int
    let warm: Bool
    let palette: ChannelsPalette
    let classic: Bool
    /// `⚠`: things that wait on the user's hand rather than messages not seen.
    let mark: Bool

    var body: some View {
        let colour = warm ? palette.waiting : (classic ? palette.dim : palette.secondary)
        if classic {
            HStack(spacing: 2) {
                if mark { Image(systemName: "exclamationmark").font(.system(size: 8.5, weight: .heavy)) }
                Text("\(n)").font(.system(size: 11, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 5.5).frame(minWidth: 18, minHeight: 18)
            .background(colour, in: Capsule())
        } else {
            Text(mark ? "⚠ \(n)" : "[\(n)]").font(.system(size: 11.5, weight: .bold, design: .monospaced)).foregroundStyle(colour)
        }
    }
}

enum ChannelsTime {
    /// `now`, `5m`, `3h`, `2d`: how long ago, short enough for a row.
    static func short(_ at: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(at))
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86_400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86_400))d"
    }
}

/// What a widget in the gallery shows before the app has written anything.
enum ChannelsSample {
    static var snapshot: ChannelsSnapshot {
        let now = Date()
        return ChannelsSnapshot(channels: [
            .init(id: "d", name: "调度台", desk: true, unread: 1, forYou: true, from: "dispatch", text: "@you 开了 2 个会话去做登录页", at: now.addingTimeInterval(-60)),
            .init(id: "a", name: "接口联调", unread: 2, forYou: true, attention: 2, from: "daemon", text: "@you 两个版本都验过了", at: now.addingTimeInterval(-120)),
            .init(id: "b", name: "文档整理", unread: 0, from: "web", text: "过期的段落都标出来了", at: now.addingTimeInterval(-3600)),
            .init(id: "c", name: "demo-app 发布", paused: true, from: "You", text: "先停一下，等我看完迁移脚本", at: now.addingTimeInterval(-7200)),
        ], classic: false)
    }
}
