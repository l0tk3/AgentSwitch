#if DEBUG
import AgentSwitchKit
import AgentSwitchLive
import SwiftUI
import WidgetKit

/// The Channels widget's views at the home screen's sizes on this phone, for screenshots (`-uiDemoScreen widgets`,
/// `widgetslock`): the copy is the one the demo rooms just wrote to the app group, as the widget reads it.
struct ChannelsWidgetDemo: View {
    let lock: Bool
    @Environment(\.colorScheme) private var scheme

    private var snapshot: ChannelsSnapshot? {
        ChannelsShelf.read() ?? { print("ChannelsWidgetDemo: no copy in the app group"); return nil }()
    }

    var body: some View {
        let entry = { (choice: ChannelsSnapshot.Choice, chosen: [String]) in
            ChannelsEntry(date: Date(), snapshot: snapshot, choice: choice, chosen: chosen)
        }
        ZStack {
            LinearGradient(colors: lock ? [Color(red: 0.16, green: 0.2, blue: 0.32), Color(red: 0.36, green: 0.24, blue: 0.3)] : scheme == .dark ? [Color(white: 0.16), Color(red: 0.12, green: 0.1, blue: 0.2)]
                                                   : [Color(red: 0.78, green: 0.84, blue: 0.95), Color(red: 0.93, green: 0.86, blue: 0.82)],
                           startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            if lock {
                VStack(spacing: 14) {
                    Text("9:41").font(.system(size: 88, weight: .semibold, design: .rounded)).foregroundStyle(.white.opacity(0.9))
                    HStack(spacing: 14) {
                        ChannelsView(entry: entry(.recent, []), forced: .accessoryCircular).frame(width: 72, height: 72).background(Circle().fill(.white.opacity(0.18)))
                        ChannelsView(entry: entry(.recent, []), forced: .accessoryRectangular).frame(width: 160, height: 72)
                    }
                    .foregroundStyle(.white)
                    ChannelsView(entry: entry(.recent, []), forced: .accessoryInline).foregroundStyle(.white)
                    Spacer()
                }
                .padding(.top, 60)
            } else {
                VStack(spacing: 22) {
                    HStack(spacing: 22) {
                        tile(entry(.recent, []), .systemSmall, width: 170, height: 170)
                        tile(entry(.chosen, [DemoRooms.roomId]), .systemSmall, width: 170, height: 170)
                    }
                    tile(entry(.mentions, []), .systemMedium, width: 364, height: 170)
                    tile(entry(.recent, []), .systemLarge, width: 364, height: 382)
                }
            }
        }
    }

    private func tile(_ entry: ChannelsEntry, _ family: WidgetFamily, width: CGFloat, height: CGFloat) -> some View {
        let palette = ChannelsPalette(classic: entry.snapshot?.classic ?? false, dark: scheme == .dark)
        return ChannelsView(entry: entry, forced: family)
            .frame(width: width, height: height)
            .background(palette.ground)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}
#endif
