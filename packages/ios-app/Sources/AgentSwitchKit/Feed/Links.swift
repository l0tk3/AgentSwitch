import Foundation

// Links on the phone (docs/terminal-v0.md §1 iPhone 链接, browser-v0 §1 入口; 2026-10-03, user: 手机上现在点击和复制链接
// 还是费劲，修复一下交互；修复好之后想办法让手机可以方便的点击链接，点击之后直接在agent switch浏览器中打开): what a tap on
// one opens, what its long press offers, and what happens when the Mac's browser cannot take it. Where they are found is
// TerminalLinks (a terminal's screen) and Markdown (Dispatch's text); the screens only draw and forward.

/// Something tapped that opens in the Mac's shared browser.
public enum TappedLink: Hashable, Sendable {
    /// A web address (http or https), as written.
    case web(String)
    /// A file or folder of the Mac's: an absolute path, or one under its home folder (`~/…`).
    case file(String)

    /// A link by its address: http(s) as it is, `file://` as its path; nil for any other scheme (an agent's output could
    /// otherwise name this app's own `agentswitch://pair`).
    public init?(address: String) {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased() else { return nil }
        switch scheme {
        case "http", "https":
            guard url.host?.isEmpty == false else { return nil }
            self = .web(address)
        case "file":
            let path = url.path
            guard path.hasPrefix("/"), path.count > 1 else { return nil }
            self = .file(path)
        default:
            return nil
        }
    }

    /// What `Copy Link` puts on the pasteboard, and what the menu's first line says.
    public var text: String {
        switch self {
        case .web(let address): address
        case .file(let path): path
        }
    }

    /// What the Mac is asked to open (`POST /browser/tabs`).
    public var target: BrowserTarget {
        switch self {
        case .web(let address): .url(address)
        case .file(let path): .path(path)
        }
    }

    /// The address for Safari on this phone: a web address the phone can reach itself. A page of the Mac's own
    /// (`localhost`, a loopback address) is only there on the Mac.
    public var safari: URL? {
        guard case .web(let address) = self, let url = URL(string: address), let host = url.host?.lowercased() else { return nil }
        let loopback = host == "localhost" || host.hasSuffix(".localhost") || host == "::1" || host == "[::1]" || host.hasPrefix("127.") || host == "0.0.0.0"
        return loopback ? nil : url
    }

    /// The long press's menu, the tap's own action first.
    public var actions: [LinkAction] {
        safari == nil ? [.openInBrowser, .copy] : [.openInBrowser, .copy, .openInSafari]
    }

    /// The menu's first line: the address without its scheme, a path with the home folder as `~`.
    public var display: String {
        switch self {
        case .web(let address): BrowserAddress.display(address).text
        case .file(let path): PathDisplay.short(path)
        }
    }
}

/// What can be done with a link.
public enum LinkAction: Hashable, Sendable {
    case openInBrowser, copy, openInSafari

    /// The menu's word (docs/ui-v0.md §7.2.7: short English, title case).
    public func label(for link: TappedLink) -> String {
        switch self {
        case .openInBrowser: "Open in Browser"
        case .copy: if case .file = link { "Copy Path" } else { "Copy Link" }
        case .openInSafari: "Open in Safari"
        }
    }

    /// Said for a moment after copying.
    public static func copied(_ link: TappedLink) -> String {
        if case .file = link { "Path Copied" } else { "Link Copied" }
    }
}

/// A link the Mac's browser did not open.
public enum LinkOpening {
    public enum Failure: Equatable, Sendable {
        /// No Mac answers now.
        case notConnected
        /// The Mac has no browser: an AgentSwitch that predates it, or one with the browser switched off.
        case noBrowser
        /// The Mac said no, or could not: its reason in words (a protected path, a missing file, Chrome not starting).
        case refused(String)
    }

    /// What then: a web address the phone can reach opens in Safari, as before there was a shared browser, and the
    /// reason is said; anything else is only said.
    public static func fallback(_ link: TappedLink, _ failure: Failure) -> (safari: URL?, said: String) {
        let safari = link.safari
        switch failure {
        case .notConnected:
            return (safari, safari != nil ? "未连接到 Mac，已在 Safari 中打开。" : "未连接到 Mac，无法在 Mac 的浏览器中打开。")
        case .noBrowser:
            return (safari, safari != nil ? "此 Mac 上的 AgentSwitch 未提供浏览器，已在 Safari 中打开。" : "此 Mac 上的 AgentSwitch 未提供浏览器：版本过旧，或浏览器已关闭。")
        case .refused(let reason):
            let why = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            if case .file = link { return (nil, why.isEmpty ? "Mac 未能打开此文件。" : why) }
            guard safari != nil else { return (nil, why.isEmpty ? "Mac 未能打开此链接。" : why) }
            return (safari, why.isEmpty ? "Mac 未能打开此链接，已在 Safari 中打开。" : "Mac 未能打开此链接（\(why)），已在 Safari 中打开。")
        }
    }

    /// How a failed `POST /browser/tabs` counts: a 404 for a web address is a Mac without the route (a file's 404 is a
    /// file that is not there, said in the Mac's words); no answer at all is no connection.
    public static func failure(_ error: Error, for link: TappedLink) -> Failure {
        switch error as? APIError {
        case .http(status: 404, message: let message)?:
            if case .web = link { return .noBrowser }
            return .refused(message.isEmpty ? "文件不存在。" : message)
        case .unreachable?, .transport?:
            return .notConnected
        default:
            return .refused(error.localizedDescription)
        }
    }
}

/// Web addresses and Mac paths as they stand in running text.
public enum LinkText {
    /// A character a web address runs over once it has begun: printable ASCII but for what ends one in prose. Chinese
    /// text and its punctuation follow an address without a space, and are not part of it.
    public static func inAddress(_ c: Character) -> Bool {
        guard let a = c.asciiValue else { return false }
        return a > 0x20 && a < 0x7F && !ends.contains(c)
    }

    private static let ends: Set<Character> = ["<", ">", "\"", "`", "{", "}", "|", "\\", "^"]
    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", "'", "*", "_", "~"]

    /// An address with what prose put after it taken off its end: a sentence's punctuation, and a bracket that closes
    /// one opened before the address began (`(see https://example.com/a_(b))` keeps its own pair).
    public static func trimmed(_ address: Substring) -> Substring {
        var s = address
        while let last = s.last {
            if trailing.contains(last) { s = s.dropLast(); continue }
            if last == ")" && s.filter({ $0 == ")" }).count > s.filter({ $0 == "(" }).count { s = s.dropLast(); continue }
            if last == "]" && s.filter({ $0 == "]" }).count > s.filter({ $0 == "[" }).count { s = s.dropLast(); continue }
            break
        }
        return s
    }

    /// Where an `http://` or `https://` address begins in `text` at or after `from`, any case.
    public static func schemeStart(in text: [Character], from: Int = 0) -> Int? {
        var i = from
        while i + 7 <= text.count {
            if text[i] == "h" || text[i] == "H" {
                let head = String(text[i..<min(i + 8, text.count)]).lowercased()
                if head.hasPrefix("http://") || head.hasPrefix("https://") { return i }
            }
            i += 1
        }
        return nil
    }

    /// The web addresses written out in `text`, in order, each with where it stands. An address runs from its scheme
    /// to the first character that is not an address's, less what `trimmed` takes off; a scheme alone is none.
    public static func webAddresses(in text: String) -> [(range: Range<String.Index>, address: String)] {
        let chars = Array(text)
        var out: [(Range<String.Index>, String)] = []
        var at = 0
        while let start = schemeStart(in: chars, from: at) {
            var end = start
            while end < chars.count, inAddress(chars[end]) { end += 1 }
            let cut = trimmed(Substring(String(chars[start..<end])))
            at = max(end, start + 1)
            guard let scheme = cut.range(of: "://"), cut[scheme.upperBound...].contains(where: { $0.isLetter || $0.isNumber }) else { continue }
            let lower = text.index(text.startIndex, offsetBy: start), upper = text.index(lower, offsetBy: cut.count)
            out.append((lower..<upper, String(cut)))
        }
        return out
    }

    private static let position = try! NSRegularExpression(pattern: #"(:\d+){1,2}$"#)
    /// A file's name with an extension: a dot after something, then up to eight letters and digits, a letter among them
    /// (`a.md`, `x.tar`, `p.mp4`; not `v2.1`, not `.env`'s lone dot at the start).
    private static let named = try! NSRegularExpression(pattern: #"^[^/]*[^/.]\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$"#)

    /// A word as a path of the Mac's, or nil when it is not one: absolute with at least two parts (`/help` is a
    /// command, `//` a comment), under the home folder (`~/x`), or relative to `workdir` — `./x`, `../x`, or folders
    /// down to a file name with an extension (`docs/a.md`; `and/or`, `text/plain`, `1/2` are words). `:12:5` after it
    /// (a place in the file) is not part of the path. Nothing with a scheme, and nothing a relative path can be
    /// resolved against when `workdir` is not known.
    public static func macPath(_ word: String, workdir: String?) -> String? {
        var s = word
        if let m = position.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range, in: s) { s.removeSubrange(r) }
        guard !s.isEmpty, s.count <= 1024, !s.contains("://"), !s.contains(where: { $0.isWhitespace || $0 == "\u{0}" }) else { return nil }
        if s.hasPrefix("~/") { return s.count > 2 ? s : nil }
        let parts = s.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if s.hasPrefix("/") {
            let rest = Array(parts.dropFirst())
            let folders = rest.last == "" ? Array(rest.dropLast()) : rest   // a folder written with its closing slash
            return folders.count >= 2 && folders.allSatisfy({ !$0.isEmpty }) ? s : nil
        }
        guard let workdir, workdir.hasPrefix("/") else { return nil }
        let base = workdir.hasSuffix("/") ? String(workdir.dropLast()) : workdir
        if s.hasPrefix("./") { return s.count > 2 ? "\(base)/\(s.dropFirst(2))" : nil }
        if s.hasPrefix("../") { return s.count > 3 ? "\(base)/\(s)" : nil }
        guard parts.count >= 2, parts.allSatisfy({ !$0.isEmpty }), let name = parts.last, let first = s.first,
              first.isLetter || first.isNumber || first == "_" || first == "." || first == "@",
              named.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil else { return nil }
        return "\(base)/\(s)"
    }
}
