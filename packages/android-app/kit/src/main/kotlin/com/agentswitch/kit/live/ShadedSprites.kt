package com.agentswitch.kit.live

/** A cell to fill: its place and its tone's colour (24-bit RGB in an `Int`). */
data class ShadedCell(val x: Int, val y: Int, val rgb: Int)

/**
 * The pixel look's icons as small shaded objects (docs/ui-v0.md §9, 2026-10-04; user: 所有的像素图标有能力画的更精致一些吗
 * ……能不能弄成那种像素风格但是很精致的图标; shown a coloured set in the real window: 好出戏，能不能只用黑灰色强调层次感，就不上
 * 色了). Each is drawn on a board of at most 16 × 16 cells of 1.5 pt — cells one can see — in six tones of the one ink,
 * from highlight to ground, and nothing else: no hue. Depth comes from the tones: what is nearer or raised is lighter, a
 * raised block has a light edge above and left and a dark one below and right, a screen or a pane is a dark ground
 * inside an ink frame. The same pictures as docs/design/concepts/pixel-icons.html and the Mac's `ShadedSprites`; keep
 * them in step. Here, with no dependencies, for the Live Activity's widget extension as well as the app.
 */
data class ShadedSprite(
    /** One character a cell: `.` is clear, anything else a tone of `ShadedSprite.tones`. */
    val rows: List<String>,
) {
    val width: Int get() = rows.firstOrNull()?.length ?: 0
    val height: Int get() = rows.size

    /** The cells to fill, row by row, each with its tone's colour on a dark or a light ground. */
    fun cells(dark: Boolean): List<ShadedCell> =
        rows.flatMapIndexed { y, row ->
            row.mapIndexedNotNull { x, tone ->
                if (tone == '.') null else color(tone, dark)?.let { ShadedCell(x, y, it) }
            }
        }

    companion object {
        /**
         * A cell of `points` on a screen of `scale`: a whole number of pixels, never more than asked and at least one, so
         * its edges are never blurred. 1.5 pt — the icons' cell — is 3 pixels on a 2× screen, 1 on a 1× one.
         */
        fun cell(scale: Double, points: Double = 1.5): Double {
            val s = maxOf(1.0, scale)
            return maxOf(1.0, Math.floor(points * s + 1e-6)) / s
        }

        // MARK: tones

        /**
         * The ink's six tones, from highlight to ground — W # m d k s — on a dark ground; on a light one they run the
         * other way, from the darkest ink to the paper's shade.
         */
        internal val tonesDark: Map<Char, Int> = mapOf('W' to 0xFFFFFF, '#' to 0xE9E6DF, 'm' to 0xA9A6A0, 'd' to 0x6F6C68, 'k' to 0x3B3A37, 's' to 0x1E1D1B)
        internal val tonesLight: Map<Char, Int> = mapOf('W' to 0x000000, '#' to 0x16140F, 'm' to 0x55524B, 'd' to 0x8A867D, 'k' to 0xBDB8AC, 's' to 0xDCD7CB)

        /** A tone's colour; null for a character that is no tone. */
        fun color(tone: Char, dark: Boolean): Int? = (if (dark) tonesDark else tonesLight)[tone]

        // MARK: the set

        /** One source switched onto three lanes: the nearest lane and its end the lightest, each further one a tone darker. */
        val dispatch = ShadedSprite(listOf(
            "............WWW#", ".........###W##m", ".......###..W##m", "......##....#mmd", ".....##.........", "....##..........",
            "WWW##.......mmmd", "W##mmmmmmmmmmddk", "W##mddddddddmddk", "#mmdd.......dkkk", "....dd..........", ".....dd.........",
            "......dd....dddk", ".......ddd..dkks", ".........ddddkks", "............ksss",
        ))
        /**
         * The app's mark (docs/ui-v0.md §10): three windows one behind another, each further one a tone darker; the front
         * one has a raised title bar — where a state shows — a dark screen, a bright prompt and a cursor.
         */
        val stack = ShadedSprite(listOf(
            ".....dddddddddd.", "....dkkkkkkkkkkk", "....kssssssssssk", "...mmmmmmmmmmssk", "..mddddddddddksk", "..dssssssssssdsk",
            ".WWWWWWWWWWssdsk", "W##########msdk.", "#ssssssssssmsd..", "#sWWsssssssmsd..", "#sssWWsssssmd...", "#sWWssmmmssm....",
            "#ssssssssssm....", ".mmmmmmmmmm.....",
        ))
        /** A window: three dots on its title bar, a dark screen, a bright prompt, a cursor. */
        val terminals = ShadedSprite(listOf(
            ".##############.", "#mkmkmkmmmmmmmm#", "################", "#ssssssssssssss#", "#sWWsssssssssss#", "#ssWWssssssssss#",
            "#sssWWsssssssss#", "#ssWWssssssssss#", "#sWWsssmmmmssss#", "#ssssssssssssss#", "#ssssssssssssss#", ".##############.",
        ))
        /** A globe: light land on a dark sea, a highlight at its top left, darker at its bottom right. */
        val browser = ShadedSprite(listOf(
            ".....######.....", "...##mmmkkk##...", "..#mmmmmkkkkk#..", ".#Wmmmmkkkk#kk#.", ".#Wkmmkkkk#mmk#.", "#Wkkkmkkkmmmmmk#",
            "#Wkkkkkkkkmmmmk#", "#kkmmkkkkkkmmkk#", "#kmmmmkkkkkkmks#", "#kmmmmmkkkkkkss#", "#kkmmmmdkkkksss#", ".#kkmmmdkkksss#.",
            ".#kkkmdkkkssss#.", "..#kkkdkkssss#..", "...##kkksss##...", ".....######.....",
        ))
        /** Three sliders: the part each has travelled lighter, the rest dark, their knobs raised. */
        val settings = ShadedSprite(listOf(
            "...WWW#.........", "mmmW##mkkkkkkkkk", "dddW##msssssssss", "...#mmd.........", "................", ".........WWW#...",
            "mmmmmmmmmW##mkkk", "dddddddddW##msss", ".........#mmd...", "................", ".....WWW#.......", "mmmmmW##mkkkkkkk",
            "dddddW##msssssss", ".....#mmd.......",
        ))
        /** A window with its sidebar: the sidebar a lighter panel with three rows, the rest a dark ground. */
        val list = ShadedSprite(listOf(
            ".##############.", "#mmmmm#ssssssss#", "#mkkkm#ssssssss#", "#mmmmm#ssssssss#", "#mkkkm#ssssssss#", "#mmmmm#ssssssss#",
            "#mkkkm#ssssssss#", "#mmmmm#ssssssss#", "#ddddd#ssssssss#", "#ddddd#ssssssss#", ".##############.",
        ))
        /** Two panes side by side: the new one's head bright, its ground a tone lighter than the other's. */
        val splitRight = ShadedSprite(listOf(
            ".##############.", "#dddddd##WWWWWW#", "#ssssss##mmmmmm#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#",
            "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", "#ssssss##kkkkkk#", ".##############.",
        ))
        /** Two panes one over the other: the same. */
        val splitDown = ShadedSprite(listOf(
            ".##############.", "#dddddddddddddd#", "#ssssssssssssss#", "#ssssssssssssss#", "#ssssssssssssss#", "################",
            "#WWWWWWWWWWWWWW#", "#mmmmmmmmmmmmmm#", "#kkkkkkkkkkkkkk#", "#kkkkkkkkkkkkkk#", ".##############.",
        ))
        /** A plus with some thickness. */
        val new = ShadedSprite(listOf(
            ".....WWW#.....", ".....W##m.....", ".....W##m.....", ".....W##m.....", ".....W##m.....", "WWWWWW###WWWW#",
            "W############m", "W############m", "#mmmm####mmmmd", ".....W##m.....", ".....W##m.....", ".....W##m.....",
            ".....W##m.....", ".....#mmd.....",
        ))
        /** A lock: a raised body under a darker shackle, its keyhole dark. */
        val lock = ShadedSprite(listOf(
            "...mmmmmm...", "..mm....md..", "..mm....md..", "..mm....md..", "..mm....md..", "WWWWWWWWWWW#", "W##########m",
            "W####kk####m", "W###kkkk###m", "W####kk####m", "W####kk####m", "W##########m", "#mmmmmmmmmmd",
        ))

        /** The lock where there is room for 10 pt only (an address's HTTPS, a field that seals): the same lock, smaller. */
        val lockSmall = ShadedSprite(listOf(
            "..mmm..", ".m...d.", ".m...d.", "WWWWWW#", "W##k##m", "W##k##m", "W#####m", "#mmmmmd",
        ))

        /**
         * Each agent's mark (its own logo's shape, 9 × 9): Claude Code's spark, its heart the lightest and its tips
         * fading; Codex's `>_`, lit along its upper edges; OpenCode's brackets and pi's π as raised strokes; Grok's ring,
         * lit on its upper left, with the stroke that runs out of it to the upper right.
         */
        val agents: Map<String, ShadedSprite> = mapOf(
            "claude-code" to ShadedSprite(listOf(
                "....d....", ".d..#..d.", "..#.#.#..", "...###...", "d###W###d", "...###...", "..#.#.#..", ".d..#..d.", "....d....",
            )),
            "codex" to ShadedSprite(listOf(
                ".........", ".........", "W#.......", ".W#......", "..W#.....", ".W#......", "W#...mmmm", ".....dddd", ".........",
            )),
            "opencode" to ShadedSprite(listOf(
                "W###.###m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "W#.....#m", "#mmm.mmmd",
            )),
            "pi" to ShadedSprite(listOf(
                "WWWWWWWW#", "#mmmmmmmd", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W#.", "..W#..W##", "..#m..#mm",
            )),
            "grok" to ShadedSprite(listOf(
                "........W", "...WW#.W.", "..W#..W..", ".W#..W.m.", ".W#.W..m.", ".W#....m.", "..#m..m..", ".#.mmd...", "#........",
            )),
        )

        /**
         * Every picture by name, in the order the three copies list them (this file, the Mac's, the web's
         * `ui/lib/shaded.js`): what `digest` is taken over.
         */
        val all: List<Pair<String, ShadedSprite>> = listOf(
            "dispatch" to dispatch, "terminals" to terminals, "browser" to browser, "settings" to settings, "list" to list,
            "splitRight" to splitRight, "splitDown" to splitDown, "new" to new, "lock" to lock, "lockSmall" to lockSmall,
            "claude-code" to agents.getValue("claude-code"), "codex" to agents.getValue("codex"), "opencode" to agents.getValue("opencode"),
            "pi" to agents.getValue("pi"), "grok" to agents.getValue("grok"), "stack" to stack,
        )

        /**
         * A number that changes when any picture does (FNV-1a, 32 bit unsigned, over the names and rows, returned in a
         * `Long`): the copies' tests hold the same one, so a picture changed in one place fails there until the others follow.
         */
        val digest: Long
            get() {
                var hash = 2_166_136_261L.toInt()
                for ((name, sprite) in all) {
                    for (byte in "$name=${sprite.rows.joinToString("/")};".toByteArray(Charsets.UTF_8)) {
                        hash = (hash xor (byte.toInt() and 0xFF)) * 16_777_619
                    }
                }
                return hash.toLong() and 0xFFFFFFFFL
            }
    }
}

/**
 * The app's mark as a shaded picture with a state (docs/ui-v0.md §10): `ShadedSprite.stack`, and where a state shows
 * on it — the front window's title bar is the light: the state's colour (cyan busy, amber waiting, red error), a
 * light block running along it while busy, every other cell gone when off.
 */
object ShadedMark {
    val picture: ShadedSprite = ShadedSprite.stack

    /** The front window's title bar from left to right, a block of two by two cells a step: the way the busy block runs. */
    val lane: List<List<Point>> = listOf(
        listOf(Point(1, 6), Point(2, 6), Point(1, 7), Point(2, 7)), listOf(Point(3, 6), Point(4, 6), Point(3, 7), Point(4, 7)),
        listOf(Point(5, 6), Point(6, 6), Point(5, 7), Point(6, 7)), listOf(Point(7, 6), Point(8, 6), Point(7, 7), Point(8, 7)),
        listOf(Point(9, 6), Point(10, 6), Point(9, 7), Point(10, 7)),
    )

    /** The front window's title bar: the raised strip a state colours. */
    fun isEnd(x: Int, y: Int): Boolean = (y == 6 && x in 1..10) || (y == 7 && x <= 11)

    /** How a cell of that block sits once it carries a state's colour: its light edge, its face, its dark edge. */
    enum class Edge { Light, Face, Dark }

    fun edge(tone: Char): Edge = when (tone) {
        'W' -> Edge.Light
        '#' -> Edge.Face
        else -> Edge.Dark
    }

    /** Off: every other cell, a checkerboard. */
    fun dithered(x: Int, y: Int): Boolean = (x + y) % 2 == 1
}
