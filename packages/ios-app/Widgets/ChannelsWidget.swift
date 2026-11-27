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

struct ChannelEntity: AppEntity {
    let id: String
    let name: String

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Channel"
    static let defaultQuery = ChannelQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct ChannelQuery: EntityQuery {
    func entities(for identifiers: [ChannelEntity.ID]) async throws -> [ChannelEntity] {
        let all = suggested()
        return identifiers.compactMap { id in all.first { $0.id == id } }
    }

    func suggestedEntities() async throws -> [ChannelEntity] { suggested() }

    private func suggested() -> [ChannelEntity] {
        (ChannelsShelf.read()?.channels ?? []).map { ChannelEntity(id: $0.id, name: $0.name) }
    }
}

struct ChannelsIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Channels"

    @Parameter(title: "Show", default: .recent)
    var show: ChannelsShow

    @Parameter(title: "Channels")
    var channels: [ChannelEntity]?

    static var parameterSummary: some ParameterSummary {
        When(\.$show, .equalTo, .chosen) {
            Summary { \.$show; \.$channels }
        } otherwise: {
            Summary { \.$show }
        }
    }
}

// MARK: - Timeline

struct ChannelsProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ChannelsEntry {
        ChannelsEntry(date: Date(), snapshot: ChannelsSample.snapshot, choice: .recent, chosen: [])
    }

    func snapshot(for configuration: ChannelsIntent, in context: Context) async -> ChannelsEntry {
        entry(configuration, at: Date(), sample: context.isPreview)
    }

    /// The app reloads the timeline when the list changes; until then the rows' times move on every few minutes.
    func timeline(for configuration: ChannelsIntent, in context: Context) async -> Timeline<ChannelsEntry> {
        let now = Date()
        let entries = (0..<12).map { entry(configuration, at: now.addingTimeInterval(TimeInterval($0) * 300), sample: false) }
        return Timeline(entries: entries, policy: .atEnd)
    }

    private func entry(_ c: ChannelsIntent, at date: Date, sample: Bool) -> ChannelsEntry {
        let kept = ChannelsShelf.read()
        return ChannelsEntry(date: date, snapshot: kept ?? (sample ? ChannelsSample.snapshot : nil), choice: c.show.choice,
                             chosen: (c.channels ?? []).map(\.id))
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
