import Foundation

// What the terminal window's native screen reads from the service and sends back (docs/terminal-v0.md §1 Mac): the
// stream of one terminal, the user's iTerm look, and the routes that type, name keys, resize and redraw.

/// One event of `GET /terminals/:id/stream` the screen acts on.
public enum TerminalStreamEvent: Equatable, Sendable {
    /// The screen as the service has it (serialized, with its scrollback), at the size it had.
    case snapshot(seq: Int, cols: Int, rows: Int, data: String)
    case output(seq: Int, data: String)
    /// The size, and the screen that owns it (docs/terminal-v0.md §1 "尺寸有主"): this one, another, or nil when none
    /// does (its owner left). Sent on every connect too.
    case resize(cols: Int, rows: Int, by: String?)
    case status(String)
    case exit(code: Int?)
    /// The terminal was deleted.
    case removed

    /// The event from its SSE name and JSON data; nil for one the screen does not need (a permission request is the
    /// page's, a name the toolbar's).
    public static func decode(event: String, data: String) -> TerminalStreamEvent? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { return nil }
        let int = { (key: String) in (object[key] as? NSNumber)?.intValue }
        switch event {
        case "snapshot":
            guard let seq = int("seq"), let cols = int("cols"), let rows = int("rows"), let text = object["data"] as? String else { return nil }
            return .snapshot(seq: seq, cols: cols, rows: rows, data: text)
        case "output":
            guard let seq = int("seq"), let text = object["data"] as? String else { return nil }
            return .output(seq: seq, data: text)
        case "resize":
            guard let cols = int("cols"), let rows = int("rows") else { return nil }
            return .resize(cols: cols, rows: rows, by: object["by"] as? String)
        case "status":
            return (object["status"] as? String).map(TerminalStreamEvent.status)
        case "exit":
            return .exit(code: int("code"))
        case "removed":
            return .removed
        default:
            return nil
        }
    }
}

/// Server-sent events from bytes as they arrive: `event:` and `data:` lines up to a blank line; comments (`: ping`)
/// and other fields are skipped; a line may end in LF or CRLF and may arrive in pieces.
public struct SSEParser: Sendable {
    private var pending: [UInt8] = []
    private var event = ""
    private var data: [String] = []

    public init() {}

    public mutating func feed(_ bytes: some Sequence<UInt8>) -> [(event: String, data: String)] {
        var out: [(event: String, data: String)] = []
        for byte in bytes {
            guard byte == 0x0A else { pending.append(byte); continue }
            if pending.last == 0x0D { pending.removeLast() }
            let line = String(decoding: pending, as: UTF8.self)
            pending.removeAll(keepingCapacity: true)
            if let message = take(line) { out.append(message) }
        }
        return out
    }

    private mutating func take(_ line: String) -> (event: String, data: String)? {
        if line.isEmpty {
            defer { event = ""; data = [] }
            return data.isEmpty ? nil : (event.isEmpty ? "message" : event, data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring, value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            let rest = line[line.index(after: colon)...]
            value = rest.hasPrefix(" ") ? rest.dropFirst() : rest
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}

/// `GET /terminals/style`: the user's iTerm profile (else a default), as the screens draw it.
public struct TerminalStyle: Decodable, Equatable, Sendable {
    public struct Theme: Decodable, Equatable, Sendable {
        public let background: String?
        public let foreground: String?
        public let cursor: String?
        public let selectionBackground: String?
        public let black, red, green, yellow, blue, magenta, cyan, white: String?
        public let brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite: String?

        /// The 16 ANSI colours in order, when all are given.
        public var ansi: [String]? {
            let all = [black, red, green, yellow, blue, magenta, cyan, white,
                       brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite]
            let given = all.compactMap { $0 }
            return given.count == 16 ? given : nil
        }
    }

    /// A CSS font stack: `"MesloLGS NF", "SF Mono", Menlo, monospace`.
    public let fontFamily: String
    public let fontSize: Double
    public let theme: Theme

    public static let fallback = TerminalStyle(fontFamily: "\"SF Mono\", Menlo, monospace", fontSize: 13, theme: Theme(
        background: "#000000", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "rgba(109,139,255,0.35)",
        black: nil, red: nil, green: nil, yellow: nil, blue: nil, magenta: nil, cyan: nil, white: nil,
        brightBlack: nil, brightRed: nil, brightGreen: nil, brightYellow: nil, brightBlue: nil, brightMagenta: nil, brightCyan: nil, brightWhite: nil))

    public init(fontFamily: String, fontSize: Double, theme: Theme) {
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.theme = theme
    }

    /// The families of the stack, quotes gone, in order (`ui-monospace` and `monospace` are the system's).
    public var families: [String] {
        fontFamily.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'")) }
            .filter { !$0.isEmpty }
    }

    /// `#rrggbb` or `rgba(r,g,b,a)` as components from 0 to 1.
    public static func rgba(_ text: String) -> (red: Double, green: Double, blue: Double, alpha: Double)? {
        let s = text.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#"), s.count == 7, let v = UInt32(s.dropFirst(), radix: 16) {
            return (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255, 1)
        }
        if s.hasPrefix("rgb"), let open = s.firstIndex(of: "("), let close = s.lastIndex(of: ")") {
            let parts = s[s.index(after: open)..<close].split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count >= 3 else { return nil }
            return (parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.count > 3 ? parts[3] : 1)
        }
        return nil
    }
}

extension DaemonClient {
    /// `GET /terminals/:id/stream` (from `after`: only the output missed since then), with the local token. `screen`:
    /// this screen's id — the size it owns goes back when this stream ends.
    public func terminalStreamRequest(id: String, after: Int? = nil, screen: String? = nil) -> URLRequest {
        let query = [after.map { "after=\($0)" }, screen.map { "screen=\(Self.segment($0))" }].compactMap { $0 }
        var request = request("GET", "/terminals/\(Self.segment(id))/stream" + (query.isEmpty ? "" : "?" + query.joined(separator: "&")))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 60 * 60 * 24
        return request
    }

    public func terminalStyle() async throws -> TerminalStyle {
        try decode(TerminalStyle.self, try await call("GET", "/terminals/style"))
    }

    /// What the screen types: keys, text from an input method, a paste, mouse reports, the terminal's replies.
    public func writeTerminal(id: String, data: String) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/write", body: try JSONEncoder().encode(["data": data]))
    }

    /// Named keys the service encodes as the program asked (Shift+Enter).
    public func terminalKeys(id: String, _ keys: [String]) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/keys", body: try JSONEncoder().encode(["keys": keys]))
    }

    /// `screen`: the screen that takes the size (it owns it from now on).
    public func resizeTerminal(id: String, cols: Int, rows: Int, screen: String? = nil) async throws {
        struct Body: Encodable { let cols: Int; let rows: Int; let screen: String? }
        _ = try await call("POST", "/terminals/\(Self.segment(id))/resize", body: try JSONEncoder().encode(Body(cols: cols, rows: rows, screen: screen)))
    }

    /// A screen that just attached asks the agent to draw again (what a snapshot cannot carry, such as links).
    public func redrawTerminal(id: String) async throws {
        _ = try await call("POST", "/terminals/\(Self.segment(id))/redraw", body: Data("{}".utf8))
    }
}
