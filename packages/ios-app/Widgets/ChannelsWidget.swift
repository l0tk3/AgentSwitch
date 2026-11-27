import AgentSwitchKit
import AgentSwitchLive
import AppIntents
import SwiftUI
import WidgetKit

// The home screen's Channels widget (docs/app-v0.md §6; user #754): the Mac's rooms as the app last read them, from the
// app group (ChannelsShelf). A row opens its room; anywhere else, the rooms list. Drawn in the app's look.

// MARK: - Set up

enum ChannelsShow: String, AppEnum {
    case recent, mentions, chosen

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Show"
    static let caseDisplayRepresentations: [ChannelsShow: DisplayRepresentation] = [
        .recent: "All, Most Recent First",
        .mentions: "Only Mentions",
        .chosen: "Chosen Channels",
    ]

    var choice: ChannelsSnapshot.Choice {
        switch self {
        case .recent: return .recent
        case .mentions: return .mentions
        case .chosen: return .chosen
        }
    }
}

enum ChannelsLookChoice: String, AppEnum {
    case app, classic, pixel

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Look"
    static let caseDisplayRepresentations: [ChannelsLookChoice: DisplayRepresentation] = [
        .app: "Same as App", .classic: "Classic", .pixel: "Pixel",
    ]
}

struct ChannelEntity: AppEntity {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Channel"
    static let defaultQuery = ChannelQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ChannelQuery: EntityQuery {
    func entities(for identifiers: [ChannelEntity.ID]) async throws -> [ChannelEntity] {
        let all = await suggested()
        return identifiers.compactMap { id in all.first { $0.id == id } }
    }

    func suggestedEntities() async throws -> [ChannelEntity] { await suggested() }

    private func suggested() async -> [ChannelEntity] {
        (await ChannelsSource.read()?.snapshot.channels ?? []).map { ChannelEntity(id: $0.id, name: $0.name) }
    }
}

struct ChannelsIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Channels"

    @Parameter(title: "Show", default: .recent)
    var show: ChannelsShow

    @Parameter(title: "Channels")
    var channels: [ChannelEntity]?

    @Parameter(title: "Look", default: .app)
    var look: ChannelsLookChoice

    static var parameterSummary: some ParameterSummary {
        When(\.$show, .equalTo, .chosen) {
            Summary { \.$show; \.$channels; \.$look }
        } otherwise: {
            Summary { \.$show; \.$look }
        }
    }
}

// MARK: - Timeline

/// Where the rows come from: the app's copy in the app group where the build has one, else the Mac itself, reached
/// with what the app left in the shared keychain (WidgetLink). `classic`: the app's look as either says it.
enum ChannelsSource {
    static func read() async -> (snapshot: ChannelsSnapshot, classic: Bool)? {
        if let kept = ChannelsShelf.read() { return (kept, kept.classic) }
        guard let link = WidgetLinkStore.load(), let read = await link.readRooms() else { return nil }
        return (read, link.classic)
    }

    /// The app's look where the widget can tell it, else Classic.
    static func appLook() -> Bool? { ChannelsShelf.read()?.classic ?? WidgetLinkStore.load()?.classic }
}

struct ChannelsProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ChannelsEntry {
        ChannelsEntry(date: Date(), snapshot: ChannelsSample.snapshot, choice: .recent, chosen: [], classic: true)
    }

    func snapshot(for configuration: ChannelsIntent, in context: Context) async -> ChannelsEntry {
        let read = await ChannelsSource.read()
        return entry(configuration, at: Date(), snapshot: read?.snapshot ?? (context.isPreview ? ChannelsSample.snapshot : nil), appClassic: read?.classic)
    }

    /// Read again every 15 minutes (and whenever the app has something new); the rows' times move on every 5.
    func timeline(for configuration: ChannelsIntent, in context: Context) async -> Timeline<ChannelsEntry> {
        let now = Date()
        let read = await ChannelsSource.read()
        let entries = (0..<3).map { entry(configuration, at: now.addingTimeInterval(TimeInterval($0) * 300), snapshot: read?.snapshot, appClassic: read?.classic) }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(900)))
    }

    private func entry(_ c: ChannelsIntent, at date: Date, snapshot: ChannelsSnapshot?, appClassic: Bool?) -> ChannelsEntry {
        let classic: Bool
        switch c.look {
        case .classic: classic = true
        case .pixel: classic = false
        case .app: classic = appClassic ?? ChannelsSource.appLook() ?? true
        }
        return ChannelsEntry(date: date, snapshot: snapshot, choice: c.show.choice, chosen: (c.channels ?? []).map(\.id), classic: classic)
    }
}

// MARK: - Widget

struct ChannelsWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: ChannelsShelf.kind, intent: ChannelsIntent.self, provider: ChannelsProvider()) { entry in
            ChannelsView(entry: entry)
        }
        .configurationDisplayName("Channels")
        .description("Your AgentSwitch channels.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        .contentMarginsDisabled()
    }
}
