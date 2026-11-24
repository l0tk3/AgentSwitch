import Foundation

// A session's avatar (2026-11-24; the service's `rooms/avatars.ts`): two of them, one for each look — the pixel look
// draws the pixel one, the classic look the classic one — the same in every room it sits in, and kept by its
// conversation. Unchosen, the pixel one is the seat's face and the classic one its initials on the face's colour.

/// The pixel look's avatar: a 5 × 5 face (the library's `f…`, or one drawn), or a 16 × 16 character (`p…`).
public enum RoomPixelAvatar: Decodable, Sendable, Hashable {
    case face(id: String?, face: RoomFace)
    /// `palette`: colours as `rrggbb`; `rows`: sixteen strings, each character an index into the palette written in
    /// `0-9a-zA-Z`, `.` empty.
    case grid(id: String, palette: [String], rows: [String])

    private enum CodingKeys: String, CodingKey { case kind, id, rows, color, palette }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let id = (try? c.decodeIfPresent(String.self, forKey: .id)).flatMap { $0 }
        let rows = try c.decode([String].self, forKey: .rows)
        switch kind {
        case "face": self = .face(id: id, face: RoomFace(rows: rows, color: (try? c.decode(Int.self, forKey: .color)) ?? 0))
        case "grid": self = .grid(id: id ?? "", palette: (try? c.decode([String].self, forKey: .palette)) ?? [], rows: rows)
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown pixel avatar \(kind)")
        }
    }

    public var id: String? {
        switch self {
        case .face(let id, _): return id
        case .grid(let id, _, _): return id
        }
    }
}

/// The classic look's avatar: one emoji on a ground of one of the ten face colours.
public struct RoomClassicAvatar: Decodable, Sendable, Hashable {
    public let id: String?
    public let emoji: String
    public let bg: Int

    private enum CodingKeys: String, CodingKey { case kind, id, emoji, bg }

    public init(id: String? = nil, emoji: String, bg: Int = 0) {
        self.id = id
        self.emoji = emoji
        self.bg = bg
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard (try? c.decode(String.self, forKey: .kind)) ?? "emoji" == "emoji" else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown classic avatar")
        }
        id = (try? c.decodeIfPresent(String.self, forKey: .id)).flatMap { $0 }
        emoji = try c.decode(String.self, forKey: .emoji)
        bg = (try? c.decode(Int.self, forKey: .bg)) ?? 0
    }

    /// Its ground, as a face of that colour has it.
    public func rgb(dark: Bool) -> UInt32 { RoomFace(rows: [], color: bg).rgb(dark: dark) }
}

/// A session's two avatars; either nil: unchosen.
public struct RoomAvatar: Decodable, Sendable, Hashable {
    public let pixel: RoomPixelAvatar?
    public let classic: RoomClassicAvatar?

    private enum CodingKeys: String, CodingKey { case pixel, classic }

    public init(pixel: RoomPixelAvatar? = nil, classic: RoomClassicAvatar? = nil) {
        self.pixel = pixel
        self.classic = classic
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pixel = (try? c.decodeIfPresent(RoomPixelAvatar.self, forKey: .pixel)).flatMap { $0 }
        classic = (try? c.decodeIfPresent(RoomClassicAvatar.self, forKey: .classic)).flatMap { $0 }
    }

    /// The classic look's stand-in when none was chosen: the handle's first one or two letters, upper case
    /// (`ios` → `IO`, `a` → `A`).
    public static func initials(_ handle: String) -> String {
        let letters = handle.filter { $0.isLetter || $0.isNumber }
        return String((letters.isEmpty ? handle : letters).prefix(2)).uppercased()
    }
}

/// A 16 × 16 character's cells, by palette index.
public enum RoomGrid {
    /// The palette index a row's character stands for (`0-9a-zA-Z`); nil for `.` and anything else.
    public static func index(_ c: Character) -> Int? {
        guard let a = c.asciiValue else { return nil }
        switch a {
        case 48...57: return Int(a) - 48
        case 97...122: return Int(a) - 97 + 10
        case 65...90: return Int(a) - 65 + 36
        default: return nil
        }
    }

    /// `rrggbb` as a number; nil when it is not one.
    public static func rgb(_ hex: String) -> UInt32? {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard h.count == 6 else { return nil }
        return UInt32(h, radix: 16)
    }

    /// The filled cells: column, row and colour.
    public static func cells(palette: [String], rows: [String]) -> [(x: Int, y: Int, rgb: UInt32)] {
        let colours = palette.map { rgb($0) }
        return rows.prefix(16).enumerated().flatMap { y, row in
            row.prefix(16).enumerated().compactMap { x, c -> (x: Int, y: Int, rgb: UInt32)? in
                guard let i = index(c), i < colours.count, let rgb = colours[i] else { return nil }
                return (x, y, rgb)
            }
        }
    }
}

/// The avatar library (`GET /rooms/avatars`), for the picker.
public struct RoomAvatarLibrary: Decodable, Sendable, Hashable {
    public struct Face: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let rows: [String]
        public let color: Int
        public var face: RoomFace { RoomFace(rows: rows, color: color) }

        public init(id: String, rows: [String], color: Int) {
            self.id = id
            self.rows = rows
            self.color = color
        }
    }

    public struct Art: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let palette: [String]
        public let rows: [String]

        public init(id: String, palette: [String], rows: [String]) {
            self.id = id
            self.palette = palette
            self.rows = rows
        }
    }

    public struct Emoji: Decodable, Sendable, Hashable, Identifiable {
        public let id: String
        public let emoji: String

        public init(id: String, emoji: String) {
            self.id = id
            self.emoji = emoji
        }
    }

    public let faces: [Face]
    public let art: [Art]
    public let emoji: [Emoji]

    private enum CodingKeys: String, CodingKey { case faces, art, emoji }

    public init(faces: [Face] = [], art: [Art] = [], emoji: [Emoji] = []) {
        self.faces = faces
        self.art = art
        self.emoji = emoji
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        faces = (try? c.decode([Face].self, forKey: .faces)) ?? []
        art = (try? c.decode([Art].self, forKey: .art)) ?? []
        emoji = (try? c.decode([Emoji].self, forKey: .emoji)) ?? []
    }
}

/// A change to one look's avatar: a library id, or back to the seat's own (`reset`).
public enum RoomAvatarChoice: Sendable, Hashable {
    case id(String)
    /// The classic look: a library emoji with its ground.
    case emoji(id: String, bg: Int?)
    /// The classic look: an emoji of the session's own (not the library's), with its ground.
    case emojiText(String, bg: Int?)
    case reset
}

private struct AvatarBody: Encodable {
    let pixel: RoomAvatarChoice?
    let classic: RoomAvatarChoice?

    private enum CodingKeys: String, CodingKey { case pixel, classic }
    private struct IdBody: Encodable { let id: String; let bg: Int? }
    private struct EmojiBody: Encodable { let emoji: String; let bg: Int? }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try encode(pixel, &c, .pixel)
        try encode(classic, &c, .classic)
    }

    private func encode(_ choice: RoomAvatarChoice?, _ c: inout KeyedEncodingContainer<CodingKeys>, _ key: CodingKeys) throws {
        switch choice {
        case .id(let id): try c.encode(IdBody(id: id, bg: nil), forKey: key)
        case .emoji(let id, let bg): try c.encode(IdBody(id: id, bg: bg), forKey: key)
        case .emojiText(let emoji, let bg): try c.encode(EmojiBody(emoji: emoji, bg: bg), forKey: key)
        case .reset: try c.encodeNil(forKey: key)
        case nil: break
        }
    }
}

private struct AvatarReply: Decodable { let avatar: RoomAvatar? }

extension AgentSwitchAPI {
    /// The avatar library: faces and characters for the pixel look, emoji for the classic.
    public func roomAvatars() async throws -> RoomAvatarLibrary {
        try await get(["rooms", "avatars"])
    }

    /// A member's avatar set by the user: its session's, in every room. Only the looks named change.
    @discardableResult
    public func setAvatar(_ handle: String, in room: String, pixel: RoomAvatarChoice? = nil, classic: RoomAvatarChoice? = nil) async throws -> RoomAvatar {
        (try await send("PUT", ["rooms", room, "seats", handle, "avatar"], body: AvatarBody(pixel: pixel, classic: classic)) as AvatarReply).avatar ?? RoomAvatar()
    }
}
