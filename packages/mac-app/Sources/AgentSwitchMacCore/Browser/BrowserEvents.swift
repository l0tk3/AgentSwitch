import Foundation

// One tab's stream (`GET /browser/tabs/:id/stream`, SSE; docs/browser-v0.md §5): the event name is the type, the data
// its JSON. The tab first, then frames and changes as they come; `closed` ends it.

/// One screencast frame: a JPEG (base64, decoded only for the frame that is drawn), its pixel size, and how many of its
/// pixels make one CSS pixel of the page (`scale`), so a point on the frame maps to the page as `x / scale`.
public struct BrowserFrame: Sendable, Equatable {
    public let seq: Int
    /// Base64 JPEG, as sent.
    public let data: String
    public let width: Double
    public let height: Double
    public let scale: Double
    /// The page's viewport in CSS pixels when the frame was drawn.
    public let viewportWidth: Double
    public let viewportHeight: Double
    public let pageScale: Double
    public let scrollX: Double
    public let scrollY: Double

    public init(seq: Int, data: String, width: Double, height: Double, scale: Double = 1, viewportWidth: Double? = nil,
                viewportHeight: Double? = nil, pageScale: Double = 1, scrollX: Double = 0, scrollY: Double = 0) {
        self.seq = seq
        self.data = data
        self.width = width
        self.height = height
        self.scale = scale > 0 ? scale : 1
        self.viewportWidth = viewportWidth ?? width / (scale > 0 ? scale : 1)
        self.viewportHeight = viewportHeight ?? height / (scale > 0 ? scale : 1)
        self.pageScale = pageScale
        self.scrollX = scrollX
        self.scrollY = scrollY
    }

    /// The JPEG's bytes; nil when the base64 does not decode.
    public var jpeg: Data? { Data(base64Encoded: data, options: .ignoreUnknownCharacters) }

    /// Where its pixels sit on the page (BrowserGeometry).
    public var geometry: BrowserFrameGeometry { BrowserFrameGeometry(seq: seq, width: width, height: height, scale: scale) }
}

/// Why a hold ended: another screen took the tab, it was handed back, or two minutes passed without input.
public enum BrowserHeldReason: String, Sendable, Equatable {
    case take
    case handBack = "hand-back"
    case idle
}

/// Why a stream ended: the tab closed, Chrome went away, or the service is stopping.
public enum BrowserClosedReason: String, Sendable, Equatable {
    case closed
    case browserExited = "browser-exited"
    case shutdown
}

/// One event of a tab's stream.
public enum BrowserStreamEvent: Sendable, Equatable {
    case tab(BrowserTab)
    case frame(BrowserFrame)
    case url(url: String, site: String, kind: BrowserPlaceKind)
    case title(String)
    case loading(Bool)
    case status(BrowserTabStatus)
    case held(heldBy: String?, reason: BrowserHeldReason?)
    case action(BrowserAction?)
    case viewport(BrowserViewport)
    case closed(BrowserClosedReason?)

    /// The event from its SSE name and JSON data; nil for one the page does not know or that does not decode (skipped,
    /// never ending the stream).
    public static func decode(event: String, data: String) -> BrowserStreamEvent? {
        let bytes = Data(data.utf8)
        guard let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
        let type = event == "message" ? (object["type"] as? String ?? "") : event
        func number(_ key: String) -> Double? { (object[key] as? NSNumber)?.doubleValue }
        func string(_ key: String) -> String? { object[key] as? String }
        func decoded<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
            guard let value = object[key], !(value is NSNull), JSONSerialization.isValidJSONObject(value),
                  let json = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return try? JSONDecoder().decode(T.self, from: json)
        }
        switch type {
        case "tab":
            return decoded(BrowserTab.self, "tab").map(BrowserStreamEvent.tab)
        case "frame":
            guard let seq = number("seq"), let data = string("data"), let width = number("width"), let height = number("height") else { return nil }
            let viewport = object["viewport"] as? [String: Any]
            return .frame(BrowserFrame(seq: Int(seq), data: data, width: width, height: height, scale: number("scale") ?? 1,
                                       viewportWidth: (viewport?["width"] as? NSNumber)?.doubleValue,
                                       viewportHeight: (viewport?["height"] as? NSNumber)?.doubleValue,
                                       pageScale: number("pageScale") ?? 1, scrollX: number("scrollX") ?? 0, scrollY: number("scrollY") ?? 0))
        case "url":
            guard let url = string("url") else { return nil }
            let kind = string("kind").flatMap(BrowserPlaceKind.init(rawValue:)) ?? .web
            return .url(url: url, site: string("site") ?? "", kind: kind)
        case "title":
            return string("title").map(BrowserStreamEvent.title)
        case "loading":
            return (object["loading"] as? Bool).map(BrowserStreamEvent.loading)
        case "status":
            return .status(string("status").flatMap(BrowserTabStatus.init(rawValue:)) ?? .idle)
        case "held":
            return .held(heldBy: string("heldBy"), reason: string("reason").flatMap(BrowserHeldReason.init(rawValue:)))
        case "action":
            return .action(decoded(BrowserAction.self, "action"))
        case "viewport":
            return decoded(BrowserViewport.self, "viewport").map(BrowserStreamEvent.viewport)
        case "closed":
            return .closed(string("reason").flatMap(BrowserClosedReason.init(rawValue:)))
        default:
            return nil
        }
    }

    /// The tab as it is after this event (a frame changes nothing of it).
    public func applied(to tab: BrowserTab) -> BrowserTab {
        switch self {
        case .tab(let fresh): return fresh
        case .url(let url, let site, let kind): return tab.with(url: url, site: site, kind: kind)
        case .title(let title): return tab.with(title: title)
        case .loading(let loading): return tab.with(loading: loading)
        case .status(let status): return tab.with(status: status)
        case .held(let heldBy, _): return tab.with(heldBy: .some(heldBy))
        case .action(let action): return tab.with(action: .some(action))
        case .viewport(let viewport): return tab.with(viewport: viewport)
        case .frame, .closed: return tab
        }
    }
}

/// Server-sent events from chunks of any size, for streams whose lines are long (a frame is a few hundred kilobytes of
/// base64 on one `data:` line): each byte is looked at once, a line is turned into text once it is whole. `event:` and
/// `data:` lines up to a blank line; comments (`: ping`) and other fields skipped; LF or CRLF.
public struct BrowserSSEParser: Sendable {
    private var partial = Data()
    private var event = ""
    private var data: [String] = []

    public init() {}

    public mutating func feed(_ chunk: Data) -> [(event: String, data: String)] {
        var out: [(event: String, data: String)] = []
        var start = chunk.startIndex
        while let newline = Self.newline(in: chunk, from: start) {
            partial.append(chunk[start..<newline])
            if partial.last == 0x0D { partial.removeLast() }
            if let message = take(String(decoding: partial, as: UTF8.self)) { out.append(message) }
            partial.removeAll(keepingCapacity: true)
            start = newline + 1
        }
        if start < chunk.endIndex { partial.append(chunk[start...]) }
        return out
    }

    /// The next LF at or after `from`, found with memchr.
    private static func newline(in chunk: Data, from: Data.Index) -> Data.Index? {
        guard from < chunk.endIndex else { return nil }
        return chunk.withUnsafeBytes { raw -> Data.Index? in
            guard let base = raw.baseAddress else { return nil }
            let offset = from - chunk.startIndex
            guard let hit = memchr(base + offset, 0x0A, raw.count - offset) else { return nil }
            return chunk.startIndex + (base.distance(to: UnsafeRawPointer(hit)))
        }
    }

    private mutating func take(_ line: String) -> (event: String, data: String)? {
        if line.isEmpty {
            defer { event = ""; data = [] }
            return data.isEmpty ? nil : (event.isEmpty ? "message" : event, data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        guard let colon = line.firstIndex(of: ":") else {
            if line == "data" { data.append("") }
            return nil
        }
        let field = line[..<colon]
        let rest = line[line.index(after: colon)...]
        let value = rest.hasPrefix(" ") ? rest.dropFirst() : rest
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}
