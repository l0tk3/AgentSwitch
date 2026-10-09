import Foundation

/// The pixel look's icons as small shaded objects (docs/ui-v0.md §9, 2026-10-04; user: 所有的像素图标有能力画的更精致一些吗
/// ……能不能弄成那种像素风格但是很精致的图标; shown a coloured set in the real window: 好出戏，能不能只用黑灰色强调层次感，就不上
/// 色了). Each is drawn on a board of at most 16 × 16 cells of 1.5 pt — cells one can see — in six tones of the one ink,
/// from highlight to ground, and nothing else: no hue. Depth comes from the tones: what is nearer or raised is lighter, a
/// raised block has a light edge above and left and a dark one below and right, a screen or a pane is a dark ground
/// inside an ink frame. The same pictures as docs/design/concepts/pixel-icons.html and the phone's `ShadedSprites`; keep
/// them in step.
public struct ShadedSprite: Equatable, Sendable {
    /// One character a cell: `.` is clear, anything else a tone of `ShadedSprite.tones`.
    public let rows: [String]

    public init(_ rows: [String]) { self.rows = rows }

    public var width: Int { rows.first?.count ?? 0 }
    public var height: Int { rows.count }

    /// The cells to fill, row by row, each with its tone's colour on a dark or a light ground.
    public func cells(dark: Bool) -> [(x: Int, y: Int, rgb: UInt32)] {
        rows.enumerated().flatMap { y, row in
            row.enumerated().compactMap { x, tone in
                tone == "." ? nil : ShadedSprite.color(tone, dark: dark).map { (x, y, $0) }
            }
        }
    }

    /// A cell of `points` on a screen of `scale`: a whole number of pixels, never more than asked and at least one, so
    /// its edges are never blurred. 1.5 pt — the icons' cell — is 3 pixels on a 2× screen, 1 on a 1× one.
    public static func cell(scale: Double, points: Double = 1.5) -> Double {
        let scale = max(1, scale)
        return max(1, (points * scale + 1e-6).rounded(.down)) / scale
    }

    // MARK: tones

    /// The ink's six tones, from highlight to ground — W # m d k s — on a dark ground; on a light one they run the
    /// other way, from the darkest ink to the paper's shade.
    static let tonesDark: [Character: UInt32] = ["W": 0xFFFFFF, "#": 0xE9E6DF, "m": 0xA9A6A0, "d": 0x6F6C68, "k": 0x3B3A37, "s": 0x1E1D1B]
    static let tonesLight: [Character: UInt32] = ["W": 0x000000, "#": 0x16140F, "m": 0x55524B, "d": 0x8A867D, "k": 0xBDB8AC, "s": 0xDCD7CB]

    /// A tone's colour; nil for a character that is no tone.
    public static func color(_ tone: Character, dark: Bool) -> UInt32? {
        (dark ? tonesDark : tonesLight)[tone]
    }

    // MARK: the set

    /// One source switched onto three lanes: the nearest lane and its end the lightest, each further one a tone darker.
    public static let dispatch = ShadedSprite([
        "............WWW#", ".........###W##m", ".......###..W##m", "......##....#mmd", ".....##.........", "....##..........",
        "WWW##.......mmmd", "W##mmmmmmmmmmddk", "W##mddddddddmddk", "#mmdd.......dkkk", "....dd..........", ".....dd.........",
        "......dd....dddk", ".......ddd..dkks", ".........ddddkks", "............ksss",
    ])
    /// The app's mark (docs/ui-v0.md §10): three windows one behind another, each further one a tone darker; the front
    /// one has a raised title bar — where a state shows — a dark screen, a bright prompt and a cursor.
    public static let stack = ShadedSprite([
        ".....dddddddddd.", "....dkkkkkkkkkkk", "....kssssssssssk", "...mmmmmmmmmmssk", "..mddddddddddksk", "..dssssssssssdsk",
        ".WWWWWWWWWWssdsk", "W##########msdk.", "#ssssssssssmsd..", "#sWWsssssssmsd..", "#sssWWsssssmd...", "#sWWssmmmssm....",
        "#ssssssssssm....", ".mmmmmmmmmm.....",
    ])
    /// A window: three dots on its title bar, a dark screen, a bright prompt, a cursor.
    public static let terminals = ShadedSprite([
        ".##############.", "#mkmkmkmmmmmmmm#", "################", "#ssssssssssssss#", "#sWWsssssssssss#", "#ssWWssssssssss#",
        "#sssWWsssssssss#", "#ssWWssssssssss#", "#sWWsssmmmmssss#", "#ssssssssssssss#", "#ssssssssssssss#", ".##############.",
    ])
    /// A globe: light land on a dark sea, a highlight at its top left, darker at its bottom right.
    public static let browser = ShadedSprite([
        ".....######.....", "...##mmmkkk##...", "..#mmmmmkkkkk#..", ".#Wmmmmkkkk#kk#.", ".#Wkmmkkkk#mmk#.", "#Wkkkmkkkmmmmmk#",
        "#Wkkkkkkkkmmmmk#", "#kkmmkkkkkkmmkk#", "#kmmmmkkkkkkmks#", "#kmmmmmkkkkkkss#", "#kkmmmmdkkkksss#", ".#kkmmmdkkksss#.",
        ".#kkkmdkkkssss#.", "..#kkkdkkssss#..", "...##kkksss##...", ".....######.....",
    ])
    /// Clash's page, on the Mac alone (so not in `all`, which the phone and the web share): a cat's face — its ears
    /// and brow lit from above and left, the face a dark ground, two bright eyes, the chin in shade.
    public static let clash = ShadedSprite([
        ".W............#.", ".W#..........#m.", ".Wk#........#km.", ".Wkk########kkm.", ".Wkkkkkkkkkkkkm.", "W#kkkkkkkkkkkkmd",
        "W#kWWkkkkkkWWkmd", "W#kW#kkkkkkW#kmd", "W#kkkkkkkkkkkkmd", "W#kkkkkmmkkkksmd", "##kkkkdkkdkkssmd", ".#kkkkkkkkksssd.",
        ".#mkkkkkkksssdd.", "..mmkkkkkssssd..", "...mmdddddddd...",
    ])
    /// Three sliders: the part each has travelled lighter, the rest dark, their knobs raised.
    public static let settings = ShadedSprite([
        "...WWW#.........", "mmmW##mkkkkkkkkk", "dddW##msssssssss", "...#mmd.........", "................", ".........WWW#...",
        "mmmmmmmmmW##mkkk", "dddddddddW##msss", ".........#mmd...", "................", ".....WWW#.......", "mmmmmW##mkkkkkkk",
        "dddddW##msssssss", ".....#mmd.......",
    ])
    /// A window with its sidebar: the sidebar a lighter panel with three rows, the rest a dark ground.
    public static let list = ShadedSprite([
        ".##############.", "#mmmmm#ssssssss#", "#mkkkm#ssssssss#", "#mmmmm#ssssssss#", "#mkkkm#ssssssss#", "#mmmmm#ssssssss#",
        "#mkkkm#ssssssss#", "#mmmmm#ssssssss#", "#ddddd#ssssssss#", "#ddddd#ssssssss#", ".##############.",
    ])
    /// Two panes side by side: the new one's head bright, its ground a tone lighter than the other's.
    public static let splitRight = ShadedSprite([
        ".##############.", "#dddddd##WWWWWW#", "#ssssss##mmmmmm#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#",
        "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", ".##############.",
    ])
    /// Two panes one over the other: the same.
    public static let splitDown = ShadedSprite([
        ".##############.", "#dddddddddddddd#", "#ssssssssssssss#", "#ssssssssssssss#", "#ssssssssssssss#", "################",
        "#WWWWWWWWWWWWWW#", "#mmmmmmmmmmmmmm#", "#kkkkkkkkkkkkkk#", "#kkkkkkkkkkkkkk#", ".##############.",
    ])
    /// A plus with some thickness.
    public static let new = ShadedSprite([
        ".....WWW#.....", ".....W##m.....", ".....W##m.....", ".....W##m.....", ".....W##m.....", "WWWWWW###WWWW#",
        "W############m", "W############m", "#mmmm####mmmmd", ".....W##m.....", ".....W##m.....", ".....W##m.....",
        ".....W##m.....", ".....#mmd.....",
    ])
    /// A lock: a raised body under a darker shackle, its keyhole dark.
    public static let lock = ShadedSprite([
        "...mmmmmm...", "..mm....md..", "..mm....md..", "..mm....md..", "..mm....md..", "WWWWWWWWWWW#", "W##########m",
        "W####kk####m", "W###kkkk###m", "W####kk####m", "W####kk####m", "W##########m", "#mmmmmmmmmmd",
    ])

    /// The lock where there is room for 10 pt only (an address's HTTPS, a field that seals): the same lock, smaller.
    public static let lockSmall = ShadedSprite([
        "..mmm..", ".m...d.", ".m...d.", "WWWWWW#", "W##k##m", "W##k##m", "W#####m", "#mmmmmd",
    ])

    /// Each agent's mark (its own logo's shape, 9 × 9): Claude Code's spark, its heart the lightest and its tips
    /// fading; Codex's `>_`, lit along its upper edges; OpenCode's brackets and pi's π as raised strokes.
    public static let agents: [String: ShadedSprite] = [
        "claude-code": ShadedSprite([
            "....d....", ".d..#..d.", "..#.#.#..", "...###...", "d###W###d", "...###...", "..#.#.#..", ".d..#..d.", "....d....",
        ]),
        "codex": ShadedSprite([
            ".........", ".........", "W#.......", ".W#......", "..W#.....", ".W#......", "W#...mmmm", ".....dddd", ".........",
        ]),
        "opencode": ShadedSprite([
            "W###.###m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "#mmm.mmmd",
        ]),
        "pi": ShadedSprite([
            "WWWWWWWW#", "#mmmmmmmd", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W##", "..#m..#mm",
        ]),
    ]

    /// Every picture by name, in the order the three copies list them (this file, the phone's, the web's
    /// `ui/lib/shaded.js`): what `digest` is taken over.
    public static let all: [(name: String, sprite: ShadedSprite)] = [
        ("dispatch", dispatch), ("terminals", terminals), ("browser", browser), ("settings", settings), ("list", list),
        ("splitRight", splitRight), ("splitDown", splitDown), ("new", new), ("lock", lock), ("lockSmall", lockSmall),
        ("claude-code", agents["claude-code"]!), ("codex", agents["codex"]!), ("opencode", agents["opencode"]!), ("pi", agents["pi"]!),
        ("stack", stack),
    ]

    /// A number that changes when any picture does (FNV-1a over the names and rows): the three copies' tests hold the
    /// same one, so a picture changed in one place fails there until the others follow.
    public static var digest: UInt32 {
        all.reduce(into: UInt32(2_166_136_261)) { hash, entry in
            for byte in "\(entry.name)=\(entry.sprite.rows.joined(separator: "/"));".utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        }
    }

    /// The shaded picture that stands for a 1-bit sprite in the pixel look, by its rows; nil for one that has none.
    public static func standing(for rows: [String]) -> ShadedSprite? {
        stands.first { $0.rows == rows }?.sprite
    }

    static let stands: [(rows: [String], sprite: ShadedSprite)] = [
        (PixelArt.railDispatch, dispatch), (PixelArt.railTerminals, terminals), (PixelArt.railBrowser, browser), (PixelArt.railClash, clash),
        (PixelArt.toolbarSettings, settings), (PixelArt.toolbarList, list), (PixelArt.toolbarSplitRight, splitRight),
        (PixelArt.toolbarSplitDown, splitDown), (PixelArt.toolbarNew, new), (PixelArt.lock, lock),
    ] + PixelArt.agents.keys.sorted().compactMap { harness in agents[harness].map { (PixelArt.agents[harness]!, $0) } }
}

/// The app's mark as a shaded picture with a state (docs/ui-v0.md §10): `ShadedSprite.stack`, and where a state shows
/// on it — the front window's title bar is the light: the state's colour (cyan busy, amber waiting, red error), a
/// light block running along it while busy, every other cell gone when off.
public enum ShadedMark {
    public static let picture = ShadedSprite.stack

    /// The front window's title bar from left to right, a block of two by two cells a step: the way the busy block runs.
    public static let lane: [[(x: Int, y: Int)]] = [
        [(1, 6), (2, 6), (1, 7), (2, 7)], [(3, 6), (4, 6), (3, 7), (4, 7)], [(5, 6), (6, 6), (5, 7), (6, 7)],
        [(7, 6), (8, 6), (7, 7), (8, 7)], [(9, 6), (10, 6), (9, 7), (10, 7)],
    ]

    /// The front window's title bar: the raised strip a state colours.
    public static func isEnd(x: Int, y: Int) -> Bool { (y == 6 && (1...10).contains(x)) || (y == 7 && x <= 11) }

    /// How a cell of that block sits once it carries a state's colour: its light edge, its face, its dark edge.
    public enum Edge: Sendable, Equatable { case light, face, dark }
    public static func edge(of tone: Character) -> Edge {
        switch tone {
        case "W": return .light
        case "#": return .face
        default: return .dark
        }
    }

    /// Off: every other cell, a checkerboard.
    public static func dithered(x: Int, y: Int) -> Bool { (x + y) % 2 == 1 }
}
