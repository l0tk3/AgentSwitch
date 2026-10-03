import Foundation

// What the Mac's screen sends a tab (`POST /browser/tabs/:id/input`, docs/browser-v0.md §5): mouse, wheel, text and
// named keys, points in the pixels of the frame they were made on (`seq`). Sent in order through one queue, with the
// pointer's moves and the wheel coalesced while a request is under way, so a trackpad never runs ahead of the page.

/// The modifier names the daemon takes (`Alt` `Control` `Meta` `Shift`).
public struct BrowserModifiers: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let shift = BrowserModifiers(rawValue: 1)
    public static let control = BrowserModifiers(rawValue: 2)
    public static let option = BrowserModifiers(rawValue: 4)
    public static let command = BrowserModifiers(rawValue: 8)

    /// As the daemon names them, in its order.
    public var names: [String] {
        var out: [String] = []
        if contains(.option) { out.append("Alt") }
        if contains(.control) { out.append("Control") }
        if contains(.command) { out.append("Meta") }
        if contains(.shift) { out.append("Shift") }
        return out
    }
}

public enum BrowserMouseButton: String, Sendable, Equatable, Encodable {
    case left, right, middle
}

public enum BrowserMouseAction: String, Sendable, Equatable, Encodable {
    case move, down, up, click
}

/// One input event, encoded as the daemon's schema has it.
public enum BrowserInputEvent: Sendable, Equatable, Encodable {
    case mouse(BrowserMouseAction, x: Double, y: Double, button: BrowserMouseButton = .left, clickCount: Int = 1,
               modifiers: BrowserModifiers = [], seq: Int? = nil)
    case wheel(x: Double, y: Double, deltaX: Double, deltaY: Double, modifiers: BrowserModifiers = [], seq: Int? = nil)
    case text(String)
    case key(String, modifiers: BrowserModifiers = [])

    /// The daemon's limit on one text event (UTF-16 units, as JavaScript counts) and on events per request.
    public static let maxText = 10_000
    public static let maxEvents = 50

    private enum Key: String, CodingKey { case type, action, x, y, button, clickCount, modifiers, seq, deltaX, deltaY, text, key }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .mouse(let action, let x, let y, let button, let clickCount, let modifiers, let seq):
            try c.encode("mouse", forKey: .type)
            try c.encode(action, forKey: .action)
            try c.encode(x, forKey: .x)
            try c.encode(y, forKey: .y)
            try c.encode(button, forKey: .button)
            try c.encode(min(max(clickCount, 1), 3), forKey: .clickCount)
            try c.encode(modifiers.names, forKey: .modifiers)
            try c.encodeIfPresent(seq, forKey: .seq)
        case .wheel(let x, let y, let deltaX, let deltaY, let modifiers, let seq):
            try c.encode("wheel", forKey: .type)
            try c.encode(x, forKey: .x)
            try c.encode(y, forKey: .y)
            try c.encode(deltaX, forKey: .deltaX)
            try c.encode(deltaY, forKey: .deltaY)
            try c.encode(modifiers.names, forKey: .modifiers)
            try c.encodeIfPresent(seq, forKey: .seq)
        case .text(let text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case .key(let key, let modifiers):
            try c.encode("key", forKey: .type)
            try c.encode(key, forKey: .key)
            try c.encode(modifiers.names, forKey: .modifiers)
        }
    }

    /// Text as events the daemon takes: pieces of at most `maxText` UTF-16 units, never splitting a character; nothing
    /// for empty text.
    public static func texts(_ text: String, limit: Int = maxText) -> [BrowserInputEvent] {
        var out: [BrowserInputEvent] = []
        var piece = ""
        var units = 0
        for character in text {
            let n = character.utf16.count
            if units + n > limit, !piece.isEmpty {
                out.append(.text(piece))
                piece = ""
                units = 0
            }
            piece.append(character)
            units += n
        }
        if !piece.isEmpty { out.append(.text(piece)) }
        return out
    }

    /// A move of the pointer or the wheel: what may be coalesced and held back a little.
    public var isMotion: Bool {
        switch self {
        case .mouse(.move, _, _, _, _, _, _), .wheel: return true
        default: return false
        }
    }
}

/// The screen's events waiting to be sent, in order. A move right after a move replaces it (only where the pointer is
/// now matters); a wheel right after a wheel with the same modifiers adds up, at the newer place. Anything else keeps
/// its place, so a click is never moved past the moves before it.
public struct BrowserInputQueue: Sendable, Equatable {
    public private(set) var events: [BrowserInputEvent] = []

    public init() {}

    public var isEmpty: Bool { events.isEmpty }

    /// Nothing but moves and the wheel: these may wait for the motion interval.
    public var onlyMotion: Bool { !events.isEmpty && events.allSatisfy(\.isMotion) }

    public mutating func append(_ event: BrowserInputEvent) {
        if let last = events.last {
            switch (last, event) {
            case (.mouse(.move, _, _, _, _, _, _), .mouse(.move, _, _, _, _, _, _)):
                events[events.count - 1] = event
                return
            case (.wheel(_, _, let dx0, let dy0, let mods0, _), .wheel(let x, let y, let dx, let dy, let mods, let seq)) where mods0 == mods:
                events[events.count - 1] = .wheel(x: x, y: y, deltaX: dx0 + dx, deltaY: dy0 + dy, modifiers: mods, seq: seq)
                return
            default:
                break
            }
        }
        events.append(event)
    }

    /// The next request's events, oldest first: at most `limit`.
    public mutating func take(limit: Int = BrowserInputEvent.maxEvents) -> [BrowserInputEvent] {
        let batch = Array(events.prefix(limit))
        events.removeFirst(batch.count)
        return batch
    }

    public mutating func removeAll() { events.removeAll() }
}

// MARK: - keys

/// What a key press on the screen does (docs/browser-v0.md §5 input): a named key or a shortcut letter sent as a key; the
/// clipboard's commands kept on the Mac (paste types the Mac's clipboard as text; copy and cut are not offered — the
/// daemon leaves them out so a phone never reaches the Mac's clipboard); typed characters left to the text input system
/// (an input method composes, then commits text); the app's and the system's own keys left alone.
public enum BrowserKeyAction: Sendable, Equatable {
    case key(String, BrowserModifiers)
    case paste
    case copy
    case cut
    /// Characters: to the text input system (`interpretKeyEvents`), which commits them as text.
    case text
    /// Not the page's: the app or the system (⌘Q, ⌘H, ⌘M, ⌘W, function keys, ⌘ with a non-letter).
    case ignore
}

public enum BrowserKeys {
    /// macOS virtual key codes of the keys the daemon names.
    public static let named: [UInt16: String] = [
        53: "Escape", 48: "Tab", 36: "Enter", 76: "Enter", 51: "Backspace", 117: "Delete",
        123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
        115: "Home", 119: "End", 116: "PageUp", 121: "PageDown",
    ]
    /// ⌘ letters the system or the app answers (quit, hide, minimise, close the window), never the page's.
    static let systemLetters: Set<String> = ["q", "h", "m", "w"]
    /// The letters the daemon names as keys (`a`–`z`, for shortcuts).
    static let letters: Set<String> = Set("abcdefghijklmnopqrstuvwxyz".map(String.init))

    /// `characters`: the key's characters without modifiers (`charactersIgnoringModifiers`).
    public static func action(keyCode: UInt16, characters: String?, modifiers: BrowserModifiers) -> BrowserKeyAction {
        if let name = named[keyCode] { return .key(name, modifiers) }
        let letter = characters?.lowercased() ?? ""
        let isLetter = letter.count == 1 && letters.contains(letter)
        if modifiers.contains(.command) {
            guard isLetter, !modifiers.contains(.control) else { return .ignore }
            if !modifiers.contains(.option) {
                // ⇧⌘V (paste as plain text elsewhere) pastes too: the page only ever gets plain text.
                switch (letter, modifiers.contains(.shift)) {
                case ("v", _): return .paste
                case ("c", false): return .copy
                case ("x", false): return .cut
                default: break
                }
            }
            if systemLetters.contains(letter) { return .ignore }
            return .key(letter, modifiers)
        }
        if modifiers.contains(.control) {
            return isLetter ? .key(letter, modifiers) : .ignore
        }
        return .text
    }

    /// A text editing command the text input system asks for when it does not take a key itself (an input method
    /// passing on Return or Delete), as the key it stands for; nil for one the page has no key for.
    public static func key(forCommand selector: String) -> BrowserInputEvent? {
        let map: [String: (String, BrowserModifiers)] = [
            "insertNewline:": ("Enter", []), "insertLineBreak:": ("Enter", []), "insertTab:": ("Tab", []),
            "insertBacktab:": ("Tab", .shift), "deleteBackward:": ("Backspace", []), "deleteForward:": ("Delete", []),
            "cancelOperation:": ("Escape", []), "moveLeft:": ("ArrowLeft", []), "moveRight:": ("ArrowRight", []),
            "moveUp:": ("ArrowUp", []), "moveDown:": ("ArrowDown", []),
            "scrollPageUp:": ("PageUp", []), "scrollPageDown:": ("PageDown", []), "pageUp:": ("PageUp", []), "pageDown:": ("PageDown", []),
            "moveToBeginningOfDocument:": ("Home", []), "moveToEndOfDocument:": ("End", []),
            "scrollToBeginningOfDocument:": ("Home", []), "scrollToEndOfDocument:": ("End", []),
        ]
        return map[selector].map { BrowserInputEvent.key($0.0, modifiers: $0.1) }
    }

    /// Pasted text longer than this is not typed in (UTF-16 units: ten requests' worth).
    public static let pasteLimit = 100_000
}
