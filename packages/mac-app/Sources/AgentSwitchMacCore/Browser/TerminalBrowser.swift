import Foundation

/// The tabs of one terminal's agent, for the simple view's side pane (docs/simple-view-v0.md §5.2 右侧栏, user #600):
/// which browser it uses — nil the shared one, else a profile's own by its key — and its tabs there, the one it is busy
/// in or acted on last first (the service sorts them).
public struct TerminalBrowserTabs: Sendable, Equatable, Decodable {
    public let browser: String?
    public let tabs: [BrowserTab]

    public init(browser: String? = nil, tabs: [BrowserTab] = []) {
        self.browser = browser
        self.tabs = tabs
    }

    public static let none = TerminalBrowserTabs()

    /// The picture's stream: a few small frames a second are enough for a column 300–440 points wide.
    public static func stream(width points: Double, backingScale: Double) -> BrowserStreamOptions {
        BrowserStreamOptions(quality: 55, fps: 2, maxWidth: Int((min(max(points, 200), 480) * max(backingScale, 1)).rounded()))
    }
}

extension DaemonClient {
    /// `GET /terminals/:id/browser` (local only: another node's terminals have none here).
    public func terminalBrowser(id: String) async throws -> TerminalBrowserTabs {
        try decode(TerminalBrowserTabs.self, try await call("GET", "/terminals/\(Self.segment(id))/browser"))
    }
}
