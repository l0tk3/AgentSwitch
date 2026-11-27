import Foundation

/// What the home screen's Channels widget shows (docs/app-v0.md §6; user #754): the Mac's rooms as the app last read
/// them, put where the widget extension reads them — the app group's container, shared by the app and the extension.
/// The widget never talks to the Mac itself; it shows the last copy, as of `savedAt`. Only what is drawn is kept: no
/// address, no token, no message but the last one's first line.
public struct ChannelsSnapshot: Codable, Hashable, Sendable {
    public struct Channel: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        public let name: String
        /// The dispatch desk (调度台).
        public let desk: Bool
        public let paused: Bool
        /// Messages not seen yet; `forYou`: one of them names the user.
        public let unread: Int
        public let forYou: Bool
        /// Things in the room that wait on the user's hand (等你处理).
        public let attention: Int
        /// Who said the last thing (`You` for the user), and its first line; nil before anything was said.
        public let from: String?
        public let text: String
        /// When the last thing was said; nil before anything was.
        public let at: Date?

        public init(id: String, name: String, desk: Bool = false, paused: Bool = false, unread: Int = 0, forYou: Bool = false,
                    attention: Int = 0, from: String? = nil, text: String = "", at: Date? = nil) {
            self.id = id
            self.name = name
            self.desk = desk
            self.paused = paused
            self.unread = unread
            self.forYou = forYou
            self.attention = attention
            self.from = from
            self.text = text
            self.at = at
        }

        /// It wants the user: a message that names them not yet seen, or something waiting on their hand.
        public var wantsYou: Bool { (forYou && unread > 0) || attention > 0 }

        /// Where a tap on it goes: the room.
        public var link: URL { LiveLink.room(id) }
    }

    /// In the order the app lists them: the desk first.
    public let channels: [Channel]
    /// The app's look when it wrote this: the widget draws in it.
    public let classic: Bool
    public let savedAt: Date

    public init(channels: [Channel], classic: Bool, savedAt: Date = Date()) {
        self.channels = channels
        self.classic = classic
        self.savedAt = savedAt
    }

    /// How many things wait for the user in all rooms: the small and the lock screen's count.
    public var waiting: Int { channels.reduce(0) { $0 + ($1.attention > 0 ? $1.attention : $1.forYou && $1.unread > 0 ? 1 : 0) } }
    /// Not seen yet, in all rooms.
    public var unread: Int { channels.reduce(0) { $0 + $1.unread } }

    /// Which channels a widget shows, as its owner set it up.
    public enum Choice: String, Codable, Sendable, CaseIterable {
        /// All of them, the one spoken in last first.
        case recent
        /// Only those that want the user, the one spoken in last first.
        case mentions
        /// Those picked, in the order picked.
        case chosen
    }

    /// The channels to draw: at most `limit`.
    public func pick(_ choice: Choice, chosen: [String] = [], limit: Int) -> [Channel] {
        let recent = channels.enumerated().sorted { a, b in
            switch (a.element.at, b.element.at) {
            case let (x?, y?) where x != y: return x > y
            case (nil, _?): return false
            case (_?, nil): return true
            default: return a.offset < b.offset
            }
        }.map(\.element)
        let picked: [Channel]
        switch choice {
        case .recent: picked = recent
        case .mentions: picked = recent.filter(\.wantsYou)
        case .chosen:
            let byId = Dictionary(channels.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            var seen = Set<String>()
            picked = chosen.compactMap { id in seen.insert(id).inserted ? byId[id] : nil }
        }
        return Array(picked.prefix(max(0, limit)))
    }

    /// One line of what was said, as a widget row shows it: Markdown's marks and line breaks gone, and short.
    public static func line(_ text: String, limit: Int = 120) -> String {
        var s = text.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        for mark in ["**", "__", "`", "~~"] { s = s.replacingOccurrences(of: mark, with: "") }
        while s.contains("  ") { s = s.replacingOccurrences(of: "  ", with: " ") }
        s = s.trimmingCharacters(in: .whitespaces)
        return s.count > limit ? String(s.prefix(limit)) + "…" : s
    }
}

/// Where the app keeps the snapshot for the widget: the app group named in both Info.plists (`AgentSwitchAppGroup`,
/// `group.` and the app's bundle id), so a build under another bundle id has a group of its own.
public enum ChannelsShelf {
    public static let file = "channels.json"
    /// The widget's kind, for `WidgetCenter.reloadTimelines(ofKind:)`.
    public static let kind = "Channels"

    /// The group's folder; nil where the build has no group (a signature without the entitlement).
    public static var folder: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "AgentSwitchAppGroup") as? String, !group.isEmpty else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    public static func read(from folder: URL? = folder) -> ChannelsSnapshot? {
        guard let url = folder?.appendingPathComponent(file), let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(ChannelsSnapshot.self, from: data)
    }

    /// Written whole (atomically): the widget never reads half of one. False where there is no group.
    @discardableResult
    public static func write(_ snapshot: ChannelsSnapshot, to folder: URL? = folder) -> Bool {
        guard let url = folder?.appendingPathComponent(file), let data = try? encoder.encode(snapshot) else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }

    /// Forgotten (the Mac unpaired): the widget shows nothing of it.
    public static func clear(in folder: URL? = folder) {
        guard let url = folder?.appendingPathComponent(file) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return d }()
}

extension LiveLink {
    /// `agentswitch://room/<id>`: that room's page.
    public static func room(_ id: String) -> URL {
        URL(string: "\(scheme)://room/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id)")!
    }

    /// `agentswitch://rooms`: the list of rooms.
    public static let rooms = URL(string: "\(scheme)://rooms")!

    /// The room id of an `agentswitch://room/<id>` link.
    public static func roomId(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "room" else { return nil }
        let id = url.pathComponents.dropFirst().first.map { $0.removingPercentEncoding ?? $0 } ?? ""
        return id.isEmpty || id.count > 64 ? nil : id
    }

    public static func isRooms(_ url: URL) -> Bool { url.scheme == scheme && url.host == "rooms" }
}
