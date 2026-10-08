import Foundation

/// What a person asks a tab to open: the address bar's text as typed (a URL, a bare host → https, `localhost:5173` →
/// http, `/path` or `~/path`), a path of the Mac's, or a local port. The daemon resolves it and checks its rules.
public enum BrowserTarget: Sendable, Equatable, Encodable {
    case typed(String)
    case path(String)
    case port(Int)

    private enum Key: String, CodingKey { case url, path, port }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .typed(let text): try c.encode(text, forKey: .url)
        case .path(let path): try c.encode(path, forKey: .path)
        case .port(let port): try c.encode(port, forKey: .port)
        }
    }
}

public enum BrowserHistoryAction: String, Sendable, Equatable, Encodable {
    case back, forward, reload
}

/// What the stream asks of the screencast (`?quality=&fps=&maxWidth=&maxHeight=&scale=`): `scale` is the frame pixels
/// per CSS pixel this screen shows (its device pixels, docs/browser-v0.md §5, 2026-10-03); a daemon from before it
/// ignores it and sends CSS-size frames.
public struct BrowserStreamOptions: Sendable, Equatable {
    public var quality: Int
    public var fps: Int
    public var maxWidth: Int?
    public var maxHeight: Int?
    public var scale: Double?

    /// What the daemon takes (api/browser.ts streamOptions): up to 8 since the page's zoom (docs/browser-v0.md §1
    /// 页面缩放, 2026-10-03: a 2x display at 400 %); a daemon from before it takes more than 3 as 3.
    public static let scaleRange = 1.0...8.0

    public init(quality: Int = BrowserDefaults.streamQuality, fps: Int = BrowserDefaults.streamFPS, maxWidth: Int? = nil, maxHeight: Int? = nil,
                scale: Double? = nil) {
        self.quality = quality
        self.fps = fps
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        self.scale = scale
    }

    var query: String {
        var parts = ["quality=\(min(max(quality, 1), 100))", "fps=\(min(max(fps, 1), 30))"]
        if let maxWidth { parts.append("maxWidth=\(maxWidth)") }
        if let maxHeight { parts.append("maxHeight=\(maxHeight)") }
        if let scale, scale > 1 {
            let s = min(max(scale, Self.scaleRange.lowerBound), Self.scaleRange.upperBound)
            parts.append("scale=" + String(format: "%g", (s * 100).rounded() / 100))
        }
        return parts.joined(separator: "&")
    }
}

/// Everything the Mac's Browser page asks of a Mac's shared browser (docs/browser-v0.md §5; the daemon's
/// api/browser.ts). The page depends on this protocol only: `DaemonClient` (this Mac's local API, local token) conforms;
/// the design preview has a made-up one. `screen` is the screen the call comes from (`BrowserDefaults.screen`): a held
/// tab takes input and navigation only from its holder (409 otherwise), an agent's tab only once taken over.
/// A browser the service holds, to choose which one the Browser page shows (docs/profiles-v0.md §5.2): the one
/// everybody shares (`key` nil), or the own browser of a profile that has a proxy.
public struct BrowserChoice: Decodable, Equatable, Sendable, Identifiable {
    public let key: String?
    /// `Shared`, or the profile's name.
    public let name: String
    /// The agent whose profile it is (`claude-code`); nil for the shared one.
    public let agent: String?
    /// Where its profile's proxy lets traffic out, as last found.
    public let exit: ProfileExit?
    public let running: Bool

    public var id: String { key ?? "" }

    public init(key: String?, name: String, agent: String? = nil, exit: ProfileExit? = nil, running: Bool = false) {
        self.key = key
        self.name = name
        self.agent = agent
        self.exit = exit
        self.running = running
    }

    /// The shared one alone: what is shown before the service has said, and when it cannot say.
    public static let shared = BrowserChoice(key: nil, name: "Shared")
}

extension DaemonClient {
    /// `GET /browsers`: the shared browser, then each profile's own.
    public func browsers() async throws -> [BrowserChoice] {
        struct Reply: Decodable { let browsers: [BrowserChoice] }
        return try decode(Reply.self, try await call("GET", "/browsers")).browsers
    }
}

public protocol BrowserService: Sendable {
    /// `GET /browser/tabs`: whether Chrome is up and the tabs by owner.
    func browserTabs() async throws -> BrowserTabList
    /// `POST /browser/tabs {url | path | port}` → 201 `{tab}`; 403 with the reason in words, 404 for a missing file,
    /// 400 for an address the daemon cannot read. The first tab starts Chrome (a few seconds).
    func openTab(_ target: BrowserTarget) async throws -> BrowserTab
    /// `DELETE /browser/tabs/:id` (any tab, an agent's too).
    func closeTab(id: String) async throws
    /// `GET /browser/tabs/:id/stream` (SSE): the tab, then frames and changes; reconnects after a dropped connection
    /// (the tab again first); ends after `closed`; throws when the tab is gone (404) or the answer is not a stream.
    func tabStream(id: String, options: BrowserStreamOptions) -> AsyncThrowingStream<BrowserStreamEvent, Error>
    /// `POST /browser/tabs/:id/input {screen, events}` (at most 50 events).
    func sendInput(tabId: String, events: [BrowserInputEvent], screen: String) async throws
    /// `POST /browser/tabs/:id/navigate {url | path | port, screen}`.
    func navigate(tabId: String, to target: BrowserTarget, screen: String) async throws -> BrowserTab
    /// `POST /browser/tabs/:id/navigate {action, screen}`.
    func history(tabId: String, _ action: BrowserHistoryAction, screen: String) async throws -> BrowserTab
    /// `POST /browser/tabs/:id/take {screen}`: from whoever held it.
    func takeOver(tabId: String, screen: String) async throws -> BrowserTab
    /// `POST /browser/tabs/:id/release {screen}`: the size goes back to the default (409 when another screen holds it).
    func handBack(tabId: String, screen: String) async throws -> BrowserTab
    /// `POST /browser/tabs/:id/viewport {width, height, scale, mobile, screen}`: only the holder (409 otherwise).
    func setViewport(tabId: String, _ viewport: BrowserViewportRequest, screen: String) async throws -> BrowserTab
    /// `GET /browser/servers`: the Mac's local servers a new tab offers.
    func localServers() async throws -> [BrowserLocalServer]
    /// `POST /browser/tabs/:id/fill {token, screen}` → `{tab, filled: {label, host}}` (docs/browser-v0.md §1
    /// `Fill Ciphertext`, §6): a whole `enc:v1:` ciphertext typed into the page's focused input field, the gate checking
    /// it against that field's frame and every frame above it. Only from a screen that may drive the tab. 400: no
    /// focused input field (or a bad body); 403: the gate's refusal (its reason) or a page or frame that is not
    /// http(s); 404: an unknown tab; 409: not the holder, or the focus moved meanwhile; 503: no gate. The value never
    /// comes back; `BrowserFillText.reason` words the refusals.
    func fill(tabId: String, token: String, screen: String) async throws -> BrowserFillResult
    /// `POST /browser/tabs/:id/show` (docs/browser-v0.md §7.3 窗口): the tab's window before the browser's other
    /// windows; bringing the browser before other apps is this app's to do. 503 where tabs have no windows.
    func showTab(id: String) async throws
    /// `GET /browser/tabs/:id/preview`: a still picture of the tab (JPEG).
    func tabPreview(id: String) async throws -> Data
}

extension BrowserService {
    public func tabStream(id: String) -> AsyncThrowingStream<BrowserStreamEvent, Error> { tabStream(id: id, options: BrowserStreamOptions()) }
}

/// How long each kind of browser call may take.
public enum BrowserTimeouts {
    /// Reads, input and the hold (loopback; the daemon answers at once).
    public static let request: TimeInterval = 15
    /// Opening a tab: the first one starts Chrome.
    public static let open: TimeInterval = 45
    /// Listing the local servers runs `lsof` (up to 5 s twice in the daemon).
    public static let servers: TimeInterval = 20
    /// Filling: the gate's answer (up to 15 s in the daemon), the page's focus read before and after it.
    public static let fill: TimeInterval = 40
}
