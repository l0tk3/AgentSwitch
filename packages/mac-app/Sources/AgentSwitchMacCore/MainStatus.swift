import Foundation

// The main window's status bar (docs/dispatch-v0.md §1, 左侧图标栏与整窗状态栏; demo `implemented/window-bars.html`):
// one row across the whole window, under the rail and the page. Its left is the app's and the same on every page — the
// gateway and the phones; its right is the page's — the terminal on screen, the browser tab's hold, Dispatch's router
// and topics. The words are here; the bar only draws them.

public enum MainStatus {
    /// A word of the bar and how it is drawn.
    public struct Word: Equatable, Sendable {
        public enum Tone: Equatable, Sendable { case ok, busy, failed }

        public let text: String
        public let tone: Tone

        public init(_ text: String, _ tone: Tone) {
            self.text = text
            self.tone = tone
        }
    }

    /// `Gateway` (green) while the service and the gateway answer; `Service Down` or `Gateway Down` (red) while one does
    /// not (the service first, as the bar said it before); `Starting` while one is on its way up.
    public static func gateway(service: StatusLine, gateway: StatusLine) -> Word {
        if let trouble = ServiceTrouble.word(service: service, gateway: gateway) { return Word(trouble, .failed) }
        if service.level == .busy || gateway.level == .busy { return Word("Starting", .busy) }
        return Word("Gateway", .ok)
    }

    /// The phones, from `GET /remote/info`'s count and the paired devices (nil: not read yet): `iPhone Online` (the one
    /// online device is an iPhone), `1 Device Online`, `2 Devices Online`, `No Device Online`, `Not Paired`. Nil while
    /// remote access is off, or nothing is known yet.
    public static func phones(_ devices: [Device]?, online: Int?, remoteEnabled: Bool) -> String? {
        guard remoteEnabled else { return nil }
        let active = devices?.filter { !$0.isRevoked }
        if let active, active.isEmpty { return "Not Paired" }
        guard let live = online ?? active.map({ $0.filter { $0.online == true }.count }) else { return nil }
        switch live {
        case ...0: return "No Device Online"
        case 1:
            let up = active?.filter { $0.online == true } ?? []
            let iPhone = up.count == 1 ? up[0] : active?.count == 1 ? active?[0] : nil
            return iPhone.map { $0.platform.lowercased() == "ios" } == true ? "iPhone Online" : "1 Device Online"
        default: return "\(live) Devices Online"
        }
    }

    /// Dispatch's right: the router's model (`Router · DeepSeek Flash`) and the topics (`2 Topics`); each only when known.
    public static func dispatch(router: String?, topics: Int) -> [String] {
        var words: [String] = []
        if let router, !router.isEmpty { words.append("Router · \(ModelName.display(router))") }
        if topics > 0 { words.append(topics == 1 ? "1 Topic" : "\(topics) Topics") }
        return words
    }
}

/// The terminal on screen as the status bar says it, from the terminal page's report (`context`, terminal.js): its
/// agent and model, its permission mode, where its size is held and its grid; whether a sealed reply can go to it.
public struct TerminalContext: Equatable, Sendable {
    public var harness: String
    public var model: String?
    public var mode: String?
    public var cols: Int?
    public var rows: Int?
    /// Where the terminal is in use when it is not in this window (`iphone`, `web`, `mac` for another window of a Mac,
    /// as the page's placeholder says them); nil while it is here or nowhere.
    public var away: String?
    /// The terminal runs: the lock (Encrypt & Send) acts.
    public var running: Bool
    /// The pane shows the terminal's record, not its screen (docs/simple-view-v0.md §5.2): it holds no size here, and
    /// the bar says `Simple` where the size was.
    public var simple = false
    /// The profile it runs under, when it is not the Mac's own (docs/profiles-v0.md §3): said between agent and model.
    public var profile: String?
    /// That profile's colour: a lit dot before the words.
    public var profileColor: ProfileColor?
    /// The device Claude Code says it is here (docs/profiles-v0.md §3.5); nil: not known, or another agent.
    public var device: String?

    public init(harness: String, model: String? = nil, mode: String? = nil, cols: Int? = nil, rows: Int? = nil,
                away: String? = nil, running: Bool = true) {
        self.harness = harness
        self.model = model
        self.mode = mode
        self.cols = cols
        self.rows = rows
        self.away = away
        self.running = running
    }

    /// The page's report: nil for none (a terminal being made, an empty list) or one without an agent.
    public init?(report: [String: Any]) {
        guard let harness = report["harness"] as? String, !harness.isEmpty else { return nil }
        self.init(harness: harness,
                  model: (report["model"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                  mode: (report["mode"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                  cols: (report["cols"] as? NSNumber)?.intValue,
                  rows: (report["rows"] as? NSNumber)?.intValue,
                  away: (report["away"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                  running: report["running"] as? Bool ?? true)
    }

    /// The same as the native screen knows it: the grid the service has now and where the terminal is in use, heard from
    /// its stream before the page's list catches up. Without a grid (the stream has not said it yet) the page's words stay.
    public func seen(cols: Int?, rows: Int?, away: String?) -> TerminalContext {
        guard let cols, let rows else { return self }
        var seen = self
        seen.cols = cols
        seen.rows = rows
        seen.away = away
        return seen
    }

    /// `claude · Opus 5.5`; the agent alone without a model (its default).
    public var agent: String {
        let name = [harness == "claude-code" ? "claude" : harness, profile].compactMap { $0 }.joined(separator: " · ")
        guard let model else { return name }
        return "\(name) · \(ModelName.display(model))"
    }

    /// The same as `look` writes it: the classic look says the agent's name as people do (`Claude Code · Opus 5.5`,
    /// docs/ui-v0.md §8).
    public func agent(in look: InterfaceLook) -> String {
        guard look.isClassic else { return agent }
        let name = [HarnessName.display(harness), profile].compactMap { $0 }.joined(separator: " · ")
        guard let model else { return name }
        return "\(name) · \(ModelName.display(model))"
    }

    /// `size` as `look` writes it: `On This Mac · 139×46` in the classic look.
    public func size(in look: InterfaceLook) -> String { ClassicWords.phrase(size, in: look) }

    /// `On Mac · 139×46`, `On iPhone · 50×30`: where the size is held and the grid (the place alone without one), in
    /// the placeholder's words.
    public var size: String {
        if simple { return "Simple" }
        let place: String = switch away {
        case "iphone": "On iPhone"
        case "web": "On Web"
        default: "On Mac"
        }
        guard let cols, let rows, cols > 0, rows > 0 else { return place }
        return "\(place) · \(cols)×\(rows)"
    }
}

/// The device Claude Code says it is (docs/profiles-v0.md §3.5): a long run of hex digits it made on its first run with
/// a folder, a profile's own. The bar shows its first digits; the whole of it is a tooltip and a click away.
public enum DeviceID {
    public static let shown = 8

    public static func valid(_ id: String) -> Bool {
        (16...128).contains(id.count) && id.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains($0)) }
    }

    /// `56967b93`.
    public static func short(_ id: String) -> String { String(id.prefix(shown)) }
    /// `ID 56967b93`, as the bar says it.
    public static func label(_ id: String) -> String { "ID \(short(id))" }
    /// The tooltip: what it is, and the whole of it.
    public static func help(_ id: String) -> String { "Claude Code 在这个配置下上报的设备标识，点击复制：\(id)" }
}
