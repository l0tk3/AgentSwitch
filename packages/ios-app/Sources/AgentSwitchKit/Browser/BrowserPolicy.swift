import CoreGraphics
import Foundation

/// How much picture a tab's stream asks for (browser-v0 §2: 15–30 frames on the local network, down to 5 and a lower
/// quality over a Tailscale relay). The phone knows how it reached the Mac: by its address's kind, and how long the
/// Mac took to answer when that address was chosen. Tailscale between two machines on a direct path answers about as
/// fast as the local network; through a relay (DERP) it is slower, and then the frames are made smaller too.
public enum BrowserStreamPolicy {
    /// An answer slower than this over Tailscale is taken for a relay.
    public static let relaySeconds = 0.25

    public static let local = BrowserStreamOptions(quality: 70, fps: 15)
    public static let tailnetDirect = BrowserStreamOptions(quality: 60, fps: 10)

    /// `probeSeconds`: how long the address took to answer when it was chosen (nil: not known). `screenPixels`: the
    /// phone's screen in pixels, the most a relay's frames need.
    public static func options(kind: EndpointKind?, probeSeconds: Double?, screenPixels: CGSize? = nil) -> BrowserStreamOptions {
        switch kind {
        case .bonjour, .lan:
            return local
        case .tailnet where (probeSeconds ?? .infinity) < relaySeconds:
            return tailnetDirect
        case .tailnet, .none:
            let width = screenPixels.map { Int($0.width.rounded()) }
            let height = screenPixels.map { Int($0.height.rounded()) }
            return BrowserStreamOptions(quality: 45, fps: 5, maxWidth: width, maxHeight: height)
        }
    }
}

/// What the address bar sends, and what it shows.
public enum BrowserAddress {
    /// The text typed, as the Mac takes it: a port on its own (`5173`, `:5173`) is a local server; anything else goes as
    /// typed (`localhost:5173`, a bare host, `/path`, `~/path`, a URL — the Mac reads it, browser-v0 §5). Nil when empty.
    public static func target(for typed: String) -> BrowserTarget? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let digits = text.hasPrefix(":") ? String(text.dropFirst()) : text
        if !digits.isEmpty, digits.count <= 5, digits.allSatisfy({ $0.isASCII && $0.isNumber }), let port = Int(digits), (1...65_535).contains(port) {
            return .port(port)
        }
        return .url(text)
    }

    /// The bar's text for a URL: `github.com/acme/app/pull/128` (no scheme, no lone `/`), `localhost:5173/`,
    /// `file:///Users/me/x.html`; and whether it is a secure site (the lock).
    public static func display(_ raw: String) -> (text: String, secure: Bool) {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return (raw, false) }
        switch scheme {
        case "https", "http":
            var text = raw.dropFirst(scheme.count + 3)
            if text.hasPrefix("www.") { text = text.dropFirst(4) }
            if text.hasSuffix("/") && text.filter({ $0 == "/" }).count == 1 { text = text.dropLast() }
            return (String(text), scheme == "https")
        case "file":
            return ("file://" + (url.path.removingPercentEncoding ?? url.path), false)
        default:
            return (raw, false)
        }
    }

    /// Typed addresses opened from this phone, newest first, without repeats, at most `limit`.
    public static func remember(_ typed: String, in recent: [String], limit: Int = 8) -> [String] {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return recent }
        return Array(([text] + recent.filter { $0 != text }).prefix(limit))
    }
}

/// What the page says about a hold, the same words as the Mac's footer (ui-v0 §4.1).
public enum BrowserNotice {
    /// Two minutes without input gave the tab back.
    public static let idleHandBack = "2 分钟无操作，已自动交还。"
    /// Said once when a person takes over an agent's tab: what is typed stays on the page for the agent to see after
    /// the hand-back, and Fill Ciphertext is only on one's own tabs (docs/browser-v0.md §2 安全, §6).
    public static let takeOver = "接手期间你输入的内容，交还后 agent 能在页面上看到；密码请在自己的标签里填写。"
    /// Fill Ciphertext asked for on an agent's tab (the key is not offered there).
    public static let fillOwnTabsOnly = "只能在你自己的标签中填入密文。"
}

/// Where a tab is held: the screen ids carry their kind (`mac-…`, `phone-…`, `web-…`); without one the Mac records the
/// paired device's id, or `local`.
public enum BrowserHolder: Equatable, Sendable {
    case mac, iphone, web, elsewhere

    public init(_ screen: String) {
        if screen.hasPrefix("phone") { self = .iphone }
        else if screen.hasPrefix("mac") || screen == "local" { self = .mac }
        else if screen.hasPrefix("web") { self = .web }
        else { self = .elsewhere }
    }

    /// The short words of the holder line (§7.2.7).
    public var label: String {
        switch self {
        case .mac: return "On Mac"
        case .iphone: return "On iPhone"
        case .web: return "On Web"
        case .elsewhere: return "On Another Device"
        }
    }

    /// The sentence for it (§4.1).
    public var said: String {
        switch self {
        case .mac: return "此标签正在 Mac 上使用。"
        case .iphone: return "此标签正在另一台 iPhone 上使用。"
        case .web: return "此标签正在浏览器中使用。"
        case .elsewhere: return "此标签正在另一台设备上使用。"
        }
    }
}
