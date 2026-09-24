import Foundation

/// One dispatched server-sent event.
public struct SSEMessage: Sendable, Equatable {
    public let id: String?
    public let event: String
    public let data: String
    public let retry: Int?

    public init(id: String?, event: String, data: String, retry: Int? = nil) {
        self.id = id
        self.event = event
        self.data = data
        self.retry = retry
    }
}

/// Incremental parser for `text/event-stream` (WHATWG HTML §9.2.6): feed arbitrary byte chunks, get whole events.
/// Handles LF, CRLF and CR line ends (including a CRLF split across chunks), comments, multi-line `data`, the leading
/// BOM, and `id`/`retry`. An event cut off by the end of the stream is dropped, as the spec says.
public struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var afterCR = false
    private var atStart = true
    private var data = ""
    private var hasData = false
    private var eventType = ""
    private var lastEventId: String?
    private var retry: Int?

    public init() {}

    public mutating func feed<Bytes: Sequence>(_ bytes: Bytes) -> [SSEMessage] where Bytes.Element == UInt8 {
        var out: [SSEMessage] = []
        for byte in bytes {
            if afterCR {
                afterCR = false
                if byte == 0x0A { continue }
            }
            switch byte {
            case 0x0A: endLine(into: &out)
            case 0x0D: endLine(into: &out); afterCR = true
            default: line.append(byte)
            }
        }
        return out
    }

    /// The id of the last event seen (what a reconnect would send as Last-Event-ID).
    public var lastId: String? { lastEventId }

    private mutating func endLine(into out: inout [SSEMessage]) {
        var bytes = line
        line.removeAll(keepingCapacity: true)
        if atStart {
            atStart = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        if bytes.isEmpty { dispatch(into: &out); return }
        let text = String(decoding: bytes, as: UTF8.self)
        if text.hasPrefix(":") { return }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "data":
            data += value
            data += "\n"
            hasData = true
        case "event": eventType = String(value)
        case "id": if !value.contains("\u{0}") { lastEventId = String(value) }
        case "retry": if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }) { retry = Int(value) }
        default: break
        }
    }

    private mutating func dispatch(into out: inout [SSEMessage]) {
        defer {
            data = ""
            hasData = false
            eventType = ""
        }
        guard hasData else { return }
        if data.unicodeScalars.last == "\n" { data.unicodeScalars.removeLast() }
        out.append(SSEMessage(id: lastEventId, event: eventType.isEmpty ? "message" : eventType, data: data, retry: retry))
    }
}
