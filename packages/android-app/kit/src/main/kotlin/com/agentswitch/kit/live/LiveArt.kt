package com.agentswitch.kit.live

/** A lit cell's place (Swift's `(x: Int, y: Int)` tuple). */
data class Point(val x: Int, val y: Int)

/**
 * The pixel shapes the Live Activity draws, here with no dependencies for the widget extension; the app's PixelArt
 * (AgentSwitchKit) takes them from here, so there is one copy (docs/ui-v0.md §7.3; the same shapes as
 * `packages/daemon/ui/pixel.js` and the Mac app's `PixelArt`).
 */
object LiveArt {
    /**
     * One source switched onto three lanes, as the app icon: S = source, a/b/c = lanes, A/B/C = their ends; the top
     * lane is the lit one. 14 × 11, y down.
     */
    val markRows: List<String> = listOf(
        "...........AAA",
        "......aaaaaAAA",
        ".....a.....AAA",
        "....a.........",
        "SSSa.......BBB",
        "SSSbbbbbbbbBBB",
        "SSSc.......BBB",
        "....c.........",
        ".....c.....CCC",
        "......cccccCCC",
        "...........CCC",
    )

    /** The lit lane from the source to its end, the way the busy block runs. */
    val laneA: List<Point> = listOf(Point(3, 4), Point(4, 3), Point(5, 2), Point(6, 1), Point(7, 1), Point(8, 1), Point(9, 1), Point(10, 1))

    /** Each agent's 5 × 5 mark, by harness. */
    val agents: Map<String, List<String>> = mapOf(
        "claude-code" to listOf("#.#.#", ".###.", "#####", ".###.", "#.#.#"),
        "codex" to listOf(".....", "#....", ".#...", "#.###", "....."),
        "opencode" to listOf("##.##", "#...#", "#...#", "#...#", "##.##"),
        "pi" to listOf("#####", ".#.#.", ".#.#.", ".#.#.", ".#..#"),
        "grok" to listOf(".##.#", "#..#.", "#.#.#", ".#..#", "#.##."),
    )

    /** A terminal row names its agent as the app shows it (ModelName.harness): the harness for that name. */
    fun harness(named: String): String? =
        mapOf("Claude Code" to "claude-code", "Codex" to "codex", "OpenCode" to "opencode", "pi" to "pi", "Grok" to "grok")[named]
}
